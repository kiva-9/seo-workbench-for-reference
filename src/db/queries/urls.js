// urls.js —— 项目登记的 URL（一篇文章一行）：增删改、排序、文章属性、级联清理

const { now } = require('../helpers');

// 一条 URL 被删掉时必须跟着清的表（都只有 url_id，没有外键级联）
const URL_DERIVED_TABLES = ['url_metrics', 'ga4_metrics', 'gsc_snapshot_queries', 'gsc_snapshot_urls'];

// 文章属性：只改 title/keyword/published_date/notes 这几个手填字段，
// 不碰 url 本身（url 是抓取匹配的主键，改名字应该新增一条而不是原地重写）。
const URL_META_FIELDS = ['title', 'keyword', 'published_date', 'notes'];

module.exports = (db) => ({
  URL_META_FIELDS,

  listUrls: async (projectId) => db.prepare('SELECT * FROM urls WHERE project_id = ? ORDER BY COALESCE(sort_order, id) ASC, id ASC').all(projectId),
  getUrl: async (id) => db.prepare('SELECT * FROM urls WHERE id = ?').get(id),
  findUrl: async (projectId, url) => db.prepare('SELECT * FROM urls WHERE project_id = ? AND url = ?').get(projectId, url),

  // 新登记的 URL 排在最后：取该项目当前最大 sort_order + 1
  nextUrlSortOrder: async (projectId) => {
    const row = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM urls WHERE project_id = ?')
      .get(projectId);
    return Number(row.n);
  },

  updateUrlMeta: async (id, data) => {
    const fields = [];
    const params = [];
    for (const k of URL_META_FIELDS) {
      if (k in data) { fields.push(`${k} = ?`); params.push(data[k] || null); }
    }
    if (!fields.length) return 0;
    fields.push('updated_at = ?');
    params.push(now(), id);
    const info = await db.prepare(`UPDATE urls SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return info.changes;
  },

  // 项目主页的文章列表：urls 的文章属性 + 最新一次 GSC 全量快照（16 个月累计口径的
  // 点击/曝光/排名）+ GA4 累计会话数。没有快照 / 没抓过 GA4 时对应字段为 null，前端显示「—」。
  getProjectArticles: async (projectId) => db.prepare(
    `SELECT u.id, u.url, u.title, u.keyword, u.published_date, u.notes,
            u.created_at, u.updated_at,
            su.clicks, su.impressions, su.ctr, su.position,
            (SELECT COUNT(*) FROM gsc_snapshot_queries sq
               WHERE sq.snapshot_id = su.snapshot_id AND sq.url_id = su.url_id) AS query_count,
            g.sessions AS ga_sessions, g.users AS ga_users, g.key_events AS ga_key_events
     FROM urls u
     LEFT JOIN gsc_snapshot_urls su
       ON su.url_id = u.id AND su.snapshot_id = (
         SELECT id FROM gsc_snapshots WHERE project_id = u.project_id
         ORDER BY created_at DESC, id DESC LIMIT 1
       )
     LEFT JOIN ga4_metrics g ON g.url_id = u.id
     WHERE u.project_id = ?
     ORDER BY COALESCE(u.sort_order, u.id) ASC, u.id ASC`
  ).all(projectId),

  // 删除 URL 及其全部衍生数据。这几张表都只有 url_id、没有外键约束
  // （建表时一个 REFERENCES 都没写，PRAGMA foreign_keys 形同虚设），
  // 漏掉任何一张都会留下永远清不掉的孤儿行。
  // 每张表一次集合删除，全部语句在同一事务中提交。
  purgeUrls: async (ids) => {
    const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!list.length) return { urls: 0 };
    const json = JSON.stringify(list);
    const statements = URL_DERIVED_TABLES.map(table =>
      db.prepare(`DELETE FROM ${table} WHERE url_id IN (SELECT value FROM json_each(?))`).bind(json));
    statements.push(db.prepare('DELETE FROM urls WHERE id IN (SELECT value FROM json_each(?))').bind(json));
    const results = await db.batchAtomic(statements);
    return { urls: Number(results.at(-1).changes) };
  },

  // 清理孤儿行：url 已不在 urls 表里、衍生数据却还挂在旧 url_id 上。
  // 汇总查询都是 JOIN urls 的，所以孤儿不会污染数字，只是永远占着地方清不掉。
  // 启动时跑一次兜底。4 条 DELETE 相互独立，合成一个原子 batch
  pruneOrphans: async () => {
    const results = await db.batch(URL_DERIVED_TABLES.map((t) => db.prepare(
      `DELETE FROM ${t} WHERE url_id IS NOT NULL AND url_id NOT IN (SELECT id FROM urls)`
    )));
    const out = {};
    URL_DERIVED_TABLES.forEach((t, i) => { out[t] = Number(results[i].changes || 0); });
    return out;
  },

  // 保存 URL 拖拽后的顺序：按传入的 id 顺序重写 sort_order。只更新属于该项目的 id。
  reorderUrls: async (projectId, orderedIds) => {
    const rows = await db.prepare('SELECT id FROM urls WHERE project_id = ?').all(projectId);
    const own = new Set(rows.map((r) => r.id));
    const valid = orderedIds.filter((id) => own.has(id));
    const stmt = db.prepare('UPDATE urls SET sort_order = ? WHERE id = ?');
    await db.batch(valid.map((id, i) => stmt.bind(i, id)));
    return valid.length;
  },
});
