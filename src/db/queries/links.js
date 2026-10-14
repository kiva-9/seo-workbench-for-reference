// links.js —— 链接库（挂在项目下的链接 + 个人收藏）

const { now, normalizeTags, escapeLike } = require('../helpers');

module.exports = (db) => ({
  // opts.ownerUserId/isAdmin：项目内链接（project_id 是具体数字）不在这里按 owner 过滤，
  // 调用方（路由）已经用 canAccessProject 校验过项目访问权，能看到项目就能看到项目下
  // 全部链接；只有「个人收藏」（project_id IS NULL）和「全部」两种情况需要按 owner 过滤。
  listLinks: async (projectId, opts = {}) => {
    const where = [];
    const params = [];
    const { ownerUserId, isAdmin } = opts;
    if (projectId !== 'all') {
      if (projectId === null || projectId === undefined) {
        where.push('project_id IS NULL');
        if (!isAdmin) { where.push('owner_user_id = ?'); params.push(ownerUserId); }
      } else if (projectId) {
        where.push('project_id = ?');
        params.push(projectId);
      }
    } else if (!isAdmin) {
      where.push(`(
        (project_id IS NULL AND owner_user_id = ?)
        OR project_id IN (
          SELECT id FROM projects WHERE owner_user_id = ?
          UNION
          SELECT project_id FROM project_copywriters WHERE user_id = ? AND revoked_at IS NULL
        )
      )`);
      params.push(ownerUserId, ownerUserId, ownerUserId);
    }
    if (opts.search) {
      where.push("(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
      const s = `%${escapeLike(opts.search)}%`;
      params.push(s, s, s);
    }
    if (opts.tag) {
      // tags 是逗号分隔的一列，子串匹配会让「SaaS」连带命中「SaaS后台」。
      // 两头补逗号后整段匹配，才是真正的「等于某个标签」。
      where.push("(',' || tags || ',') LIKE ? ESCAPE '\\'");
      params.push(`%,${escapeLike(opts.tag)},%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM links ${whereSql} ORDER BY created_at DESC LIMIT ?`;
    params.push(Number(opts.limit) || 500);
    return db.prepare(sql).all(...params);
  },
  getLink: async (id) => db.prepare('SELECT * FROM links WHERE id = ?').get(id),
  createLink: async (data) => {
    const t = now();
    const tags = normalizeTags(data.tags);
    const info = await db.prepare(`INSERT INTO links
      (project_id, title, url, tags, notes, owner_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      data.project_id ?? null, data.title, data.url, tags, data.notes || '', data.owner_user_id ?? null, t, t
    );
    return Number(info.lastInsertRowid);
  },
  updateLink: async (id, data) => {
    const tags = data.tags !== undefined ? normalizeTags(data.tags) : undefined;
    const fields = [];
    const params = [];
    if ('project_id' in data) { fields.push('project_id = ?'); params.push(data.project_id ?? null); }
    if ('title' in data) { fields.push('title = ?'); params.push(data.title); }
    if ('url' in data) { fields.push('url = ?'); params.push(data.url); }
    if (tags !== undefined) { fields.push('tags = ?'); params.push(tags); }
    if ('notes' in data) { fields.push('notes = ?'); params.push(data.notes || ''); }
    if (!fields.length) return 0;
    fields.push('updated_at = ?');
    params.push(now(), id);
    const info = await db.prepare(`UPDATE links SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return info.changes;
  },
  deleteLink: async (id) => {
    const info = await db.prepare('DELETE FROM links WHERE id = ?').run(id);
    return info.changes;
  },

  // projectId 的三态语义必须和 listLinks 一致：
  //   'all'          → 不限项目
  //   null/undefined → 个人收藏（project_id IS NULL）
  //   数字            → 该项目
  // 用 falsy 判断会把 null 当成「不限项目」，于是「🔖 个人收藏」视图的标签下拉
  // 会列出全部项目的标签，选中任何一个都必然筛不出东西。
  listLinkTags: async (projectId, { ownerUserId, isAdmin } = {}) => {
    const notEmpty = "tags IS NOT NULL AND tags <> ''";
    let rows;
    if (projectId === 'all') {
      if (isAdmin) {
        rows = await db.prepare(`SELECT tags FROM links WHERE ${notEmpty}`).all();
      } else {
        rows = await db.prepare(`SELECT tags FROM links WHERE ${notEmpty} AND (
          (project_id IS NULL AND owner_user_id = @uid)
          OR project_id IN (
            SELECT id FROM projects WHERE owner_user_id = @uid
            UNION
            SELECT project_id FROM project_copywriters WHERE user_id = @uid AND revoked_at IS NULL
          )
        )`).all({ uid: ownerUserId });
      }
    } else if (projectId === null || projectId === undefined) {
      rows = isAdmin
        ? await db.prepare(`SELECT tags FROM links WHERE project_id IS NULL AND ${notEmpty}`).all()
        : await db.prepare(`SELECT tags FROM links WHERE project_id IS NULL AND owner_user_id = ? AND ${notEmpty}`).all(ownerUserId);
    } else {
      // 具体项目：调用方已经校验过项目访问权，这里不用再按 owner 过滤
      rows = await db.prepare(`SELECT tags FROM links WHERE project_id = ? AND ${notEmpty}`).all(projectId);
    }
    const set = new Set();
    for (const r of rows) {
      for (const t of (r.tags || '').split(',')) {
        const trimmed = t.trim();
        if (trimmed) set.add(trimmed);
      }
    }
    return [...set].sort();
  },
});
