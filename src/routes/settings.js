// settings.js —— 设置：Google Cloud 客户端配置 + 前端需要的全局参数

const express = require('express');
const { wrap } = require('../lib/http');

module.exports = function settingsRoutes({ db, google }) {
  const router = express.Router();

  router.get('/api/settings', wrap(async (req, res) => {
    const clientId = await db.getSetting('gsc_client_id', '');
    const clientSecret = await db.getSetting('gsc_client_secret', '');
    res.json({
      clientIdConfigured: Boolean(clientId),
      clientSecretConfigured: Boolean(clientSecret),
      dataLagDays: google.DATA_LAG_DAYS,
      months: google.recentMonths(),
      defaultMonth: google.lastMonthKey(),
    });
  }));

  router.post('/api/settings', wrap(async (req, res) => {
    const { gsc_client_id, gsc_client_secret } = req.body || {};
    if (gsc_client_id !== undefined) await db.setSetting('gsc_client_id', String(gsc_client_id).trim());
    if (gsc_client_secret !== undefined) await db.setSetting('gsc_client_secret', String(gsc_client_secret).trim());
    res.json({ ok: true });
  }));

  return router;
};
