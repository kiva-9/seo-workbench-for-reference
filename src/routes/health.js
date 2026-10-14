// health.js —— 健康检查：部署后确认服务在跑、跑的是哪个版本、数据库升级到第几步
// 不在 /api 下，不需要登录（团队模式下 Cloudflare Access 仍然挡在最前面）。

const express = require('express');
const { version } = require('../../package.json');
const { wrap } = require('../lib/http');

module.exports = function healthRoutes({ db, config }) {
  const router = express.Router();

  router.get('/healthz', wrap(async (req, res) => {
    res.json({ ok: true, version, schemaVersion: await db.schemaVersion(),
      ...(config?.DEPLOYMENT_SHA ? { deploymentSha: config.DEPLOYMENT_SHA } : {}),
      ...(config?.DEPLOYMENT_HOLD ? { deploymentHold: true } : {}) });
  }));

  return router;
};
