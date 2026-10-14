// external-links.js —— 我发的外链：用户登记的 URL/锚文本/备注 + GA4 反查回来的累计会话/用户/关键事件

const { now } = require('../helpers');

module.exports = (db) => ({
  // 单个项目的外链列表（按发布/创建时间倒序，跟 UI 上"最近登记的排前面"一致）
  listExternalLinks: async (projectId) => db.prepare(
    `SELECT * FROM external_links WHERE project_id = ? ORDER BY COALESCE(published_at, created_at) DESC, id DESC`
  ).all(projectId),

  getExternalLink: async (id) => db.prepare('SELECT * FROM external_links WHERE id = ?').get(id),

  // 全部项目汇总（带项目名，给外链汇总视图用）
  listAllExternalLinks: async ({ ownerUserId, isAdmin } = {}) => db.prepare(
    `SELECT l.*, p.name AS project_name, p.status AS project_status
     FROM external_links l
     JOIN projects p ON p.id = l.project_id
     WHERE @isAdmin = 1 OR p.owner_user_id = @uid
        OR p.id IN (SELECT project_id FROM project_copywriters WHERE user_id = @uid AND revoked_at IS NULL)
     ORDER BY l.created_at DESC`
  ).all({ uid: ownerUserId ?? null, isAdmin: isAdmin ? 1 : 0 }),

  addExternalLink: async (projectId, { url, anchor_text, published_at, notes }) =>
    db.prepare(
      `INSERT INTO external_links (project_id, url, anchor_text, published_at, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(projectId, url, anchor_text || null, published_at || null, notes || null, now()),

  deleteExternalLink: async (id) => {
    const info = await db.prepare('DELETE FROM external_links WHERE id = ?').run(id);
    return Number(info.changes || 0);
  },

  // 该项目外链的最后抓取时间（取每条 link 的 last_fetched_at 最大值）
  lastExternalLinksFetch: async (projectId) => db.prepare(
    'SELECT MAX(last_fetched_at) AS t FROM external_links WHERE project_id = ?'
  ).get(projectId),

  // 累计值回写：sessions/users/settled_through 主查询成功必填；
  // key_events/key_events_through 关键事件查询失败传 null 保留旧值。
  // 注意：url/anchor_text/published_at/notes 等登记字段不在更新范围里，用户编辑后不会被覆盖。
  // 每行的更新值都不同，走逐行语句 + batch（行数 = 项目外链数，几十条，远够不着分块阈值）
  saveExternalLinksMetrics: async (rows) => {
    if (!rows.length) return 0;
    const stmt = db.prepare(`UPDATE external_links SET
        sessions = ?, users = ?,
        key_events = COALESCE(?, external_links.key_events),
        settled_through = ?,
        key_events_through = COALESCE(?, external_links.key_events_through),
        last_fetched_at = ?
      WHERE id = ?`);
    const t = now();
    await db.batch(rows.map((r) => stmt.bind(
      r.sessions ?? 0, r.users ?? 0,
      r.key_events === undefined ? null : r.key_events,
      r.settled_through,
      r.key_events_through === undefined ? null : r.key_events_through,
      t, r.id,
    )));
    return rows.length;
  },
});
