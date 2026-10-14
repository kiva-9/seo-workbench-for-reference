// app.js —— 组装 Express 应用：安全校验 → 当前用户 → API 路由 → 前端静态文件 → 404 / 错误处理

const express = require('express');
const config = require('./config');
const createHostGuard = require('./middleware/host-guard');
const { createCurrentUser, requireUser } = require('./middleware/current-user');
const createProjectGuard = require('./middleware/access');
const { requestTiming } = require('./lib/request-timing');

const routeModules = [
  require('./routes/health'),
  require('./routes/ai-insights'),
  require('./routes/ai-model-settings'),
  require('./routes/settings'),
  require('./routes/users'),
  require('./routes/mcp-token'),
  require('./routes/mcp-catalog'),
  require('./routes/accounts'),
  require('./routes/google-resources'),
  require('./routes/projects'),
  require('./routes/project-copywriters'),
  require('./routes/project-articles'),
  require('./routes/article-key-events'),
  require('./routes/article-title-fetch'),
  require('./routes/article-sync-jobs'),
  require('./routes/background-tasks'),
  require('./routes/article-sync'),
  require('./routes/article-monitor-export'),
  require('./routes/article-monitor'),
  require('./routes/tasks'),
  require('./routes/links'),
  require('./routes/urls'),
  require('./routes/metrics'),
  require('./routes/gsc-snapshots'),
  require('./routes/external-links'),
  require('./routes/external-daily-sync'),
  require('./routes/project-external-articles'),
];

module.exports = function createApp({ db, google, cfAccess, config: appConfig, fetchTitle, insightOptions }) {
  const activeConfig = appConfig || config;
  const app = express();
  app.disable('x-powered-by');
  if (activeConfig.MAINTENANCE_MODE) {
    app.use((req,res) => res.status(503).set('Retry-After','300').json({error:'服务维护中，请稍后重试'}));
  }
  // 经反向代理转发时，没有这行 req.protocol 永远是 http（拿不到真实的 X-Forwarded-Proto），
  // OAuth 回调地址会拼错协议。本地直连不受影响。
  app.set('trust proxy', true);
  app.use('/api', requestTiming);

  app.use(createHostGuard({
    port: activeConfig.PORT,
    publicHost: activeConfig.PUBLIC_HOST,
  }));
  const deps = { db, google, config: activeConfig, fetchTitle, assertProjectAccess: createProjectGuard(db) };
  deps.articleQueue = require('./services/article-sync-queue').createArticleSyncQueue({ db, google });
  app.locals.articleQueue = deps.articleQueue;
  deps.modelSettings = require('./insights/model-settings').createModelSettings({db,config:activeConfig,...insightOptions?.modelSettingsOptions});
  deps.insights = require('./insights').createInsights({db,google,config:activeConfig,modelSettings:deps.modelSettings,...insightOptions});
  app.locals.modelSettings = deps.modelSettings;
  app.locals.insights = deps.insights;
  // PAT 入口在登录身份中间件前终结，不会回落到本地默认账号。
  const mcp = require('./mcp/routes')(deps);
  app.use(mcp.router);
  app.locals.mcpContext = mcp.context;
  deps.mcpRegistry = mcp.registry;
  app.use(express.json({ limit: '10mb' }));
  app.use(createCurrentUser({ db, cfAccess, config: activeConfig }));
  app.use('/api', requireUser);

  for (const createRoutes of routeModules) app.use(createRoutes(deps));

  app.use(require('./middleware/frontend')(activeConfig));

  // 未匹配到的 API 一律返回 JSON 404，而不是掉进静态目录返回 HTML
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

  // 默认的 Express 错误页会把完整堆栈和绝对路径吐给浏览器，这里换成简短 JSON
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('[服务端错误]', req.method, req.originalUrl, '-', err?.message);
    const status=err?.status || ({FORBIDDEN:403,NOT_FOUND:404,VALIDATION_ERROR:400,CONFLICT:409}[err?.code]) || (/CHECK constraint failed|OWNER_ACCOUNT_DELETED/.test(err?.message||'')?409:500);
    res.status(status).json({ error:status===409?'数据或权限已变化，请刷新后重试':err?.message || '服务器内部错误',...(err?.code?{code:err.code}:{}) });
  });

  return app;
};
