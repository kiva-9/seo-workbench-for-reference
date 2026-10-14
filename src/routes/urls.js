// urls.js —— 项目登记的 URL：列表、批量导入、拖拽排序、删除（含全部历史数据）、文章属性

const express = require('express');
const { wrap, parseId, badId, pick, retired } = require('../lib/http');

module.exports = function urlRoutes({ db, assertProjectAccess }) {
  const router = express.Router();

  router.get('/api/projects/:id/urls', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    res.json(await db.listUrls(id));
  }));

  // 旧写接口退役（任务14）：文章登记/排序统一走 /api/projects/:id/articles
  router.post('/api/projects/:id/urls', (req, res) => retired(res, '请使用 /api/projects/:id/articles'));
  router.put('/api/projects/:id/urls/order', (req, res) => retired(res, '请使用 /api/projects/:id/articles/order'));

  // 批量删除：DELETE /api/urls?ids=1,2,3 —— 这些 URL 可能横跨多个项目，逐条查所属项目
  // 校验权限，全部通过才执行（否则一条没权限的 id 就能借着批量接口连带删掉别人的数据）。
  // 走 db.purgeUrls 一并清掉按月指标 / GA4 累计 / 快照两层，
  // 跟界面上「将删除选中的 URL 及其全部历史数据」这句话对齐。
  // 旧写接口退役（任务14）：删除/编辑统一走 /api/projects/:id/articles
  router.delete('/api/urls', (req, res) => retired(res, '请使用 /api/projects/:id/articles'));
  router.delete('/api/urls/:id', (req, res) => retired(res, '请使用 /api/projects/:id/articles'));
  router.put('/api/urls/:id', (req, res) => retired(res, '请使用 /api/projects/:id/articles'));

  return router;
};
