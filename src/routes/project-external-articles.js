// project-external-articles.js —— 外链文章管理接口（任务12：CRUD/导入/批量；
// 启停与改域名在任务11 已提供，这里复用）。所有写路径按任务03 的提交边界反馈；
// 停用/改域名走 db.disableArticle / db.changeArticleDomain 的原子单元，不搞临时 PATCH。

const express = require('express');
const { validateArticleMeta, normalizeExternalUrl: sharedExternalUrl, normalizePlatformDomain } = require('../services/mcp-write');
const { wrap, parseId, badId } = require('../lib/http');
const { parseImportText, previewImport, normalizeExternalDomain, xlsxToImportText, buildExternalArticleTemplateBytes } = require('../lib/article-import');
const { normalizeDomain } = require('../lib/domain');

const MAX_BATCH = 5000;
// 外链必须是合法绝对 URL（站内才允许相对路径）
function normalizeExternalUrl(raw) {
  const url = String(raw ?? '').trim();
  return url.length <= 2048 ? sharedExternalUrl(url) : null;
}

module.exports = function projectExternalArticleRoutes({ db, assertProjectAccess }) {
  const router = express.Router();

  // ============ 管理清单（服务端分页/搜索；停用记录也可管理） ============
  router.get('/api/projects/:id/external-articles', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const out = await db.listExternalArticlesPaged(id, {
      q: req.query.q || '', status: req.query.status || '',
      page: req.query.page || 1, pageSize: req.query.page_size || 50,
    });
    res.json(out);
  }));

  // 导入模板下载（XLSX，两个 sheet：填写区 + 填写说明）。必须注册在 /:aid 之前，
  // 不然 import-template.xlsx 会被当成文章 id 解析掉。
  router.get('/api/projects/:id/external-articles/import-template.xlsx', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const buf = buildExternalArticleTemplateBytes('站外文章');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="external-article-import-template.xlsx"');
    res.send(buf);
  }));

  router.get('/api/projects/:id/external-articles/:aid', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getExternalArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '外链文章不存在' });
    res.json(article);
  }));

  // ============ 新增 ============
  router.post('/api/projects/:id/external-articles', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const url = normalizeExternalUrl(req.body?.url);
    if (!url) return res.status(400).json({ error: 'URL 需以 http(s):// 开头' });
    if (await db.findExternalArticleByUrl(id, url)) {
      return res.status(409).json({ error: '该 URL 已在本项目登记' });
    }
    const cid = await resolveCopywriter(id, req.body?.copywriter_id, res);
    if (cid === false) return;
    const publishedAt = String(req.body?.published_at || '').trim();
    if (publishedAt && !/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) {
      return res.status(400).json({ error: '发布日期格式应为 YYYY-MM-DD' });
    }
    let metadata;
    try { metadata = validateArticleMeta('external', { title: String(req.body?.title || '').trim(), anchor_text: String(req.body?.anchor_text || '').trim(), notes: String(req.body?.notes || '').trim(), published_at: publishedAt || null }); }
    catch (e) { return res.status(400).json({ error: e.issues?.[0]?.message || e.message }); }
    for(const field of ['title','anchor_text','notes'])if(metadata[field]==='')metadata[field]=null;
    const aid = await db.createExternalArticle(id, {
      ...metadata,
      url,
      copywriter_id: cid,
    }, db.now());
    res.status(201).json(await db.getExternalArticle(aid));
  }));

  // ============ 编辑元数据 ============
  router.put('/api/projects/:id/external-articles/:aid', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getExternalArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '外链文章不存在' });
    const body = req.body || {};
    const patch = {};
    for (const k of ['title', 'anchor_text', 'notes']) {
      if (k in body) patch[k] = String(body[k] ?? '').trim() || null;
    }
    if ('published_at' in body) {
      const v = String(body.published_at || '').trim();
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return res.status(400).json({ error: '发布日期格式应为 YYYY-MM-DD' });
      patch.published_at = v || null;
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
    const metadata = Object.fromEntries(Object.entries(patch).filter(([field]) => field !== 'copywriter_id').map(([field,value]) => [field, field === 'published_at' ? value : (value ?? '')]));
    try { Object.assign(patch, validateArticleMeta('external', metadata)); }
    catch (e) { return res.status(400).json({ error: e.issues?.[0]?.message || e.message }); }
    for(const field of ['title','anchor_text','notes'])if(patch[field]==='')patch[field]=null;
    await db.updateExternalArticle(aid, patch, db.now());
    res.json(await db.getExternalArticle(aid));
  }));

  // ============ 改 URL（换平台时先冻结旧段再开新段） ============
  router.put('/api/projects/:id/external-articles/:aid/url', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getExternalArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '外链文章不存在' });
    const url = normalizeExternalUrl(req.body?.url);
    if (!url) return res.status(400).json({ error: 'URL 需以 http(s):// 开头' });
    try {
      const out = await db.buildExternalUrlChangeUnit(aid, url, db.now());
      if (!out.ok) return res.status(409).json({ error: out.reason });
      if (out.statements?.length) await db.db.batchAtomic(out.statements);
      res.json(await db.getExternalArticle(aid));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }));

  // ============ 删除（平台最后一条时清理平台数据） ============
  router.delete('/api/projects/:id/external-articles/:aid', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getExternalArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '外链文章不存在' });
    const out = await db.deleteExternalArticle(aid);
    if (!out.ok) return res.status(404).json({ error: '外链文章不存在' });
    res.json({ ok: true, cleanedPlatform: out.cleanedPlatform });
  }));

  // ============ 批量指派 / 启停 / 删除（按业务单元反馈） ============
  router.post('/api/projects/:id/external-articles/batch-assign', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const ids = (req.body?.article_ids || []).map(parseId).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'article_ids 必须是非空数组' });
    const raw = req.body?.copywriter_id;
    const cid = raw === null || raw === '' ? null : parseId(raw);
    if (raw !== null && raw !== '' && !cid) return res.status(400).json({ error: 'copywriter_id 无效' });
    const out = await db.assignExternalArticles(id, ids, cid, req.body?.mode || 'fill_empty', db.now());
    if (!out.ok) return res.status(400).json({ error: out.reason, rejected: out.rejected || [] });
    res.json({ ok: true, updated: out.updated });
  }));

  router.post('/api/projects/:id/external-articles/batch-status', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const ids = (req.body?.article_ids || []).map(parseId).filter(Boolean);
    const status = req.body?.status;
    if (!ids.length) return res.status(400).json({ error: 'article_ids 必须是非空数组' });
    if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: 'status 必须是 active 或 inactive' });
    const succeeded = [];
    const failed = [];
    for (const aid of ids) {
      const article = await db.getExternalArticle(aid);
      if (!article || article.project_id !== id) { failed.push({ id: aid, reason: '文章不存在或不属于该项目' }); continue; }
      if (article.status === status) { succeeded.push(aid); continue; }
      const out = status === 'inactive' ? await db.disableArticle(aid, {}) : await db.resumeArticle(aid, {});
      if (out.ok) succeeded.push(aid);
      else failed.push({ id: aid, reason: out.reason });
    }
    res.json({ ok: failed.length === 0, succeeded, failed });
  }));

  router.post('/api/projects/:id/external-articles/batch-delete', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const ids = (req.body?.article_ids || []).map(parseId).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'article_ids 必须是非空数组' });
    const succeeded = [];
    const failed = [];
    const cleanedDomains = []; // 平台最后一条被删 → 该平台日数据/月状态已清理（提示用）
    for (const aid of ids) {
      const article = await db.getExternalArticle(aid);
      if (!article || article.project_id !== id) { failed.push({ id: aid, reason: '文章不存在或不属于该项目' }); continue; }
      const out = await db.deleteExternalArticle(aid);
      if (out.ok) { succeeded.push(aid); if (out.cleanedPlatform) cleanedDomains.push(article.domain); }
      else failed.push({ id: aid, reason: out.reason || '删除失败' });
    }
    res.json({ ok: failed.length === 0, succeeded, failed, cleanedDomains: [...new Set(cleanedDomains)] });
  }));

  // ============ 批量导入（TSV/CSV/XLSX；预检零写 → 确认逐项重验） ============
  router.post('/api/projects/:id/external-articles/import-preview', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    // 两种输入：粘贴的文本（text）或上传的 .xlsx（base64），与站内导入同一套口径
    const xlsxB64 = String(req.body?.xlsx || '');
    const text = String(req.body?.text || '');
    let parsed;
    if (xlsxB64) {
      const buf = Buffer.from(xlsxB64, 'base64');
      if (!buf.length) return res.status(400).json({ error: 'XLSX 文件内容为空' });
      if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: '导入文件不能超过 5 MB' });
      try {
        parsed = parseImportText(xlsxToImportText(buf), { domain: true });
      } catch (e) {
        return res.status(400).json({ error: `XLSX 解析失败：${e.message}` });
      }
    } else {
      if (!text.trim()) return res.status(400).json({ error: '请粘贴要导入的内容' });
      parsed = parseImportText(text, { domain: true });
    }
    const existing = await db.listExternalArticles(id);
    const existingByUrl = new Map(existing.map((a) => [a.url, a]));
    const users = await db.db.prepare('SELECT id, email FROM users WHERE deleted_at IS NULL').all();
    const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
    const roster = await db.listProjectCopywriters(id);
    const rosterByUser = new Map(roster.map((c) => [Number(c.user_id), Number(c.id)]));
    // 复用站内导入的分类（external 模式：任意域名绝对地址，不做项目域名归属校验）
    const { items, summary } = previewImport(parsed, { external: true, existingByUrl, userByEmail, rosterByUser });
    const fixed = {
      new: 0, restored: 0, update: 0, duplicate: 0, invalid: 0,
      enableCopywriter: summary.enableCopywriter || 0, missingPublishedAt: summary.missingPublishedAt || 0,
    };
    for (const it of items) fixed[it.action]++;
    res.json({ items, summary: fixed, hasHeader: parsed.hasHeader });
  }));

  router.post('/api/projects/:id/external-articles/import-confirm', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: '没有要执行的导入项' });
    if (items.length > MAX_BATCH) return res.status(400).json({ error: `单次最多导入 ${MAX_BATCH} 条` });
    const at = db.now();
    // 恢复已停用文章需要显式开关：导入是批量动作，默认不该把用户停掉的平台悄悄拉回来
    const restoreInactive = req.body?.restoreInactive === true;
    const succeeded = [];
    const failed = [];
    const conflicts = [];
    const skipped = [];
    for (const it of items) {
      if (it.action === 'restored' && !restoreInactive) {
        skipped.push({ lineNo: it.lineNo, url: it.url, reason: '匹配到已停用文章，未勾选「同时恢复」已跳过' });
        continue;
      }
      if (it.action !== 'new' && it.action !== 'update' && it.action !== 'restored') continue;
      const url = normalizeExternalUrl(it.url);
      if (!url) { conflicts.push({ lineNo: it.lineNo, url: it.url, reason: '外链必须是 http(s):// 绝对地址' }); continue; }
      // 逐项重验：被抢占 / 目标变化 → 冲突，不执行旧意图
      const clash = await db.findExternalArticleByUrl(id, url);
      if (it.action === 'new' && clash) { conflicts.push({ lineNo: it.lineNo, url, reason: '该地址已存在（预览后发生变化）' }); continue; }
      if (it.action === 'update' || it.action === 'restored') {
        const target = await db.getExternalArticle(it.article_id);
        if (!target || target.project_id !== id || target.url !== url) {
          conflicts.push({ lineNo: it.lineNo, url, reason: '目标文章不存在或地址已变化，请重新预览' });
          continue;
        }
        if (it.action === 'restored' && target.status !== 'inactive') {
          conflicts.push({ lineNo: it.lineNo, url, reason: '目标文章已恢复启用（预览后发生变化）' });
          continue;
        }
      }
      // 文案师：账号在但不在名单 → 先补建名单行再指派
      let copywriterId = null;
      if (it.copywriter && it.copywriter.user_id) {
        const item = await db.findProjectCopywriterByUser(id, it.copywriter.user_id);
        if (!item || item.revoked_at) {
          copywriterId = (await db.enableCopywriter(id, it.copywriter.user_id, at)).id;
        } else copywriterId = Number(item.id);
      }
      // 平台域名：填了才覆盖（空单元格保留原值，与标题/日期同一口径）
      const rawDomain = it.fields?.domain;
      const domain = rawDomain ? normalizeExternalDomain(rawDomain) : '';
      try {
        if (it.action === 'new') {
          await db.createExternalArticle(id, {
            url, title: it.fields?.title || null, anchor_text: it.fields?.anchor_text || null,
            notes: it.fields?.notes || null, published_at: it.fields?.published_at || null,
            domain: domain || null, domain_source: domain ? 'manual' : 'auto',
            copywriter_id: copywriterId,
          }, at);
        } else if (it.action === 'restored') {
          const patch = {};
          for (const k of ['title', 'notes', 'published_at', 'anchor_text']) {
            const v = it.fields?.[k];
            if (v !== undefined && v !== null && String(v).trim() !== '') patch[k] = String(v).trim();
          }
          if (copywriterId) patch.copywriter_id = copywriterId;
          await db.updateExternalArticle(it.article_id, patch, at);
          // 恢复 = 原子单元（开新活跃段 + 标 dirty）。带来源域名时走改域名单元，
          // 它内部已经重新启用，不需要也不允许再 resume 一次。
          const target = await db.getExternalArticle(it.article_id);
          if (domain && target.domain !== domain) {
            const out = await db.changeArticleDomain(it.article_id, domain);
            if (!out.ok) throw new Error(out.reason || '域名切换失败');
          } else {
            const out = await db.resumeArticle(it.article_id, {});
            if (!out.ok) {
              const after = await db.getExternalArticle(it.article_id);
              if (after.status !== 'active') throw new Error(out.reason || '恢复未生效');
            }
          }
        } else {
          const patch = {};
          for (const k of ['title', 'notes', 'published_at', 'anchor_text']) {
            const v = it.fields?.[k];
            if (v !== undefined && v !== null && String(v).trim() !== '') patch[k] = String(v).trim();
          }
          if (copywriterId) patch.copywriter_id = copywriterId;
          await db.updateExternalArticle(it.article_id, patch, at);
          if (domain) {
            const target = await db.getExternalArticle(it.article_id);
            if (target.domain !== domain) {
              const out = await db.changeArticleDomain(it.article_id, domain);
              if (!out.ok) throw new Error(out.reason || '域名切换失败');
            }
          }
        }
        succeeded.push(url);
      } catch (e) {
        failed.push({ lineNo: it.lineNo, url, reason: String(e.message || e) });
      }
    }
    // 被跳过的行没有任何写入，不需要标 dirty（恢复/新增的原子单元自己会推进修订）
    res.json({ ok: failed.length === 0 && conflicts.length === 0, succeeded, failed, conflicts, skipped });
  }));

  // ============ 启停 / 改域名（任务11 提供，这里挂管理路由） ============
  router.put('/api/projects/:id/external-articles/:aid/status', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getExternalArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '外链文章不存在' });
    const status = req.body?.status;
    if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: 'status 必须是 active 或 inactive' });
    if (status === article.status) return res.status(409).json({ error: `该外链已是${status === 'active' ? '活跃' : '停用'}状态` });
    const out = status === 'inactive' ? await db.disableArticle(aid, {}) : await db.resumeArticle(aid, {});
    if (!out.ok) return res.status(409).json({ error: out.reason });
    res.json({ ok: true, ...(out.meta ? { freeze: out.meta } : {}) });
  }));

  router.put('/api/projects/:id/external-articles/:aid/domain', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getExternalArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '外链文章不存在' });
    const raw = normalizePlatformDomain(String(req.body?.domain || '').trim());
    if (!raw) return res.status(400).json({ error: '平台域名格式无效' });
    const out = await db.changeArticleDomain(aid, raw, {});
    if (!out.ok) return res.status(409).json({ error: out.reason });
    res.json({ ok: true, domain: raw });
  }));

  // 文案师 id 校验助手：返回 number | null(不指派) | false(已写错误响应)
  async function resolveCopywriter(projectId, raw, res) {
    if (raw === undefined || raw === null || raw === '') return null;
    const cid = parseId(raw);
    if (!cid) { res.status(400).json({ error: 'copywriter_id 无效' }); return false; }
    const item = await db.findProjectCopywriter(projectId, cid);
    if (!item) { res.status(400).json({ error: '文案师名单项不存在或不属于该项目' }); return false; }
    if (item.revoked_at) { res.status(400).json({ error: '该文案师已移出本项目，不能新指派' }); return false; }
    return cid;
  }

  return router;
};
