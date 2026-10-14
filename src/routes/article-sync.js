// article-sync.js —— 站内文章月度同步接口（任务07）
// 单请求内完成所选范围同步；不引入队列/后台任务/cron。
// 重复点击：数据库条件认领挡回（同项目重入返回「正在刷新」）。

const express = require('express');
const { wrap, parseId, badId } = require('../lib/http');
const { isValidMonth } = require('../lib/business-dates');

// 限制单次同步的月份和 Google 请求规模，避免长时间占用一个 HTTP 请求。
// 超限在写入前拒绝，返回拆分提示；用户可手动分次选择月份。
const MAX_MONTHS_PER_SYNC = 6;
const MAX_GOOGLE_REQUESTS_PER_SYNC = 45;

// 把超限的月份列表拆成可执行的分批（每批 ≤ MAX_MONTHS_PER_SYNC）
function rangeHint(months) {
  const sorted = [...months].sort();
  const batches = [];
  for (let i = 0; i < sorted.length; i += MAX_MONTHS_PER_SYNC) {
    batches.push(sorted.slice(i, i + MAX_MONTHS_PER_SYNC));
  }
  return {
    maxMonthsPerSync: MAX_MONTHS_PER_SYNC,
    suggestedBatches: batches,
  };
}

module.exports = function articleSyncRoutes({ db, google, assertProjectAccess }) {
  const router = express.Router();

  // 首次回填的「拟取范围 + 预计批数」：只读，不抓数不写库
  router.get('/api/projects/:id/article-sync/plan', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    const project = await assertProjectAccess(req, res, id);
    if (!project) return;
    try {
      const plan = await google.planArticleSync(project, {});
      res.json({
        monitorStart: plan.monitorStart,
        missingPublicationIds: plan.missingPublicationIds || [],
        reason: plan.reason || null,
        maxMonthsPerSync: MAX_MONTHS_PER_SYNC,
        maxGoogleRequestsPerSync: MAX_GOOGLE_REQUESTS_PER_SYNC,
        dataThrough: plan.dataThrough,
        articleCount: plan.articleCount,
        urlBatches: plan.urlBatches,
        requests: plan.requests,
        current: plan.current,
        months: plan.months.map((m) => ({
          month: m.month,
          gsc: m.gsc.need ? 'fetch' : (m.gsc.reason === 'unavailable' ? 'unavailable' : 'skip'),
          ga4: m.ga4.need ? 'fetch' : (m.ga4.reason === 'unavailable' ? 'unavailable' : 'skip'),
          detail: [m.gsc.detail, m.ga4.detail].filter(Boolean),
          requests: m.requests || null,
        })),
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }));

  // 项目刷新：{ months?: ['YYYY-MM'], force?: bool }。单请求内同步完成。
  router.post('/api/projects/:id/article-sync', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    const project = await assertProjectAccess(req, res, id);
    if (!project) return;
    const body = req.body || {};
    const months = Array.isArray(body.months) ? body.months.filter(isValidMonth) : null;
    if (body.months && !months?.length) return res.status(400).json({ error: 'months 里没有合法的 YYYY-MM' });
    if (months && months.length > MAX_MONTHS_PER_SYNC) {
      return res.status(400).json({
        error: `一次最多同步 ${MAX_MONTHS_PER_SYNC} 个月，请分次选择`,
        hint: rangeHint(months),
      });
    }
    const out = await google.fetchArticleMetrics(project, { months, force: Boolean(body.force) });
    if (out.status === 'range-exceeded') return res.status(400).json({ error: out.reason, hint: out.hint });
    // busy 是正常业务状态（不是错误）：409 让前端按钮恢复
    if (out.status === 'busy') return res.status(409).json({ error: out.reason });
    if (out.status === 'skipped') return res.status(400).json({ error: out.reason });
    res.json(out);
  }));

  // 单篇刷新：复用同一执行器
  router.post('/api/projects/:id/articles/:aid/article-sync', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    const project = await assertProjectAccess(req, res, id);
    if (!project) return;
    const article = await db.getArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '文章不存在' });
    const body = req.body || {};
    const months = Array.isArray(body.months) ? body.months.filter(isValidMonth) : null;
    if (body.months && !months?.length) return res.status(400).json({ error: 'months 里没有合法的 YYYY-MM' });
    if (months && months.length > MAX_MONTHS_PER_SYNC) {
      return res.status(400).json({
        error: `一次最多同步 ${MAX_MONTHS_PER_SYNC} 个月，请分次选择`,
        hint: rangeHint(months),
      });
    }
    const out = await google.fetchArticleMetrics(project, { months, force: Boolean(body.force), articleId: aid });
    if (out.status === 'range-exceeded') return res.status(400).json({ error: out.reason, hint: out.hint });
    if (out.status === 'busy') return res.status(409).json({ error: out.reason });
    if (out.status === 'skipped') return res.status(400).json({ error: out.reason });
    res.json(out);
  }));

  return router;
};
