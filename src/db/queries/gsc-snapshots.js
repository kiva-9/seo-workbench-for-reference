// gsc-snapshots.js —— GSC 全量快照（16 个月窗口，URL + URL-query 双层，每个项目滚动保留 3 个）

const { now } = require('../helpers');

module.exports = (db) => ({
  // 全部项目的快照总览：每个项目一行，带最新快照的元信息（没有快照则为 NULL）。
  // 一眼看出哪些项目还没快照、哪些该刷了。
  getGscSnapshotOverview: async ({ ownerUserId, isAdmin } = {}) => db.prepare(
    `SELECT p.id AS project_id, p.name, p.status, p.gsc_site,
            p.gsc_account_id, p.ga4_account_id, p.account_id,
            (SELECT COUNT(*) FROM urls u WHERE u.project_id = p.id) AS url_count,
            s.id AS snapshot_id, s.snapshot_date, s.start_date, s.end_date,
            (SELECT COUNT(*) FROM gsc_snapshot_urls su WHERE su.snapshot_id = s.id) AS snap_urls,
            (SELECT COUNT(*) FROM gsc_snapshot_queries sq WHERE sq.snapshot_id = s.id) AS snap_queries
       FROM projects p
       LEFT JOIN gsc_snapshots s
         ON s.id = (SELECT id FROM gsc_snapshots WHERE project_id = p.id
                     ORDER BY created_at DESC, id DESC LIMIT 1)
      WHERE @isAdmin = 1 OR p.owner_user_id = @uid
         OR p.id IN (SELECT project_id FROM project_copywriters WHERE user_id = @uid AND revoked_at IS NULL)
      ORDER BY (s.id IS NULL) ASC, s.snapshot_date DESC, p.created_at DESC`
  ).all({ uid: ownerUserId ?? null, isAdmin: isAdmin ? 1 : 0 }),

  // 取最新一个快照（没有就返回 undefined）
  getLatestGscSnapshot: async (projectId) => db.prepare(
    'SELECT * FROM gsc_snapshots WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
  ).get(projectId),

  // 某快照的 URL 列表（按曝光倒序）
  getGscSnapshotUrls: async (snapshotId, opts = {}) => {
    const limit = Number(opts.limit) || 1000;
    const search = typeof opts.search === 'string' && opts.search.trim()
      ? `%${opts.search.trim()}%` : null;
    const sql = `SELECT u.*,
        (SELECT COUNT(*) FROM gsc_snapshot_queries q WHERE q.snapshot_id = u.snapshot_id AND q.url_id = u.url_id) AS query_count
      FROM gsc_snapshot_urls u
      WHERE u.snapshot_id = ?
      ${search ? 'AND u.url LIKE ?' : ''}
      ORDER BY u.impressions DESC
      LIMIT ?`;
    const params = [snapshotId];
    if (search) params.push(search);
    params.push(limit);
    return db.prepare(sql).all(...params);
  },

  // 某快照内某个 URL 的关键词明细（默认按曝光倒序）
  getGscSnapshotQueriesForUrl: async (snapshotId, urlId, opts = {}) => {
    const limit = Number(opts.limit) || 500;
    const search = typeof opts.search === 'string' && opts.search.trim()
      ? `%${opts.search.trim()}%` : null;
    const orderBy = opts.orderBy === 'clicks' ? 'clicks DESC'
      : opts.orderBy === 'ctr' ? 'ctr DESC'
      : opts.orderBy === 'position' ? 'position ASC'
      : 'impressions DESC';
    const sql = `SELECT * FROM gsc_snapshot_queries
      WHERE snapshot_id = ? AND url_id = ?
      ${search ? 'AND query LIKE ?' : ''}
      ORDER BY ${orderBy}
      LIMIT ?`;
    const params = [snapshotId, urlId];
    if (search) params.push(search);
    params.push(limit);
    return db.prepare(sql).all(...params);
  },

  // 某快照的汇总指标
  getGscSnapshotSummary: async (snapshotId) => db.prepare(
    `SELECT
       COUNT(*) AS url_count,
       COALESCE(SUM(clicks), 0) AS total_clicks,
       COALESCE(SUM(impressions), 0) AS total_impressions,
       COALESCE(SUM(impressions * position) / NULLIF(SUM(impressions), 0), 0) AS avg_position,
       (SELECT COUNT(*) FROM gsc_snapshot_queries q WHERE q.snapshot_id = s.snapshot_id) AS query_count
     FROM gsc_snapshot_urls s
     WHERE s.snapshot_id = ?`
  ).get(snapshotId),

  // 保存一个完整快照：建快照行 + 多行 VALUES 批量写 URL 级 + query 级，最后滚动清理到
  // 只保留最近 3 个（同项目）。数据：
  // { project_id, snapshot_date, start_date, end_date, urls: [{url_id, url, clicks, impressions, ctr, position}], queries: [{url_id, query, clicks, impressions, ctr, position}] }
  //
  // 快照、两层明细及旧快照清理在同一事务提交，失败不会留下空快照。
  saveGscSnapshot: async (data) => {
    const statements = [db.prepare(`INSERT INTO gsc_snapshots
      (project_id, snapshot_date, start_date, end_date, created_at)
      VALUES (?, ?, ?, ?, ?)`).bind(
      data.project_id, data.snapshot_date, data.start_date, data.end_date, now()
    )];
    const urls = data.urls || [], queries = data.queries || [];
    // 同一事务内按项目取刚插入的 id，不依赖逐条执行间的外部状态。
    for (const [table, textColumn, rows] of [
      ['gsc_snapshot_urls', 'url', urls], ['gsc_snapshot_queries', 'query', queries],
    ]) {
      if (!rows.length) continue;
      statements.push(db.prepare(`INSERT INTO ${table}
        (snapshot_id, url_id, ${textColumn}, clicks, impressions, ctr, position)
        SELECT (SELECT MAX(id) FROM gsc_snapshots WHERE project_id = ?),
          json_extract(value,'$.url_id'), json_extract(value,'$.${textColumn}'),
          COALESCE(json_extract(value,'$.clicks'),0), COALESCE(json_extract(value,'$.impressions'),0),
          COALESCE(json_extract(value,'$.ctr'),0), COALESCE(json_extract(value,'$.position'),0)
        FROM json_each(?)`).bind(data.project_id, JSON.stringify(rows)));
    }
    const oldIds = 'SELECT id FROM gsc_snapshots WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET 3';
    for (const table of ['gsc_snapshot_queries', 'gsc_snapshot_urls', 'gsc_snapshots']) {
      const key = table === 'gsc_snapshots' ? 'id' : 'snapshot_id';
      statements.push(db.prepare(`DELETE FROM ${table} WHERE ${key} IN (${oldIds})`).bind(data.project_id));
    }
    const results = await db.batchAtomic(statements);
    return { id: Number(results[0].lastInsertRowid), urlCount: urls.length, queryCount: queries.length,
      pruned: Number(results.at(-1).changes) };
  },
});
