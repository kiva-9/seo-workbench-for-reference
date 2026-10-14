const express = require('express');
const { wrap } = require('../lib/http');
const { createPatService } = require('../auth/mcp-pat');

module.exports = ({ db }) => {
  const router = express.Router();
  const tokens = createPatService(db);
  router.use('/api/mcp-token', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/api/mcp-token', wrap(async (req, res) => res.json(await tokens.status(req.user.id))));
  // 保留可操作的冲突原因，满额和已撤销不能被通用错误页抹成模糊提示。
  const tokenAction = action => wrap(async (req, res) => {
    try { await action(req, res); }
    catch (e) {
      if (e.code === 'CONFLICT') return res.status(409).json({ error: e.message, code: e.code });
      throw e;
    }
  });
  router.post('/api/mcp-token', tokenAction(async (req, res) => res.status(201).json(await tokens.issue(req.user.id, req.body?.name))));
  router.post('/api/mcp-token/:id/reset', tokenAction(async (req, res) => res.json(await tokens.reset(req.user.id, req.params.id))));
  router.delete('/api/mcp-token/:id', tokenAction(async (req, res) => res.json(await tokens.revoke(req.user.id, req.params.id))));
  return router;
};
