const express = require('express');
const { toolCatalog } = require('../mcp/registry');

module.exports = ({ mcpRegistry, config }) => {
  const router = express.Router();
  // 登录用户可直接读取完整目录；不认证 PAT，也不执行任何工具处理器。
  router.get('/api/mcp/tools', (req, res) => {
    res.set('Cache-Control', 'no-store').json(toolCatalog(mcpRegistry, config, req.user.role));
  });
  return router;
};
