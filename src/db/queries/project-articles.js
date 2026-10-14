// project-articles.js —— 站内文章登记表的完整 CRUD（任务06）
// 字段与约束见 migrations/0002；写路径统一走 batchAtomic 并按任务03的边界反馈。
//
// URL 身份规则（任务06契约）：
//   - 登记只 trim，不改大小写/尾斜杠/query；站内允许 http(s):// 或 / 开头。
//   - 改址 A→B：历史写入、当前地址修改、取数修订推进必须同一个原子单元；
//     仅改地址不删月度数据。A→B→A（回到自己历史地址）时移除该回归条目。
//   - 认领：B 若是同项目另一篇文章的历史地址，归当前登记方——历史方的那条历史
//     删除（其全部月份排除该地址），双方修订都推进（失效相关双方）。
//   - B 撞同项目另一篇的当前地址：UNIQUE(project_id,url) 直接拦，重复登记不自动恢复。
//   - 人员/标题等元数据改动不标 dirty；启停/改址等涉及认领变化的推进修订。

const { withAtomicGuard } = require('../../lib/atomic-guard');
const { runUnitBatch } = require('../../lib/unit-batch');
const { normalizeArticleUrl, projectDomainOf } = require('../../lib/article-import');

const META_FIELDS = ['title', 'keyword', 'notes', 'published_at']; // 可空手填字段
const ARTICLE_STATUS = ['active', 'inactive'];
const MAX_PAGE_SIZE = 100;

async function ownedArticleIds(db, projectId, ids) {
  const rows = await db.prepare(
    'SELECT id FROM project_articles WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))'
  ).all(projectId, JSON.stringify(ids));
  return new Set(rows.map(row => Number(row.id)));
}

