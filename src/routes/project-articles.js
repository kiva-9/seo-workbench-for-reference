// project-articles.js —— 站内文章管理接口（任务06）
// 项目主页的清单切换在这里；外链清单任务12接通。所有写路径按任务03的提交边界
// 返回 succeeded/failed/unprocessed，不承诺大批量整体回滚。
//
// 静态路由必须注册在 /:aid 动态路由之前（Express 按注册顺序匹配）。
//
// 公式注入边界：源文本原样入库（首字符 = + - @ 不被改写），防注入发生在
// 导出/电子表格边界（任务13）与 DOM 转义，本层不改写用户数据。

const express = require('express');
const { validateArticleMeta } = require('../services/mcp-write');
const { wrap, parseId, badId } = require('../lib/http');
const {
  parseImportText, previewImport, normalizeArticleUrl, projectDomainOf, IMPORT_ROW_LIMIT,
  xlsxToImportText, buildArticleTemplateBytes,
} = require('../lib/article-import');
const {
  PROJECT_ARTICLE_ACTIVE_LIMIT, normalizeArticleIdList, normalizeOrderIds,
} = require('../lib/article-limits');

const ARTICLE_STATUS = ['active', 'inactive'];
const MAX_BATCH = 5000;

// 文章 URL 归属校验用的项目域名：website 优先，空则 gsc_site（域名属性也取主机）
function articleDomain(project) {
  return projectDomainOf(project?.website) || projectDomainOf(project?.gsc_site);
}

