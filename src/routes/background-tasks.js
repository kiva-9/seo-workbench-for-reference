const { Router } = require('express');
const { wrap } = require('../lib/http');
const { createBackgroundTasks } = require('../services/background-tasks');
const TYPES = ['article-sync', 'ai', 'operation', 'resource-sync'];
const STATUSES = ['active', 'queued', 'running', 'succeeded', 'partial', 'failed', 'cancel_requested', 'cancelled', 'uncertain'];
const problem = (status, message) => Object.assign(new Error(message), { status });
function integer(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw problem(400, '分页或筛选参数无效');
  return n;
}
module.exports = deps => {
  const router = Router(), service = createBackgroundTasks(deps), { db, config, mcpRegistry } = deps;
  router.use('/api/background-tasks', wrap(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const user = await db.getUser(req.user.id);
    if (!user) throw problem(401, '登录已失效');
    req.taskActor = { user_id: user.id, current_role: user.role, channel: 'web', token_id: null };
    next();
  }));
  router.get('/api/background-tasks/options', wrap(async (req, res) => res.json({
    projects: await db.aiProjects(req.taskActor.user_id),
    accounts: (await db.listAccounts({ ownerUserId: req.taskActor.user_id, isAdmin: req.taskActor.current_role === 'admin' }))
      .map(a => ({ id: a.id, name: a.note || a.email })),
  })));
  router.get('/api/background-tasks', wrap(async (req, res) => {
    const q = req.query;
    if (q.type && !TYPES.includes(q.type) || q.status && !STATUSES.includes(q.status)) throw problem(400, '任务类型或状态筛选无效');
    if (q.as_of && (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(q.as_of) || !Number.isFinite(Date.parse(q.as_of)))) throw problem(400, '分页快照时间无效');
    res.json(await service.list(req.taskActor.user_id, { type: q.type || '', status: q.status || '',
      project: integer(q.project_id, null), account: integer(q.account_id, null), page: integer(q.page, 1),
      pageSize: integer(q.page_size, 25, 100), asOf: q.as_of || new Date().toISOString() }));
  }));
  router.use('/api/background-tasks/:type/:taskId', (req, res, next) => {
    if (!TYPES.includes(req.params.type) || !/^[\w:-]{1,100}$/.test(req.params.taskId)) return res.status(404).json({ error: '任务不存在或不可访问' });
    next();
  });
  router.get('/api/background-tasks/:type/:taskId', wrap(async (req, res) => {
    res.json(await service.get(req.taskActor.user_id, req.params.type, req.params.taskId, { unitPage: integer(req.query.unit_page, 1) }));
  }));
  for (const action of ['retry', 'cancel']) router.post(`/api/background-tasks/:type/:taskId/${action}`, wrap(async (req, res) => {
    const { type, taskId } = req.params;
    const dto = await service.get(req.taskActor.user_id, type, taskId);
    if (config.DEPLOYMENT_HOLD) throw problem(503, '部署校验期间后台任务暂停');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(k => k !== 'idempotency_key')) throw problem(400, '任务操作参数无效');
    if (type === 'ai' && action === 'retry') {
      try {
        const run = await service.retryAi(req.taskActor.user_id, type, taskId);
        req.app.locals.wakeInsights?.();
        return res.status(202).json({ type: 'ai', id: run.id, status: run.status });
      } catch (error) {
        throw problem(error.status === 403 ? 403 : 409, '任务状态或项目配置已变化，请刷新任务后再重试');
      }
    }
    const allowed = action === 'retry' ? dto.canRetry : dto.canCancel;
    if (type !== 'operation') throw problem(409, action === 'retry' ? dto.retryUnavailableReason : dto.cancelUnavailableReason);
    const descriptor = mcpRegistry.all.find(t => t.name === (action === 'retry' ? 'retry_operation' : 'cancel_operation'));
    const checked = descriptor.inputSchema.safeParse({ operation_id: taskId, ...(action === 'retry' ? { retry_scope: 'both' } : {}), idempotency_key: req.body.idempotency_key });
    if (!checked.success) throw problem(400, '需要有效的业务日期与幂等键');
    const previous = await db.mcpFindOperation(req.taskActor.user_id, descriptor.name, req.body.idempotency_key);
    if (!allowed && !previous) throw problem(409, action === 'retry' ? dto.retryUnavailableReason : dto.cancelUnavailableReason);
    try {
      const result = (await descriptor.handler(checked.data, req.taskActor)).data;
      req.app.locals.mcpContext.wakeOperations?.();
      const operation = result.operation;
      res.status(202).json({ type: 'operation', id: operation?.id || result.operation_id || taskId,
        status: operation?.status || result.status, reused: Boolean(result.reused), rollbackPerformed: false });
    } catch (error) {
      const status = ({ FORBIDDEN: 403, NOT_FOUND: 404, OPERATION_EXPIRED: 410, VALIDATION_ERROR: 400, DEPENDENCY_UNAVAILABLE: 503 })[error.code] || 409;
      throw problem(status, status === 403 || status === 404 ? '任务不存在或当前权限不足' : status === 410 ? '任务输入已过期，请返回业务入口重新提交' : '任务状态、配置或重试范围已变化，请刷新后再操作');
    }
  }));
  return router;
};
