// 同步意图持久化后返回回执；消费和重启恢复由后台执行器推进，轮询只读。
//
// 复用单请求同步引擎：入队即 202，后台跑完写终态，前端轮询到 succeeded/partial/failed。
// 重复点击：项目级唯一活动任务（部分唯一索引）→ 返回正在进行的那个任务（reused）。

const express = require('express');
const { wrap, parseId, badId } = require('../lib/http');
const { isValidMonth } = require('../lib/business-dates');
const { publicArticleMetrics, redact } = require('../lib/task-presentation');

module.exports = function articleSyncJobRoutes({ db, google, articleQueue, assertProjectAccess, config = {} }) {
  const queue = articleQueue || require('../services/article-sync-queue').createArticleSyncQueue({ db, google });
  const router = express.Router();

  // 入队（或复用活动任务）。body: { force?, months?, articleId? }
  router.post('/api/projects/:id/article-monitor/sync', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    const project = await assertProjectAccess(req, res, id);
    if (!project) return;
    const body = req.body || {};
    const months = Array.isArray(body.months) ? body.months.filter(isValidMonth) : null;
    if (body.months && (!months || !months.length)) {
      return res.status(400).json({ error: 'months 里没有合法的 YYYY-MM' });
    }
    const articleId = body.articleId ? parseId(body.articleId) : null;
    if (body.articleId && !articleId) return badId(res);

    // 没有检查点的旧任务无法恢复；新队列的过期租约由执行器重新认领。
    await db.failStaleJobs();
    const active = await db.getActiveJob(id);
    if (active) {
      return res.status(202).json({ ok: true, jobId: active.job_id, reused: true, status: active.status });
    }

    const { jobId, reused } = await queue.enqueue(project, {
      scope: articleId ? 'article' : 'project', articleId, force: Boolean(body.force),
      months: months || [], createdBy: req.user.id,
    });
    if (!config.DEPLOYMENT_HOLD && !config.MAINTENANCE_MODE) queue.wake();

    res.status(202).json({ ok: true, jobId, reused, status: 'queued' });
  }));

  router.get('/api/projects/:id/article-monitor/sync-jobs', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    await db.failStaleJobs();
    res.set('Cache-Control', 'no-store').json({ jobs: (await db.listRecentJobs(id, 5)).map(publicJob) });
  }));

  // 轮询：任务状态到终态即停（前端 2s 一次）
  router.get('/api/article-monitor-sync-jobs/:jobId', wrap(async (req, res) => {
    const jobId = String(req.params.jobId || '');
    if (!/^[a-f0-9-]{36}$/.test(jobId)) return badId(res);
    await db.failStaleJobs();
    const job = await db.getJob(jobId);
    if (!job) return res.status(404).json({ error: '同步任务不存在' });
    if (!(await assertProjectAccess(req, res, job.project_id))) return;
    res.set('Cache-Control', 'no-store').json({ job: publicJob(job) });
  }));

  return router;
};

function publicJob(job) {
    const metrics = publicArticleMetrics(safeParse(job.metrics_json), job.status);
    return {
        jobId: job.job_id,
        projectId: Number(job.project_id),
        status: job.status,
        scope: job.scope,
        articleId: job.article_id === null ? null : Number(job.article_id),
        force: Boolean(Number(job.force)),
        progressStep: job.progress_step ? redact(job.progress_step) : null,
        errors: safeParse(job.errors_json).map(redact),
        metrics,
        engineStatus: metrics.engineStatus ?? null,
        reason: metrics.reason ?? null,
        hint: metrics.hint ?? null,
        months: safeParse(job.months_json),
        createdAt: job.created_at,
        updatedAt: job.updated_at,
        startedAt: job.started_at,
        finishedAt: job.finished_at,
    };
}

function safeParse(json) {
  try { return JSON.parse(json || '[]'); } catch { return []; }
}
