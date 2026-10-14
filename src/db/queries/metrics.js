// metrics.js —— 指标：GSC 按月窗口（url_metrics）+ GA4 本地累计（ga4_metrics），以及跨项目汇总/历史透视

const { now } = require('../helpers');
const { chunk } = require('../../lib/chunk');
const ROWS_PER_WRITE = 500;

const METRIC_COLS = ['gsc_clicks', 'gsc_impressions', 'gsc_ctr', 'gsc_position', 'ga_sessions', 'ga_users', 'ga_pageviews', 'ga_key_events'];

// 多行 VALUES 分组限制单条 SQL 的体积，整批写入在同一 SQLite 事务中提交。
// rows 值按 cols 顺序排好；占位符按每块实际行数生成（末块可能不满一行数）。
// 返回值忽略（调用方只关心写了多少行，自己数）。
function multiRowUpsert(db, { table, cols, values, conflictTarget, updateSet }) {
  const oneRow = `(${cols.map(() => '?').join(', ')})`;
  const sqlFor = (n) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${Array(n).fill(oneRow).join(', ')}
    ON CONFLICT ${conflictTarget} DO UPDATE SET ${updateSet}`;
  const perStmt = ROWS_PER_WRITE;
  const statements = chunk(values, perStmt)
    .map((group) => db.prepare(sqlFor(group.length)).bind(...group.flat()));
  return statements.length ? db.batch(statements) : Promise.resolve([]);
}

module.exports = (db) => ({
  // 以 URL 列表为主表左连接 GSC(按月窗口) + GA4(累计)，两条数据源窗口不同，分开 join
  // —— GSC 随选择的月份窗口，GA4 是本地累计到今天（ga_* 字段来自 ga4_metrics）
  getMetricsForRange: async (projectId, startDate, endDate) => db.prepare(
    `SELECT u.id AS url_id, u.url, u.created_at,
            m.start_date, m.end_date, m.fetched_at,
            m.gsc_clicks, m.gsc_impressions, m.gsc_ctr, m.gsc_position,
            g.sessions AS ga_sessions, g.users AS ga_users, g.pageviews AS ga_pageviews,
            g.key_events AS ga_key_events, g.settled_through AS ga_settled_through,
            g.last_fetched_at AS ga_fetched_at
     FROM urls u
     LEFT JOIN url_metrics m
       ON m.url_id = u.id AND m.start_date = @start AND m.end_date = @end
     LEFT JOIN ga4_metrics g ON g.url_id = u.id
     WHERE u.project_id = @pid
     ORDER BY COALESCE(u.sort_order, u.id) ASC, u.id ASC`
  ).all({ pid: projectId, start: startDate, end: endDate }),

  lastFetchForRange: async (projectId, startDate, endDate) => db.prepare(
    `SELECT MAX(fetched_at) AS t FROM url_metrics
     WHERE project_id = ? AND start_date = ? AND end_date = ?`
  ).get(projectId, startDate, endDate),

  // 全部项目汇总：一个窗口内每个项目的 GSC 合计 + GA4(累计) 合计
  // CTR 用 总点击/总曝光 重算（不是各 URL CTR 的平均），排名按有排名的 URL 取均值
  // ownerUserId 为 null（admin）时不过滤项目范围，否则只汇总"我拥有/协作"的项目
  getOverviewForRange: async (startDate, endDate, { ownerUserId, isAdmin } = {}) => db.prepare(
    `SELECT p.id AS project_id, p.name, p.website, p.status,
            p.gsc_site, p.ga4_property_id, p.gsc_account_id, p.ga4_account_id, p.account_id,
            COUNT(DISTINCT u.id) AS url_count,
            COUNT(DISTINCT CASE WHEN m.id IS NOT NULL THEN u.id END) AS fetched_count,
            SUM(m.gsc_clicks)       AS gsc_clicks,
            SUM(m.gsc_impressions)  AS gsc_impressions,
            AVG(CASE WHEN m.gsc_position > 0 THEN m.gsc_position END) AS gsc_position,
            SUM(g.sessions)      AS ga_sessions,
            SUM(g.users)         AS ga_users,
            SUM(g.pageviews)     AS ga_pageviews,
            SUM(g.key_events)    AS ga_key_events,
            MAX(m.fetched_at)       AS fetched_at,
            MAX(g.last_fetched_at)  AS ga_fetched_at
     FROM projects p
     LEFT JOIN urls u ON u.project_id = p.id
     LEFT JOIN url_metrics m
       ON m.url_id = u.id AND m.start_date = @start AND m.end_date = @end
     LEFT JOIN ga4_metrics g ON g.url_id = u.id
     WHERE @isAdmin = 1 OR p.owner_user_id = @uid
        OR p.id IN (SELECT project_id FROM project_copywriters WHERE user_id = @uid AND revoked_at IS NULL)
     GROUP BY p.id
     ORDER BY COALESCE(SUM(m.gsc_clicks), -1) DESC, p.created_at DESC`
  ).all({ start: startDate, end: endDate, uid: ownerUserId ?? null, isAdmin: isAdmin ? 1 : 0 }),

  // 历史数据表：把「自然月」窗口按 URL 摊平，前端再横向透视成每月一列。
  // 只认自然月窗口（start_date 是某月 1 号、且 end_date 在同月），自定义区间不计入；
  // 同一个月如果既有整月又有"本月至今"的记录，取 end_date 最大的那条（整月胜出）。
  // 只统计 GSC（GA4 是累计的，不走逐月透视）。
  // projectId 给定时只按它过滤——调用方已经用 canAccessProject 校验过那一个项目；
  // projectId 为空（全部项目透视）时才按 owner/协作者圈定范围，admin 不圈。
  getMonthlyHistory: async (projectId = null, { ownerUserId, isAdmin } = {}) => {
    const scopeSql = `WHERE (@pid IS NOT NULL AND p.id = @pid)
       OR (@pid IS NULL AND (@isAdmin = 1 OR p.owner_user_id = @uid
            OR p.id IN (SELECT project_id FROM project_copywriters WHERE user_id = @uid AND revoked_at IS NULL)))`;
    const sql = `
      WITH month_rows AS (
        SELECT url_id,
               strftime('%Y-%m', start_date) AS ym,
               gsc_clicks, gsc_impressions,
               ROW_NUMBER() OVER (
                 PARTITION BY url_id, strftime('%Y-%m', start_date)
                 ORDER BY end_date DESC
               ) AS rn
        FROM url_metrics
        WHERE start_date IS NOT NULL
          AND strftime('%d', start_date) = '01'
          AND strftime('%Y-%m', start_date) = strftime('%Y-%m', end_date)
      )
      SELECT p.id AS project_id, p.name AS project_name, p.status AS project_status,
             u.id AS url_id, u.url,
             mr.ym, mr.gsc_clicks, mr.gsc_impressions,
             g.pageviews AS ga_total_pageviews,
             g.key_events AS ga_total_key_events
      FROM urls u
      JOIN projects p ON p.id = u.project_id
      LEFT JOIN month_rows mr ON mr.url_id = u.id AND mr.rn = 1
      LEFT JOIN ga4_metrics g ON g.url_id = u.id
      ${scopeSql}
      ORDER BY p.name ASC, COALESCE(u.sort_order, u.id) ASC, u.id ASC, mr.ym ASC`;
    return db.prepare(sql).all({ pid: projectId, uid: ownerUserId ?? null, isAdmin: isAdmin ? 1 : 0 });
  },

  // 已经抓过的统计窗口（给"历史区间"下拉用）
  listFetchedWindows: async (projectId, limit = 30) => (projectId
    ? db.prepare(
      `SELECT start_date, end_date, period_days, MAX(fetched_at) AS fetched_at, COUNT(DISTINCT url_id) AS urls
       FROM url_metrics WHERE project_id = ? AND start_date IS NOT NULL
       GROUP BY start_date, end_date ORDER BY end_date DESC, start_date DESC LIMIT ?`
    ).all(projectId, limit)
    : db.prepare(
      `SELECT start_date, end_date, period_days, MAX(fetched_at) AS fetched_at, COUNT(DISTINCT url_id) AS urls
       FROM url_metrics WHERE start_date IS NOT NULL
       GROUP BY start_date, end_date ORDER BY end_date DESC, start_date DESC LIMIT ?`
    ).all(limit)),

  // 按 (url_id, start_date, end_date) UPSERT：重复抓取同一个窗口是覆盖而不是追加。
  // 某个数据源本次抓取失败时传 null，COALESCE 会保留已有的好数据，不会被 null 冲掉。
  saveMetrics: async (rows) => {
    if (!rows.length) return 0;
    const cols = ['url_id', 'project_id', 'period_days', 'start_date', 'end_date', ...METRIC_COLS, 'fetched_at'];
    const t = now();
    const values = rows.map((r) => [
      r.url_id, r.project_id, r.period_days, r.start_date, r.end_date,
      ...METRIC_COLS.map((c) => (r[c] === undefined ? null : r[c])),
      t,
    ]);
    // COALESCE 语义不变：本次为 null 的指标列保留库里的旧值；窗口定位列 / fetched_at 无条件覆盖
    await multiRowUpsert(db, {
      table: 'url_metrics', cols, values,
      conflictTarget: '(url_id, start_date, end_date)',
      updateSet: `${METRIC_COLS.map((c) => `${c} = COALESCE(excluded.${c}, url_metrics.${c})`).join(',\n        ')},
        period_days = excluded.period_days,
        fetched_at = excluded.fetched_at`,
    });
    return rows.length;
  },

  // ---------- 站内 GA4 累计 ----------
  // 每条 URL 一行，UPSERT 覆盖累计值。
  // sessions/users/pageviews/settled_through 由主查询提供（成功必填）；
  // key_events/key_events_through 由关键事件查询提供，失败传 null 保留旧值。
  saveGa4Metrics: async (rows) => {
    if (!rows.length) return 0;
    const cols = ['url_id', 'project_id', 'sessions', 'users', 'pageviews', 'key_events', 'settled_through', 'key_events_through', 'last_fetched_at'];
    const t = now();
    const values = rows.map((r) => [
      r.url_id, r.project_id,
      r.sessions ?? 0, r.users ?? 0, r.pageviews ?? 0,
      r.key_events === undefined ? null : r.key_events,
      r.settled_through,
      r.key_events_through === undefined ? null : r.key_events_through,
      t,
    ]);
    await multiRowUpsert(db, {
      table: 'ga4_metrics', cols, values,
      conflictTarget: '(url_id)',
      updateSet: `project_id = excluded.project_id,
        sessions = excluded.sessions,
        users = excluded.users,
        pageviews = excluded.pageviews,
        key_events = COALESCE(excluded.key_events, ga4_metrics.key_events),
        settled_through = excluded.settled_through,
        key_events_through = COALESCE(excluded.key_events_through, ga4_metrics.key_events_through),
        last_fetched_at = excluded.last_fetched_at`,
    });
    return rows.length;
  },

  // 单个项目全部 URL 的 GA4 累计（join urls 拿到 url 字符串）
  getGa4Metrics: async (projectId) => db.prepare(
    `SELECT g.*, u.url FROM ga4_metrics g JOIN urls u ON u.id = g.url_id
     WHERE g.project_id = ? ORDER BY COALESCE(u.sort_order, u.id) ASC, u.id ASC`
  ).all(projectId),

  // 单个项目各 URL 的 GA4 累计数字（只取指标列，给快照视图合并用）
  listGa4Totals: async (projectId) => db.prepare(
    'SELECT url_id, sessions, users, pageviews, key_events FROM ga4_metrics WHERE project_id = ?'
  ).all(projectId),

  lastGa4Fetch: async (projectId) => db.prepare(
    'SELECT MAX(last_fetched_at) AS t FROM ga4_metrics WHERE project_id = ?'
  ).get(projectId),

  // 项目配置的关键事件名变化时调用：
  // 把该项目所有累计来源的 key_events 清零、key_events_through 置 NULL，
  // 这样下次抓取会走 incrementalStart 的 hasNew=true 分支，从 GA_BACKFILL_START 全量重新累计，
  // 用新的事件名集合重新统计关键事件数（旧的累计是按旧事件名算的，无法只减不增）。
  // 影响：ga4_metrics（站内 URL）、external_links（我发的外链 + GA4 反查累计）
  resetKeyEventsAccumulation: async (projectId) => {
    const [r1, r3] = await db.batch([
      db.prepare('UPDATE ga4_metrics SET key_events = 0, key_events_through = NULL WHERE project_id = ?').bind(projectId),
      db.prepare('UPDATE external_links SET key_events = 0, key_events_through = NULL WHERE project_id = ?').bind(projectId),
    ]);
    return { urls: Number(r1.changes || 0), externalLinks: Number(r3.changes || 0) };
  },
});
