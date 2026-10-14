// links.js —— 链接库：挂在项目下的链接 + 个人收藏，支持标签过滤和搜索

const express = require('express');
const { wrap, parseId, badId } = require('../lib/http');
const { validateBusinessFields } = require('../services/mcp-write');

// tags 字段库里是逗号分隔的字符串，转成数组给前端
const withTagArray = (row) => ({
  ...row,
  tags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
});

module.exports = function linkRoutes({ db, assertProjectAccess }) {
  const router = express.Router();

  // 链接访问校验：project_id 有值时看项目权限，没有（个人收藏）时看 links.owner_user_id。
  async function assertLinkAccess(req, res, link) {
    const isAdmin = req.user.role === 'admin';
    if (link.project_id) {
      if (!(await db.canAccessProject(link.project_id, req.user.id, isAdmin))) {
        res.status(403).json({ error: '无权访问该链接' });
        return false;
      }
      return true;
    }
    if (!isAdmin && link.owner_user_id !== req.user.id) {
      res.status(403).json({ error: '无权访问该链接' });
      return false;
    }
    return true;
  }

  // 列表：支持按项目过滤、按标签过滤、搜索
  router.get('/api/links', wrap(async (req, res) => {
    const projectId = req.query.project_id === undefined ? 'all'
      : (req.query.project_id === '' || req.query.project_id === 'null' ? null
         : parseId(req.query.project_id));
    if (req.query.project_id && req.query.project_id !== 'all' && req.query.project_id !== '' && req.query.project_id !== 'null' && !projectId) {
      return badId(res);
    }
    if (typeof projectId === 'number' && !(await assertProjectAccess(req, res, projectId))) return;
    const ownerScope = { ownerUserId: req.user.id, isAdmin: req.user.role === 'admin' };
    const opts = {
      search: req.query.q || '',
      tag: req.query.tag || '',
      limit: Number(req.query.limit) || 500,
      ...ownerScope,
    };
    const rows = await db.listLinks(projectId, opts);
    // 三态原样透传：'all' / null(个人收藏) / 项目 id
    const allTags = await db.listLinkTags(projectId, ownerScope);
    res.json({
      projectId: projectId === 'all' ? null : projectId,
      rows: rows.map(withTagArray),
      allTags,
    });
  }));

  // 新建链接
  router.post('/api/links', wrap(async (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    const url = String(b.url || '').trim();
    if (!title) return res.status(400).json({ error: '标题必填' });
    if (!url) return res.status(400).json({ error: '链接必填' });

    const projectId = b.project_id ? parseId(b.project_id) : null;
    if (b.project_id && !projectId) return badId(res);
    if (projectId && !(await assertProjectAccess(req, res, projectId))) return;

    let data;
    try { data = validateBusinessFields('link', {
      project_id: projectId,
      title,
      url,
      tags: Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(','),
      notes: String(b.notes || ''),
    }); } catch (e) { return res.status(400).json({ error: e.issues?.[0]?.message || e.message }); }
    const id = await db.createLink({ ...data, owner_user_id: req.user.id });
    res.status(201).json(withTagArray(await db.getLink(id)));
  }));

  // 编辑链接
  router.put('/api/links/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    const existing = await db.getLink(id);
    if (!existing) return res.status(404).json({ error: '链接不存在' });
    if (!(await assertLinkAccess(req, res, existing))) return;
    const b = req.body || {};
    const data = {};
    if ('title' in b) {
      const v = String(b.title || '').trim();
      if (!v) return res.status(400).json({ error: '标题必填' });
      data.title = v;
    }
    if ('url' in b) {
      const v = String(b.url || '').trim();
      if (!v) return res.status(400).json({ error: '链接必填' });
      data.url = v;
    }
    if ('project_id' in b) {
      data.project_id = b.project_id ? parseId(b.project_id) : null;
      if (b.project_id && !data.project_id) return badId(res);
      if (data.project_id && !(await assertProjectAccess(req, res, data.project_id))) return;
    }
    if ('tags' in b) {
      data.tags = Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',');
    }
    if ('notes' in b) data.notes = String(b.notes || '');
    let normalized;
    try { normalized = validateBusinessFields('link', data, { partial: true }); }
    catch (e) { return res.status(400).json({ error: e.issues?.[0]?.message || e.message }); }
    await db.updateLink(id, normalized);
    res.json(withTagArray(await db.getLink(id)));
  }));

  // 删除链接
  router.delete('/api/links/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    const existing = await db.getLink(id);
    if (!existing) return res.status(404).json({ error: '链接不存在' });
    if (!(await assertLinkAccess(req, res, existing))) return;
    await db.deleteLink(id);
    res.json({ ok: true });
  }));

  return router;
};
