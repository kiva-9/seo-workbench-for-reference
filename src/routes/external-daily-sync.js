// external-daily-sync.js —— 外链平台日数据同步接口（任务10）
// 与站内同步同构：单请求完成所选月份；数据库条件认领挡重入；范围契约写入前生效。

const express = require('express');
const { wrap, parseId, badId } = require('../lib/http');
const { isValidMonth } = require('../lib/business-dates');

const MAX_MONTHS_PER_SYNC = 6;

module.exports = function externalDailySyncRoutes({ db, google, assertProjectAccess }) {
  const router = express.Router();

  // 计划（零写）：拟抓月份 + 域名批次数
  router.get('/api/projects/:id/fetch-external-daily/plan', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    const project = await assertProjectAccess(req, res, id);
    if (!project) return;
    if (req.query.months && !Array.isArray(req.query.months)) {
      const months = String(req.query.months).split(',').filter(isValidMonth);
      const plan = await google.planExternalDaily(project, { months });
      return res.json({ months: plan.months, requests: plan.requests, domains: plan.domains, articleCount: plan.articleCount });
    }
    const plan = await google.planExternalDaily(project, {});
    res.json({ months: plan.months, requests: plan.requests, domains: plan.domains, articleCount: plan.articleCount });
  }));

  // 执行：{ months?: [...], domain? }。domain 非空 = 只同步该平台（单平台刷新）
  router.post('/api/projects/:id/fetch-external-daily', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    const project = await assertProjectAccess(req, res, id);
    if (!project) return;
    const body = req.body || {};
    const months = Array.isArray(body.months) ? body.months.filter(isValidMonth) : null;
    if (body.months && !months?.length) return res.status(400).json({ error: 'months 里没有合法的 YYYY-MM' });
    if (months && months.length > MAX_MONTHS_PER_SYNC) {
      const sorted = [...months].sort();
      const batches = [];
      for (let i = 0; i < sorted.length; i += MAX_MONTHS_PER_SYNC) batches.push(sorted.slice(i, i + MAX_MONTHS_PER_SYNC));
      return res.status(400).json({ error: `一次最多同步 ${MAX_MONTHS_PER_SYNC} 个月，请分次选择`, hint: { suggestedBatches: batches } });
    }
    const domain = body.domain ? String(body.domain) : null;
    const out = await google.fetchExternalDaily(project, { months, domain });
    if (out.status === 'busy') return res.status(409).json({ error: out.reason });
    if (out.status === 'skipped') return res.status(400).json({ error: out.reason });
    if (out.status === 'range-exceeded') return res.status(400).json({ error: out.reason, hint: out.hint });
    res.json(out);
  }));

  return router;
};
