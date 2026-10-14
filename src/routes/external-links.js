// external-links.js —— 我发的外链：用户主动登记外链 URL，再用 GA4 反查每条外链带来的会话/关键事件

const express = require('express');
const { wrap, parseId, badId, retired } = require('../lib/http');

module.exports = function externalLinkRoutes({ db, google, config, assertProjectAccess }) {
  const router = express.Router();

  // 列出某个项目的外链登记
  router.get('/api/projects/:id/external-links', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    res.json(await db.listExternalLinks(id));
  }));

  // 列出所有项目的外链登记（汇总视图用，带项目名）
  router.get('/api/external-links', wrap(async (req, res) => {
    res.json(await db.listAllExternalLinks({ ownerUserId: req.user.id, isAdmin: req.user.role === 'admin' }));
  }));


  // 旧写接口退役（任务14）：外链登记/删除/反查统一走
  // /api/projects/:id/external-articles 与 /api/projects/:id/fetch-external-daily
  router.post('/api/projects/:id/external-links', (req, res) =>
    retired(res, '请使用 /api/projects/:id/external-articles'));
  router.delete('/api/external-links/:id', (req, res) =>
    retired(res, '请使用 /api/projects/:id/external-articles'));
  router.post('/api/projects/:id/fetch-external-links', (req, res) =>
    retired(res, '请使用 /api/projects/:id/fetch-external-daily'));
  router.post('/api/fetch-external-links-all', (req, res) =>
    retired(res, '请按项目使用 /api/projects/:id/fetch-external-daily'));

  return router;
};