module.exports = (db) => ({
  // ============ 读 ============

  listArticles: async (projectId) => db.prepare(
    'SELECT * FROM project_articles WHERE project_id = ? ORDER BY COALESCE(sort_order, id) ASC, id ASC'
  ).all(projectId),

  getArticle: async (id) => db.prepare('SELECT * FROM project_articles WHERE id = ?').get(id),

  findArticleByUrl: async (projectId, url) =>
    db.prepare('SELECT * FROM project_articles WHERE project_id = ? AND url = ?').get(projectId, url),

  // 管理清单：服务端分页 + 搜索（不把 1000 篇塞进 DOM）。返回 { rows, total }
  listArticlesPaged: async (projectId, { q = '', status = '', page = 1, pageSize = 50 } = {}) => {
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), MAX_PAGE_SIZE);
    const p = Math.max(Number(page) || 1, 1);
    const where = ['project_id = @pid'];
    const named = { pid: projectId };
    if (q && String(q).trim()) {
      where.push('(url LIKE @q OR title LIKE @q OR keyword LIKE @q)');
      named.q = `%${String(q).trim()}%`;
    }
    if (status && ARTICLE_STATUS.includes(status)) {
      where.push('status = @status');
      named.status = status;
    }
    const cond = where.join(' AND ');
    const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM project_articles WHERE ${cond}`).get(named)).n);
    const list = await db.prepare(
      `SELECT * FROM project_articles WHERE ${cond}
       ORDER BY COALESCE(sort_order, id) ASC, id ASC LIMIT @lim OFFSET @off`
    ).all({ ...named, lim: size, off: (p - 1) * size });
    return { rows: list, total };
  },

  countActiveArticles: async (projectId) =>
    Number((await db.prepare("SELECT COUNT(*) AS n FROM project_articles WHERE project_id = ? AND status = 'active'").get(projectId)).n),

  // 指定 id 集合中某状态的篇数（批量启用前的上限核算用）
  countArticlesByIds: async (projectId, ids, status) => {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const articleIds = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    return Number((await db.prepare(
      'SELECT COUNT(*) AS n FROM project_articles WHERE project_id = ? AND status = ? AND id IN (SELECT value FROM json_each(?))'
    ).get(projectId, status, JSON.stringify(articleIds))).n);
  },

  nextArticleSortOrder: async (projectId) =>
    Number((await db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM project_articles WHERE project_id = ?').get(projectId)).n),

  countArticles: async (projectId) =>
    Number((await db.prepare('SELECT COUNT(*) AS n FROM project_articles WHERE project_id = ?').get(projectId)).n),

  listArticleUrlHistory: async (articleId) => db.prepare(
    'SELECT * FROM project_article_url_history WHERE article_id = ? ORDER BY url_changed_at DESC, id DESC'
  ).all(articleId),

  // 批量曾用地址（列表页行内展示「曾用：…」用，一次查一页）
  listUrlHistoryForArticles: async (articleIds) => {
    const ids = [...new Set((articleIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return [];
    return db.prepare(
      `SELECT * FROM project_article_url_history WHERE article_id IN (SELECT value FROM json_each(?)) ORDER BY url_changed_at DESC, id DESC`
    ).all(JSON.stringify(ids));
  },

  // 当前筛选命中的全部文章 id（跨页全选用；受 pageSize 约束由调用方决定）
  listMatchedArticleIds: async (projectId, { q = '', status = '' } = {}) => {
    const where = ['project_id = @pid'];
    const named = { pid: projectId };
    if (q && String(q).trim()) {
      where.push('(url LIKE @q OR title LIKE @q OR keyword LIKE @q)');
      named.q = `%${String(q).trim()}%`;
    }
    if (status && ARTICLE_STATUS.includes(status)) {
      where.push('status = @status');
      named.status = status;
    }
    const rows = await db.prepare(
      `SELECT id FROM project_articles WHERE ${where.join(' AND ')} ORDER BY COALESCE(sort_order, id) ASC, id ASC`
    ).all(named);
    return rows.map((r) => Number(r.id));
  },

  // 某地址是否被本项目任一文章占用（当前或历史）——认领判定
  findUrlOccupants: async (projectId, url) => db.prepare(
    "SELECT id, url, 'current' AS kind FROM project_articles WHERE project_id = ? AND url = ? " +
    'UNION ALL ' +
    "SELECT h.article_id AS id, h.url, 'history' AS kind FROM project_article_url_history h " +
    'WHERE h.project_id = ? AND h.url = ? ' +
    'ORDER BY kind, id'
  ).all(projectId, url, projectId, url),

  // ============ 写 ============

  // 配置变化（关键事件集合）→ 项目下文章标 dirty（旧数据保留标 stale，不清不推修订）
  markProjectArticlesDirty: async (projectId, at) => {
    const info = await db.prepare(
      'UPDATE project_articles SET metrics_dirty = 1, updated_at = @at WHERE project_id = @pid'
    ).run({ pid: projectId, at });
    return Number(info.changes || 0);
  },

  // 新增（单条）。copywriterId 为 null/undefined 表示不指派。
  createArticle: async (projectId, { url, title = '', keyword = '', notes = '', published_at = null, copywriter_id = null }, at) => {
    // sort 内联取：查询模块之间不能互相调用（模块里的 db 是后端，不是扁平 api）
    const sort = Number((await db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM project_articles WHERE project_id = ?').get(projectId)).n);
    const info = await db.prepare(
      `INSERT INTO project_articles
        (project_id, url, title, title_source, keyword, notes, published_at, copywriter_id, status, sort_order,
         fetch_revision, metrics_dirty, created_at, updated_at)
       VALUES (@pid, @url, @title, @titleSource, @keyword, @notes, @pub, @cw, 'active', @sort, 1, 1, @at, @at)`
    ).run({ pid: projectId, url, title, titleSource: String(title || '').trim() ? 'manual' : null, keyword, notes, pub: published_at || null, cw: copywriter_id ?? null, sort, at });
    return Number(info.lastInsertRowid);
  },

  // 元数据 + 文案师指派（都不推进取数修订：人员/标题变化不触发重抓）
  updateArticleMeta: async (articleId, data, at) => {
    const fields = [];
    const named = { id: articleId, at };
    for (const k of [...META_FIELDS, 'copywriter_id']) {
      if (k in data) {
        fields.push(`${k} = @${k}`);
        named[k] = data[k] ?? null;
      }
    }
    // 显式写标题 = 人工维护：抓取永不覆盖，
    // 同时清掉上次抓取的状态位。
    if ('title' in data) {
      fields.push("title_source = 'manual'", 'title_fetch_status = NULL', 'title_fetch_error = NULL');
    }
    if (!fields.length) return 0;
    fields.push('updated_at = @at');
    const info = await db.prepare(
      `UPDATE project_articles SET ${fields.join(', ')} WHERE id = @id`
    ).run(named);
    return Number(info.changes || 0);
  },

  // 启停：涉及认领/覆盖范围的变化，推进取数修订并标 dirty
  setArticleStatus: async (articleId, status, at) => {
    if (!ARTICLE_STATUS.includes(status)) throw new Error('status 必须是 active 或 inactive');
    const info = await db.prepare(
      "UPDATE project_articles SET status = @status, fetch_revision = fetch_revision + 1, metrics_dirty = 1, updated_at = @at WHERE id = @id"
    ).run({ id: articleId, status, at });
    return Number(info.changes || 0);
  },

  // 改址：一个原子单元里完成「历史 + 当前地址 + 修订推进」，并处理认领。
  // projectDomain 传入项目域名：新地址必须属于该项目域名或其子域；
  // 不传时按项目行的 website/gsc_site 自行推导（调用方少传一个参数也不会绕过校验）。
  // 返回 { ok, claimedFrom?: [articleId...] }；ok=false 时带 reason。
  changeArticleUrl: async (articleId, newUrl, at, projectDomain, { planOnly = false } = {}) => {
    // 模块内的 db 是后端：所有读都直接 prepare，不能调兄弟导出函数
    const article = await db.prepare(
      'SELECT a.*, p.website AS p_website, p.gsc_site AS p_gsc_site, p.data_revision AS p_data_revision ' +
      'FROM project_articles a JOIN projects p ON p.id = a.project_id WHERE a.id = ?'
    ).get(articleId);
    if (!article) return { ok: false, reason: '文章不存在' };
    const domain = projectDomain
      || projectDomainOf(article.p_website)
      || projectDomainOf(article.p_gsc_site);
    const url = normalizeArticleUrl(newUrl, domain);
    if (!url) {
      return { ok: false, reason: '新地址必须属于当前项目域名或其子域名（支持 / 开头的站内路径）' };
    }
    if (url === article.url) return { ok: false, reason: '新地址与当前地址相同' };

    // 撞同项目另一篇的当前地址：直接拒（重复登记不自动恢复/抢占）
    const clash = await db.prepare('SELECT id FROM project_articles WHERE project_id = ? AND url = ?').get(article.project_id, url);
    if (clash && Number(clash.id) !== articleId) {
      return { ok: false, reason: '该地址已被本项目另一篇文章使用' };
    }

    // 自己历史里有这个地址（A→B→A 回归）→ 移除回归条目，不新增历史
    const ownHistory = await db.prepare(
      'SELECT id FROM project_article_url_history WHERE article_id = ? AND url = ?'
    ).get(articleId, url);

    // 别人的历史里有这个地址 → 认领：删历史方那条，双方都推进修订
    const othersHistory = await db.prepare(
      'SELECT h.article_id, a.* FROM project_article_url_history h JOIN project_articles a ON a.id = h.article_id WHERE h.project_id = ? AND h.url = ? AND h.article_id != ?'
    ).all(article.project_id, url, articleId);
    const otherIds = [...new Set(othersHistory.map((r) => Number(r.article_id)))];

    const statements = [];
    if (ownHistory) {
      statements.push(db.prepare('DELETE FROM project_article_url_history WHERE id = ?').bind(ownHistory.id));
    } else {
      statements.push(db.prepare(
        'INSERT INTO project_article_url_history (article_id, project_id, url, url_changed_at, created_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(article_id, url) DO UPDATE SET url_changed_at = excluded.url_changed_at'
      ).bind(articleId, article.project_id, article.url, at, at));
    }
    for (const oid of otherIds) {
      statements.push(db.prepare(
        'DELETE FROM project_article_url_history WHERE article_id = ? AND project_id = ? AND url = ?'
      ).bind(oid, article.project_id, url));
      // 失效相关双方：被认领方的修订也推进
      statements.push(db.prepare(
        'UPDATE project_articles SET fetch_revision = fetch_revision + 1, metrics_dirty = 1, updated_at = @at WHERE id = @id'
      ).bind({ id: oid, at }));
    }
    // 改址后旧标题失效：非人工标题清空并重新武装抓取。
    // CASE 里的 title_source 都是更新前的值，人工标题原样保留。
    statements.push(db.prepare(
      `UPDATE project_articles
       SET url = @url, fetch_revision = fetch_revision + 1, metrics_dirty = 1,
           title = CASE WHEN title_source IS NOT 'manual' THEN NULL ELSE title END,
           title_source = CASE WHEN title_source IS NOT 'manual' THEN NULL ELSE title_source END,
           title_fetch_status = CASE WHEN title_source IS NOT 'manual' THEN 'pending' ELSE title_fetch_status END,
           title_fetch_attempts = CASE WHEN title_source IS NOT 'manual' THEN 0 ELSE title_fetch_attempts END,
           title_fetch_error = CASE WHEN title_source IS NOT 'manual' THEN NULL ELSE title_fetch_error END,
           updated_at = @at
       WHERE id = @id`
    ).bind({ id: articleId, url, at }));

    const guarded = withAtomicGuard(db, statements, 'SELECT EXISTS(SELECT 1 FROM project_articles a JOIN projects p ON p.id=a.project_id WHERE a.id=? AND a.revision=? AND p.data_revision=?)', [article.id,article.revision,article.p_data_revision]);
    if (planOnly) return { ok: true, statements: guarded, article, claimedFrom: otherIds, relatedRevisions: othersHistory, historyChanges: ownHistory ? 'returned_to_previous_url' : 'saved_previous_url' };
    await db.batchAtomic(guarded);
    return { ok: true, claimedFrom: otherIds };
  },

  // 同一改址计划供协议适配层附加授权、版本及幂等守卫。
  async buildArticleUrlChangeUnit(articleId, newUrl, at, projectDomain) {
    return this.changeArticleUrl(articleId, newUrl, at, projectDomain, { planOnly: true });
  },

  // 拖拽排序：只重排属于该项目的 id
  reorderArticles: async (projectId, orderedIds, at) => {
    const rows = await db.prepare('SELECT id FROM project_articles WHERE project_id = ?').all(projectId);
    const own = new Set(rows.map((r) => r.id));
    const valid = orderedIds.filter((id) => own.has(id));
    const stmt = db.prepare('UPDATE project_articles SET sort_order = ?, updated_at = ? WHERE id = ?');
    await db.batch(valid.map((id, i) => stmt.bind(i, at, id)));
    return valid.length;
  },

  // 删除文章：月度/历史靠外键级联；显式清理没有级联外键的子表
  deleteArticle: async (articleId, at) => {
    const results = await db.batchAtomic([
      db.prepare('DELETE FROM project_article_monthly_metrics WHERE article_id = ?').bind(articleId),
      db.prepare('DELETE FROM project_article_url_history WHERE article_id = ?').bind(articleId),
      db.prepare('DELETE FROM project_articles WHERE id = ?').bind(articleId),
    ]);
    return Number(results.at(-1).changes || 0);
  },

  // 批量启停：校验归属后逐篇一个业务单元（状态 + 修订推进 + dirty）
  setArticlesStatus: async (projectId, articleIds, status, at) => {
    const ids = [...new Set((articleIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return { ok: false, reason: '没有指定文章', rejected: [] };
    const ownIds = await ownedArticleIds(db, projectId, ids);
    const rejected = ids.filter((x) => !ownIds.has(x));
    if (rejected.length) return { ok: false, reason: '这些文章不属于该项目', rejected };
    const units = ids.map((aid) => ({
      ids: [aid],
      statements: [db.prepare(
        "UPDATE project_articles SET status = @status, fetch_revision = fetch_revision + 1, metrics_dirty = 1, updated_at = @at WHERE id = @id"
      ).bind({ id: aid, status, at })],
    }));
    let updated = 0;
    const result = await runUnitBatch(units, async (u) => {
      const r = await db.batchAtomic(u.statements);
      updated += Number(r[0].changes || 0);
    });
    return { ok: result.failed.length === 0, updated, ...result };
  },

  // ============ 批量（按业务单元 + 任务03边界） ============"

  // 批量创建/更新：units 由路由装配（一个单元 = 一篇完整业务写入），
  // 大规模导入按单元分批，返回 succeeded/failed/unprocessed。
  runArticleUnits: async (units, { onFail = 'continue' } = {}) => {
    const result = await runUnitBatch(units, (u) => db.batchAtomic(u.statements), { onFail });
    return result;
  },

  // 批量删除：先校验全部归属，再按单元执行
  deleteArticles: async (projectId, articleIds, at) => {
    const ids = [...new Set((articleIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return { ok: false, reason: '没有指定文章', rejected: [] };
    const ownIds = await ownedArticleIds(db, projectId, ids);
    const rejected = ids.filter((id) => !ownIds.has(id));
    if (rejected.length) return { ok: false, reason: '这些文章不属于该项目', rejected };
    // 一个业务单元 = 一篇文章的完整删除（子表先删，不靠级联的隐式行为）
    const units = ids.map((id) => ({
      ids: [id],
      statements: [
        db.prepare('DELETE FROM project_article_monthly_metrics WHERE article_id = ?').bind(id),
        db.prepare('DELETE FROM project_article_url_history WHERE article_id = ?').bind(id),
        db.prepare('DELETE FROM project_articles WHERE id = ?').bind(id),
      ],
    }));
    // 子表级联交给外键；这里的 DELETE 只删文章行本身
    let deleted = 0;
    const result = await runUnitBatch(units, async (u) => {
      const r = await db.batchAtomic(u.statements);
      // 每个单元最后一条是文章行本身
      deleted += Number(r[r.length - 1].changes || 0);
    });
    return { ok: result.failed.length === 0, deleted, ...result };
  },
});
