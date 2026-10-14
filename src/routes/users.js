// users.js —— 当前用户 + 用户管理（改角色仅管理员）

const express = require('express');
const { wrap, parseId, badId } = require('../lib/http');
const { requireAdmin } = require('../middleware/current-user');

module.exports = function userRoutes({ db }) {
  const router = express.Router();

  router.get('/api/me', (req, res) => {
    res.json({ ...req.user, logout_url: req.logoutUrl });
  });

  router.get('/api/users', requireAdmin, wrap(async (req, res) => {
    res.json(await db.listUsers());
  }));

  router.get('/api/users/deleted', requireAdmin, wrap(async (req, res) => {
    res.json(await db.listDeletedUsers());
  }));

  router.post('/api/users/:id/restore', requireAdmin, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!await db.getDeletedUser(id)) {
      if (await db.getUser(id)) return res.status(409).json({ error: '账号未删除或已恢复，请刷新账号列表' });
      return res.status(404).json({ error: '用户不存在' });
    }
    res.json(await db.restoreDeletedUser(id, req.user.id));
  }));

  router.put('/api/users/:id', requireAdmin, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    const target = await db.getUser(id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    const body = req.body || {};
    const hasRole = body.role !== undefined;
    const hasName = 'name' in body;
    if (!hasRole && !hasName) return res.status(400).json({ error: '没有要更新的字段' });
    if (hasRole) {
      const role = body.role;
      if (role !== 'member' && role !== 'admin') return res.status(400).json({ error: 'role 必须是 member 或 admin' });
      // 不许把最后一个 admin 降级——没有其他管理员的话，降级之后没人能再把任何人升回 admin
      if (target.role === 'admin' && role === 'member') {
        const users = await db.listUsers();
        const adminCount = users.filter((u) => u.role === 'admin').length;
        if (adminCount <= 1) return res.status(400).json({ error: '这是最后一个管理员，不能降级，请先把别人设成管理员' });
      }
    }
    // 显示名：账号-名字关联（文案师名单/候选/指派界面显示）。空串 = 清空，回落邮箱
    await db.updateActiveUser(id, req.user.id, { ...(hasRole ? { role: body.role } : {}), ...(hasName ? { name: body.name } : {}) });
    res.json(await db.getUser(id));
  }));

  router.get('/api/users/:id/deletion-preview', requireAdmin, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!await db.getUser(id)) return res.status(404).json({ error: '用户不存在' });
    res.json(await db.userDeletionImpact(id));
  }));

  router.delete('/api/users/:id', requireAdmin, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (id === req.user.id) return res.status(400).json({ error: '不能删除当前登录账号' });
    const target = await db.getUser(id);
    if (!target) return res.status(404).json({ error: '用户不存在或已删除' });
    const recipientValue = req.body?.transfer_to_user_id;
    const recipientId = Number.isSafeInteger(recipientValue) ? parseId(recipientValue) : null;
    if (!recipientId || recipientId === id) return res.status(400).json({ error: '请选择其他账号接收数据' });
    const recipient = await db.getUser(recipientId);
    if (!recipient) return res.status(400).json({ error: '接收账号不存在或已删除，请重新选择' });
    if (target.role === 'admin' && (await db.listUsers()).filter(user => user.role === 'admin').length <= 1) {
      return res.status(400).json({ error: '这是最后一个管理员，不能删除' });
    }
    const transferred = await db.deleteUserAndTransfer(id, recipientId, req.user.id);
    res.json({ deleted_user_id: id, transfer_to_user_id: recipientId, transferred });
  }));

  return router;
};
