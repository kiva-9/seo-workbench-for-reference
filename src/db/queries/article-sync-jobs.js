// sync-jobs.js —— 文章同步任务
//
// 为什么有这张表：大项目同步单请求要跑很久，按钮干等、失败只 toast 一次。入队即返回
// 202，前端轮询到终态；按钮在任务进行里显示「同步中」，重复点击复用活动任务。
// 有完整检查点的队列由后台按租约自动恢复；无检查点的旧任务过期后按失败处理。

const { randomUUID } = require('node:crypto');
const { now } = require('../helpers');

const LEASE_MINUTES = 10;

// 状态迁移都带 updated_at：读取方按租约判断活动任务是否还活着
function leaseCutoff() {
  return new Date(Date.now() - LEASE_MINUTES * 60 * 1000).toISOString();
}

module.exports = (db) => ({
  // 已受理的 queued/running 均占用项目槽位，过期执行租约不丢弃完整意图。
  getActiveJob: async (projectId) => db.prepare(
    "SELECT * FROM article_monitor_sync_jobs WHERE project_id = ? AND status IN ('queued', 'running')"
  ).get(projectId),

  // 租约过期的活动任务按失败处理（重启残留）；返回处理的条数
  failStaleJobs: async () => {
    const info = await db.prepare(
      "UPDATE article_monitor_sync_jobs SET status = 'failed', progress_step = '任务心跳已过期，请核查后重新提交', finished_at = ?, updated_at = ? " +
      "WHERE queue_json IS NULL AND status IN ('queued', 'running') AND updated_at < ?"
    ).run(now(), now(), leaseCutoff());
    return Number(info.changes || 0);
  },

  createJob: async (projectId, { scope = 'project', articleId = null, force = false, months = [], createdBy = null, queue = null }) => {
    const jobId = randomUUID();
    await db.prepare(
      `INSERT INTO article_monitor_sync_jobs
        (job_id, project_id, status, scope, article_id, force, months_json, created_by, created_at, updated_at, queue_json, metrics_json)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(jobId, projectId, scope, articleId ?? null, force ? 1 : 0,
      JSON.stringify(Array.isArray(months) ? months : []), createdBy, now(), now(), queue ? JSON.stringify(queue) : null,
      JSON.stringify(queue ? { autoContinue: true, batches: 0, months: 0, totalMonths: queue.requestedMonths.length,
        remainingMonths: queue.requestedMonths, unprocessed: queue.articles.length } : {}));
    return jobId;
  },

  // 状态推进。patch 可带 progress_step / errors / metrics；status 必给。
  updateJob: async (jobId, patch = {}) => {
    const sets = ['updated_at = @at'];
    const named = { id: jobId, at: now() };
    if (patch.status) { sets.push('status = @status'); named.status = patch.status; }
    if (patch.status === 'running') sets.push('started_at = COALESCE(started_at, @at)');
    if (['succeeded', 'partial', 'failed'].includes(patch.status)) sets.push('finished_at = @at');
    if (patch.progressStep !== undefined) { sets.push('progress_step = @step'); named.step = patch.progressStep; }
    if (patch.errors !== undefined) { sets.push('errors_json = @errors'); named.errors = JSON.stringify(patch.errors || []); }
    if (patch.metrics !== undefined) { sets.push('metrics_json = @metrics'); named.metrics = JSON.stringify(patch.metrics || {}); }
    await db.prepare(`UPDATE article_monitor_sync_jobs SET ${sets.join(', ')} WHERE job_id = @id AND status IN ('queued','running')`).run(named);
  },

  getJob: async (jobId) => db.prepare('SELECT * FROM article_monitor_sync_jobs WHERE job_id = ?').get(jobId),

  claimArticleSyncJob: async (leaseId, at, leaseUntil) => db.prepare(`UPDATE article_monitor_sync_jobs
    SET status='running', lease_id=?, lease_until=?, updated_at=?, started_at=COALESCE(started_at,?), next_attempt_at=NULL
    WHERE job_id=(SELECT job_id FROM article_monitor_sync_jobs WHERE queue_json IS NOT NULL
      AND status IN ('queued','running') AND (lease_until IS NULL OR lease_until<=?)
      AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,rowid LIMIT 1)
    RETURNING *`).get(leaseId,leaseUntil,at,at,at,at),

  // 最近的任务（项目维度，前端恢复进度用）
  listRecentJobs: async (projectId, limit = 5) => db.prepare(
    'SELECT * FROM article_monitor_sync_jobs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
  ).all(projectId, Math.max(1, Math.min(Number(limit) || 5, 20))),
});

module.exports.LEASE_MINUTES = LEASE_MINUTES;