module.exports = function projectArticleRoutes({ db, assertProjectAccess }) {
  const router = express.Router();

  // 列表：服务端分页 + 搜索（1000 篇不进 DOM）
  router.get('/api/projects/:id/articles', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    // ids_only=1：只回当前筛选命中的全部 id（跨页全选用，不拉行）
    if (req.query.ids_only === '1') {
      const ids = await db.listMatchedArticleIds(id, { q: req.query.q || '', status: req.query.status || '' });
      return res.json({ ids, total: ids.length });
    }
    const { rows, total } = await db.listArticlesPaged(id, {
      q: req.query.q || '',
      status: req.query.status || '',
      page: req.query.page || 1,
      pageSize: req.query.page_size || 50,
    });
    // 行内展示「曾用：…」：一次查本页文章的曾用地址
    const history = rows.length ? await db.listUrlHistoryForArticles(rows.map((r) => r.id)) : [];
    const historyByArticle = new Map();
    for (const h of history) {
      if (!historyByArticle.has(h.article_id)) historyByArticle.set(h.article_id, []);
      historyByArticle.get(h.article_id).push(h.url);
    }
    res.json({
      rows: rows.map((r) => ({ ...r, url_history: historyByArticle.get(r.id) || [] })),
      total, page: Number(req.query.page) || 1, page_size: Math.min(Number(req.query.page_size) || 50, 100),
    });
  }));

  // 导入模板下载（XLSX，两个 sheet：填写区 + 填写说明）
  router.get('/api/projects/:id/articles/import-template.xlsx', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const buf = buildArticleTemplateBytes('站内文章');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="article-import-template.xlsx"');
    res.send(buf);
  }));

  // 批量删除（静态路径先于 /:aid 注册）
  router.post('/api/projects/:id/articles/batch-delete', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const norm = normalizeArticleIdList(req.body?.article_ids);
    if (norm.error) return res.status(400).json({ error: norm.error });
    const out = await db.deleteArticles(id, norm.ids, db.now());
    if (!out.ok && !out.failed?.length && !out.succeeded?.length) {
      return res.status(400).json({ error: out.reason || '删除失败' });
    }
    res.json(out);
  }));

  // 单篇详情（编辑弹窗用）
  router.get('/api/projects/:id/articles/:aid/meta', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '文章不存在' });
    res.json(article);
  }));

  // 曾用地址历史（改址弹窗展示）
  router.get('/api/projects/:id/articles/:aid/url-history', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '文章不存在' });
    res.json(await db.listArticleUrlHistory(aid));
  }));

  // 批量启停：先校验归属，再逐篇一个业务单元（修订推进 + dirty）
  router.post('/api/projects/:id/articles/batch-status', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const status = req.body?.status;
    if (!ARTICLE_STATUS.includes(status)) return res.status(400).json({ error: 'status 必须是 active 或 inactive' });
    const norm = normalizeArticleIdList(req.body?.article_ids);
    if (norm.error) return res.status(400).json({ error: norm.error });
    if (status === 'active') {
      const active = await db.countActiveArticles(id);
      const willActivate = await db.countArticlesByIds(id, norm.ids, 'inactive');
      if (active + willActivate > PROJECT_ARTICLE_ACTIVE_LIMIT) {
        return res.status(400).json({
          error: `每个项目最多启用 ${PROJECT_ARTICLE_ACTIVE_LIMIT} 篇文章（当前 ${active}，本次将启用 ${willActivate}）`,
        });
      }
    }
    const out = await db.setArticlesStatus(id, norm.ids, status, db.now());
    if (!out.ok && !out.failed?.length && !out.succeeded?.length) {
      return res.status(400).json({ error: out.reason || '操作失败', rejected: out.rejected || [] });
    }
    res.json(out);
  }));

  // 导入预检：只读，不写任何东西。返回分类结果 + 落地字段 + 文案师解析
  router.post('/api/projects/:id/articles/import-preview', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    // 两种输入：粘贴的文本（text）或上传的 .xlsx（base64，取「填写区」工作表）。
    // XLSX 解析在服务端做（模板结构由我们定义，读取器只认这一个工作表）。
    const xlsxB64 = String(req.body?.xlsx || '');
    const text = String(req.body?.text || '');
    let parsed;
    if (xlsxB64) {
      const buf = Buffer.from(xlsxB64, 'base64');
      if (!buf.length) return res.status(400).json({ error: 'XLSX 文件内容为空' });
      if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: '导入文件不能超过 5 MB' });
      try {
        parsed = parseImportText(xlsxToImportText(buf));
      } catch (e) {
        return res.status(400).json({ error: `XLSX 解析失败：${e.message}` });
      }
    } else {
      if (!text.trim()) return res.status(400).json({ error: '请粘贴要导入的内容' });
      parsed = parseImportText(text);
    }
    if (parsed.truncated) {
      return res.status(400).json({ error: `一次最多导入 ${IMPORT_ROW_LIMIT} 行，请分批粘贴` });
    }
    const project = await db.getProject(id);
    const existing = await db.listArticles(id);
    const existingByUrl = new Map(existing.map((a) => [a.url, a]));
    // 候选 = 全部已有账号（启用即入册）；rosterByUser: userId → copywriterId | null
    const users = await db.db.prepare('SELECT id, email FROM users WHERE deleted_at IS NULL').all();
    const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
    const roster = await db.listProjectCopywriters(id);
    const rosterByUser = new Map(roster.map((c) => [Number(c.user_id), Number(c.id)]));
    const { items, summary } = previewImport(parsed, {
      projectDomain: articleDomain(project), existingByUrl, userByEmail, rosterByUser,
    });
    res.json({ items, summary, hasHeader: parsed.hasHeader, activeLimit: PROJECT_ARTICLE_ACTIVE_LIMIT });
  }));

  // 导入确认：逐项重新校验（权限/归属/名单/目标现状），按业务单元原子执行。
  // 预览后目标变化的项进 conflicts，不执行旧覆盖意图。
  // 动作：new=插入；restored=恢复启用 + 标待刷新；update=空字段保留原值。
  router.post('/api/projects/:id/articles/import-confirm', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: '没有要执行的导入项' });
    if (items.length > MAX_BATCH) return res.status(400).json({ error: `单次最多导入 ${MAX_BATCH} 条` });
    // XLSX 上传走「预览 → 确认」同一条链：确认时不重新解析文件，items 已带落地字段

    const project = await db.getProject(id);
    const at = db.now();
    const units = [];
    const conflicts = [];
    const restored = [];
    let willActivate = 0; // 本次将新启用/恢复启用的篇数（启用上限校验用）
    const rosterUpsert = (uid) => db.db.prepare(
      'INSERT INTO project_copywriters (project_id, user_id, created_at) VALUES (@pid, @uid, @at) ' +
      'ON CONFLICT(project_id, user_id) DO UPDATE SET revoked_at = NULL WHERE project_copywriters.revoked_at IS NOT NULL'
    ).bind({ pid: id, uid, at });
    // 名单 id 子查询：同一原子单元内先补建名单行，文章/更新语句再按 user_id 取 id
    const rosterIdSub = '(SELECT id FROM project_copywriters WHERE project_id = @pid AND user_id = @cwUser)';

    for (const it of items) {
      if (it.action !== 'new' && it.action !== 'update' && it.action !== 'restored') continue; // duplicate/invalid 不执行
      const url = normalizeArticleUrl(it.url, articleDomain(project));
      if (!url) { conflicts.push({ lineNo: it.lineNo, url: it.url, reason: 'URL 格式不支持或不属于本项目域名' }); continue; }

      let copywriterId = null;   // 已在册：直接绑 id
      let rosterUserId = null;   // 账号在但不在册：单元内补建后按 user_id 取 id
      if (it.copywriter?.user_id) {
        const row = await db.findProjectCopywriterByUser(id, it.copywriter.user_id);
        if (row && !row.revoked_at) copywriterId = Number(row.id);
        else if (row && row.revoked_at) rosterUserId = it.copywriter.user_id; // 复册
        else rosterUserId = it.copywriter.user_id; // 新建名单行
      }

      if (it.action === 'new') {
        // 重新校验：URL 没被占（预览后可能变化）+ 启用上限
        const clash = await db.findArticleByUrl(id, url);
        if (clash) { conflicts.push({ lineNo: it.lineNo, url, reason: '该地址已存在（预览后发生变化）' }); continue; }
        willActivate++;
        const named = {
          pid: id, url,
          title: it.fields?.title || '', keyword: it.fields?.keyword || '', notes: it.fields?.notes || '',
          pub: it.fields?.published_at || null, at,
          // 导入显式填了标题 = 人工维护，抓取不覆盖
          titleSource: it.fields?.title ? 'manual' : null,
        };
        const stmts = [];
        if (rosterUserId) {
          stmts.push(rosterUpsert(rosterUserId));
          named.cwUser = rosterUserId;
          stmts.push(db.db.prepare(
            `INSERT INTO project_articles
              (project_id, url, title, title_source, keyword, notes, published_at, copywriter_id, status, sort_order,
               fetch_revision, metrics_dirty, created_at, updated_at)
             VALUES (@pid, @url, @title, @titleSource, @keyword, @notes, @pub, ${rosterIdSub}, 'active',
               (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_articles WHERE project_id = @pid),
               1, 1, @at, @at)`
          ).bind(named));
        } else {
          named.cw = copywriterId;
          stmts.push(db.db.prepare(
            `INSERT INTO project_articles
              (project_id, url, title, title_source, keyword, notes, published_at, copywriter_id, status, sort_order,
               fetch_revision, metrics_dirty, created_at, updated_at)
             VALUES (@pid, @url, @title, @titleSource, @keyword, @notes, @pub, @cw, 'active',
               (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_articles WHERE project_id = @pid),
               1, 1, @at, @at)`
          ).bind(named));
        }
        units.push({ ids: [url], statements: stmts });
        continue;
      }

      // update / restored：目标必须还在、URL 未变；空字段保留原值（显式清空走编辑接口）
      const target = await db.getArticle(it.article_id);
      if (!target || target.project_id !== id) {
        conflicts.push({ lineNo: it.lineNo, url, reason: '目标文章不存在或已移属' });
        continue;
      }
      if (target.url !== url) {
        conflicts.push({ lineNo: it.lineNo, url, reason: '目标文章地址已变化，请重新预览' });
        continue;
      }
      const fields = [];
      const named = { id: target.id, at };
      for (const k of ['title', 'keyword', 'notes', 'published_at']) {
        const v = it.fields?.[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') { fields.push(`${k} = @${k}`); named[k] = String(v).trim(); }
      }
      if (named.title !== undefined) {
        // 显式填标题 → 人工来源（抓取不覆盖）；同时清掉旧的抓取状态
        fields.push("title_source = 'manual'", 'title_fetch_status = NULL', 'title_fetch_error = NULL');
      }
      if (rosterUserId) {
        fields.push(`copywriter_id = ${rosterIdSub}`);
        named.pid = id;
        named.cwUser = rosterUserId;
      } else if (copywriterId !== null) {
        fields.push('copywriter_id = @cw');
        named.cw = copywriterId;
      }
      if (it.action === 'restored') {
        // 恢复启用：推进取数修订 + 标待刷新
        fields.push("status = 'active'", 'fetch_revision = fetch_revision + 1', 'metrics_dirty = 1', 'last_error = NULL');
        restored.push(target.id);
      }
      if (!fields.length) continue; // 没有可写字段（空单元格保留原值）→ 跳过
      fields.push('updated_at = @at');
      const stmts = [];
      if (rosterUserId) stmts.push(rosterUpsert(rosterUserId));
      stmts.push(db.db.prepare(`UPDATE project_articles SET ${fields.join(', ')} WHERE id = @id`).bind(named));
      units.push({ ids: [url], statements: stmts });
    }

    // 启用上限：新启用 + 恢复启用一起算，写入前拒绝（不静默裁剪）
    if (willActivate || restored.length) {
      const active = await db.countActiveArticles(id);
      if (active + willActivate + restored.length > PROJECT_ARTICLE_ACTIVE_LIMIT) {
        return res.status(400).json({
          error: `每个项目最多启用 ${PROJECT_ARTICLE_ACTIVE_LIMIT} 篇文章（当前 ${active}，本次将启用 ${willActivate + restored.length}），请先停用部分文章`,
        });
      }
    }

    let committed = 0;
    const result = await db.runArticleUnits(units);
    // 统计真正写入的篇数（update 的 changes + new 的插入）
    res.json({
      ok: result.failed.length === 0 && conflicts.length === 0,
      committed: units.length - result.failed.length - result.unprocessed.length,
      restored: restored.length,
      succeeded: result.succeeded, failed: result.failed, unprocessed: result.unprocessed,
      conflicts,
    });
  }));

  // 新增（单条 {url,...} 或批量 {articles:[...]}）
  router.post('/api/projects/:id/articles', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const body = req.body || {};
    const items = Array.isArray(body.articles) ? body.articles : [{ url: body.url, ...body }];
    if (items.length > MAX_BATCH) return res.status(400).json({ error: `单次最多 ${MAX_BATCH} 条` });

    const project = await db.getProject(id);
    const at = db.now();
    const units = [];
    const invalid = [];
    let willActivate = 0;
    for (const it of items) {
      const url = normalizeArticleUrl(it?.url, articleDomain(project));
      if (!url) {
        invalid.push({ url: String(it?.url ?? ''), reason: String(it?.url ?? '').trim()
          ? 'URL 不属于本项目域名或其子域名（或格式不受支持）'
          : 'URL 为空' });
        continue;
      }
      const clash = await db.findArticleByUrl(id, url);
      if (clash) { invalid.push({ url, reason: '该地址已存在' }); continue; }
      let copywriterId = null;
      const cwRef = it?.copywriter_id;
      if (cwRef !== undefined && cwRef !== null && cwRef !== '') {
        const cid = parseId(cwRef);
        if (!cid) { invalid.push({ url, reason: 'copywriter_id 无效' }); continue; }
        const item = await db.findProjectCopywriter(id, cid);
        if (!item) { invalid.push({ url, reason: '文案师名单项不存在或不属于该项目' }); continue; }
        if (item.revoked_at) { invalid.push({ url, reason: '该文案师已移出本项目' }); continue; }
        copywriterId = cid;
      }
      willActivate++;
      // 单条新增要求文案师已在册（导入路径才有「确认后原子补建名单」）
      const stmts = [];
      stmts.push(db.db.prepare(
        `INSERT INTO project_articles
          (project_id, url, title, title_source, keyword, notes, published_at, copywriter_id, status, sort_order,
           fetch_revision, metrics_dirty, created_at, updated_at)
         VALUES (@pid, @url, @title, @titleSource, @keyword, @notes, @pub, @cw, 'active',
           (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_articles WHERE project_id = @pid),
           1, 1, @at, @at)`
      ).bind({
        pid: id, url,
        title: String(it?.title ?? '').trim(),
        titleSource: String(it?.title ?? '').trim() ? 'manual' : null,
        keyword: String(it?.keyword ?? '').trim(),
        notes: String(it?.notes ?? '').trim(), pub: it?.published_at ? String(it.published_at).trim() : null,
        cw: copywriterId, at,
      }));
      units.push({ ids: [url], statements: stmts });
    }
    // 启用上限写入前校验（不静默裁剪）
    if (willActivate) {
      const active = await db.countActiveArticles(id);
      if (active + willActivate > PROJECT_ARTICLE_ACTIVE_LIMIT) {
        return res.status(400).json({
          error: `每个项目最多启用 ${PROJECT_ARTICLE_ACTIVE_LIMIT} 篇文章（当前 ${active}，本次将新增 ${willActivate}）`,
        });
      }
    }
    const result = await db.runArticleUnits(units);
    res.json({
      created: units.length - result.failed.length,
      succeeded: result.succeeded, failed: result.failed, unprocessed: result.unprocessed,
      invalid,
    });
  }));

  // 拖拽排序（静态路径先注册）
  router.put('/api/projects/:id/articles/order', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const norm = normalizeOrderIds(req.body?.ids);
    if (norm.error) return res.status(400).json({ error: norm.error });
    const updated = await db.reorderArticles(id, norm.ids, db.now());
    res.json({ ok: true, updated });
  }));

  // 元数据 + 文案师指派（都不推进取数修订）
  router.put('/api/projects/:id/articles/:aid', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '文章不存在' });

    const body = req.body || {};
    const patch = {};
    for (const k of ['title', 'keyword', 'notes']) {
      if (k in body) patch[k] = String(body[k] ?? '').trim();
    }
    if ('published_at' in body) {
      const v = body.published_at ? String(body.published_at).trim() : null;
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return res.status(400).json({ error: '发布日期格式应为 YYYY-MM-DD' });
      patch.published_at = v;
    }
    if ('copywriter_id' in body) {
      const raw = body.copywriter_id;
      if (raw === null || raw === '') patch.copywriter_id = null;
      else {
        const cid = parseId(raw);
        if (!cid) return res.status(400).json({ error: 'copywriter_id 无效' });
        const item = await db.findProjectCopywriter(id, cid);
        if (!item) return res.status(400).json({ error: '文案师名单项不存在或不属于该项目' });
        if (item.revoked_at) return res.status(400).json({ error: '该文案师已移出本项目，不能新指派' });
        patch.copywriter_id = cid;
      }
    }
    const meta = Object.fromEntries(Object.entries(patch).filter(([field]) => field !== 'copywriter_id'));
    try { Object.assign(patch, validateArticleMeta('internal', meta)); }
    catch (e) { return res.status(400).json({ error: e.issues?.[0]?.message || e.message }); }
    const changed = await db.updateArticleMeta(aid, patch, db.now());
    res.json(await db.getArticle(aid));
  }));

  // 改址：历史 + 当前地址 + 修订推进同一个原子单元；认领变化失效双方
  router.put('/api/projects/:id/articles/:aid/url', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '文章不存在' });
    const project = await db.getProject(id);
    const out = await db.changeArticleUrl(aid, req.body?.url, db.now(), articleDomain(project));
    if (!out.ok) return res.status(400).json({ error: out.reason });
    res.json({ ok: true, claimed_from: out.claimedFrom || [] });
  }));

  // 启停
  router.put('/api/projects/:id/articles/:aid/status', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '文章不存在' });
    const status = req.body?.status;
    if (!ARTICLE_STATUS.includes(status)) return res.status(400).json({ error: 'status 必须是 active 或 inactive' });
    if (status === 'active' && article.status !== 'active') {
      const active = await db.countActiveArticles(id);
      if (active + 1 > PROJECT_ARTICLE_ACTIVE_LIMIT) {
        return res.status(400).json({ error: `每个项目最多启用 ${PROJECT_ARTICLE_ACTIVE_LIMIT} 篇文章（当前 ${active}）` });
      }
    }
    const changed = await db.setArticleStatus(aid, status, db.now());
    res.json(await db.getArticle(aid));
  }));

  // 删除单篇（子表 + 文章行一个原子单元）
  router.delete('/api/projects/:id/articles/:aid', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '文章不存在' });
    const deleted = await db.deleteArticle(aid, db.now());
    res.json({ ok: true, deleted });
  }));

  return router;
};
