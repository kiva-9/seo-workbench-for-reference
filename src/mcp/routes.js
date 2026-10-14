const express = require('express');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createPatService } = require('../auth/mcp-pat');
const { createProtocolServer, prepareToolCatalog } = require('./server');
const { createRegistry } = require('./registry');
const { requestTiming } = require('../lib/request-timing');

module.exports = function createMcpRoutes(deps) {
  const router = express.Router(), pat = createPatService(deps.db);
  const registry = createRegistry(deps);
  prepareToolCatalog(registry.tools);
  router.use((req,res,next) => {
    if (req.path !== '/mcp' && !/^\/mcp\/exports\/[0-9a-f-]+$/i.test(req.path)) return next('router');
    res.setHeader('Cache-Control','no-store');
    if (!deps.config.MCP_ENABLED) return res.status(404).json({ error: 'MCP 未启用' });
    next();
  });
  async function authenticate(req,res,next) {
    try {
      req.mcpActor = await pat.authenticate(req.headers.authorization);
      if (!req.mcpActor) return res.status(401).json({ error: '需要有效的 Bearer token' });
      next();
    } catch { res.status(503).json({ error: '认证服务暂不可用' }); }
  }
  router.all('/mcp', requestTiming, authenticate, (req,res,next) => {
    if (req.method !== 'POST') return res.status(405).set('Allow','POST').json({ error: '此 MCP 入口仅支持 POST JSON，不提供 SSE 监听' });
    next();
  }, express.raw({ type: 'application/json', limit: '256kb' }), async (req,res,next) => {
    let body;
    try {
      if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: '需要 application/json' });
      body = JSON.parse(req.body.toString('utf8'));
    } catch { return res.status(400).json({ jsonrpc:'2.0',id:null,error:{code:-32700,message:'JSON 格式错误'} }); }
    try {
      const server = createProtocolServer({ tools: registry.tools, actor: req.mcpActor, context: registry.context });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { server.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(req,res,body);
    } catch (error) { next(error); }
  });
  router.get('/mcp/exports/:id', requestTiming, authenticate, async (req,res,next) => {
    try {
      const { downloadExport } = require('../services/mcp-operations');
      const { artifact, bytes } = await downloadExport(registry.context,req.params.id,req.mcpActor);
      const safeName = artifact.name.replace(/[\r\n"\\]/g,'_');
      res.set('Content-Type',artifact.mime_type).set('Content-Disposition',`attachment; filename="${safeName}"`);
      res.send(Buffer.from(bytes));
    } catch (error) {
      if (error.code) return res.status(error.code === 'FORBIDDEN' ? 403 : error.code === 'OPERATION_EXPIRED' ? 410 : 404).json({ error: error.message });
      next(error);
    }
  });
  router.use((error,req,res,next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'MCP 输入上限 256KiB，请分批提交' });
    next(error);
  });
  return { router, context: registry.context, registry };
};
