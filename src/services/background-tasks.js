const { parse, count, date, code, months, articleMetrics, publicArticleMetrics, redact } = require('../lib/task-presentation');
const { canonicalJson } = require('./mcp-common');
const ACTIVE = new Set(['queued', 'running', 'cancel_requested']);
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
const TITLES = { 'article-sync': '文章监控同步', ai: 'AI 见解', operation: '业务后台操作', 'resource-sync': 'Google 资源目录同步' };
const problem = (status, message) => Object.assign(new Error(message), { status });

async function retryCapability(db, op, config) {
  if (!config.MCP_BACKGROUND_ENABLED) return '此环境的业务后台执行已关闭';
  if (!TERMINAL.has(op.status)) return '原任务尚未结束';
  if ((op.detail_expires_at && op.detail_expires_at <= new Date().toISOString()) || !op.input_json) return '重试输入已超过保留期';
  if (op.kind === 'import_retry') {
    const source = await db.mcpGetOperation(parse(op.result_summary_json).source_operation_id || '');
    if (!source || !source.input_json || source.detail_expires_at && source.detail_expires_at <= new Date().toISOString()) return '导入来源检查点已过期';
    const summary = parse(source.result_summary_json);
    return summary.failed?.length || summary.unprocessed?.length ? null : '没有可重试的导入行';
  }
  if (!['sync', 'titles', 'export'].includes(op.kind)) return '此类型尚无原任务重试接口';
  const rows = await db.mcpOperationItems(op.id, 1, 101, ['failed', 'queued', 'running']);
  if (!rows.length) return '没有可重试的失败或未处理单元';
  if (rows.length > 100) return '重试范围超过 100 个单元，请返回业务入口拆分';
  const saved = parse(op.checkpoint_json), input = saved.original_input || parse(op.input_json);
  if (op.kind === 'sync') {
    const project = await db.getProject(input.project_id);
    if (!project || rows.some(r => parse(r.input_json).config_revision !== project.config_revision)) return '项目配置已变化，请重新计划';
    if (await db.mcpActiveSync(input.project_id)) return '项目已有其他活动同步';
  }
  if (op.kind === 'titles') for (const row of rows) {
    const value = parse(row.input_json), article = await db.getArticleForTitle(value.article_id, input.article_type);
    if (!article || article.url !== value.url || article.revision !== value.revision) return '文章修订已变化，请重新提交';
  }
  if (op.kind === 'export') {
    const vector = saved.vector || [], fresh = vector.length ? await db.mcpProjectVector(vector.map(p => p.id)) : [];
    if (canonicalJson(vector) !== canonicalJson(fresh)) return '报表数据已变化，请重新导出';
  }
  return null;
}

function createBackgroundTasks({ db, config, insights }) {
  async function present(row, { detail = false, unitPage = 1 } = {}) {
    const projectIds = parse(row.project_ids, []).map(Number), pid = projectIds[0];
    const dto = { key: `${row.type}:${row.id}`, type: row.type, id: row.id, module: row.module, title: TITLES[row.type],
      projectIds, projectName: row.project_name || null, accountId: row.account_id, accountName: row.account_name || null,
      actorName: row.actor_name || null, status: row.status, createdAt: row.created_at, startedAt: row.started_at,
      updatedAt: row.updated_at, finishedAt: row.finished_at,
      durationSeconds: row.started_at && (row.finished_at || ACTIVE.has(row.status)) ? Math.max(0, Math.floor((Date.parse(row.finished_at || new Date().toISOString()) - Date.parse(row.started_at)) / 1000)) : null,
      progress: { phase: null, completed: null, total: null }, summary: null, errorCodes: [], canRetry: false, canCancel: false,
      retryUnavailableReason: '此任务没有原任务重试接口，请返回业务入口重新提交', cancelUnavailableReason: '此类型暂不支持取消',
      href: '#/article-monitor' + (pid ? '?project=' + pid : '') };
    if (row.type === 'article-sync') {
      const job = await db.getJob(row.id), raw = parse(job.metrics_json), m = publicArticleMetrics(raw, row.status);
      dto.progress = { phase: ACTIVE.has(row.status) ? row.status === 'queued' ? '等待自动续批' : '抓取中' : '本次执行结束', completed: m.months, total: m.totalMonths, unit: 'month' };
      dto.summary = m.reason || articleMetrics(raw,row.status).reason || (row.status === 'succeeded' ? '本次同步执行成功' : null);
      if (detail) dto.details = { scope: job.scope, articleId: job.article_id, requestedMonths: months(parse(job.months_json, [])), ...m,
        errors: parse(job.errors_json,[]).slice(0,10).map(redact) };
    } else if (row.type === 'ai') {
      const run = await db.db.prepare('SELECT * FROM ai_insight_runs WHERE id=?').get(row.id), result = parse(run.result_json);
      const counts = Object.fromEntries(Object.entries(result.counts || {}).filter(([,v]) => typeof v === 'number' && Number.isFinite(v)));
      dto.href = `#/ai-insights?project=${pid}&module=${encodeURIComponent(row.module)}`;
      dto.progress.phase = row.status === 'queued' ? '等待执行' : row.status === 'running' ? '分析中' : '本次执行结束';
      dto.progress.completed = count(result.counts?.processed);
      dto.summary = row.status === 'uncertain' ? '结果/费用待核查，请先核对来源记录' : run.error_code ? '分析未完整完成，已保留已有结果' : null;
      dto.errorCodes = run.error_code ? [code(run.error_code)] : [];
      dto.canRetry = config.AI_INSIGHTS_ENABLED !== false && ['failed', 'partial', 'cancelled'].includes(row.status);
      dto.retryUnavailableReason = dto.canRetry ? null : row.status === 'uncertain' ? '结果/费用待核查，不可直接重试' : config.AI_INSIGHTS_ENABLED === false ? 'AI 见解已关闭' : '当前状态不支持重试';
      if (detail) dto.details = { counts, sources: row.module === 'news' && Array.isArray(result.counts?.sources) ? result.counts.sources.map(s => ({
        name: String(s.name || s.id || '资讯来源').slice(0, 160), status: ['succeeded', 'failed', 'not_requested'].includes(s.status) ? s.status : 'unknown',
        cached: Boolean(s.cached), lastSuccessAt: date(s.last_success_at), errorCode: code(s.error_code), received: count(s.received), saved: count(s.saved) })) : [],
        retryOf: run.retry_of, warningCodes: (result.warnings || []).map(w => code(w.code)).filter(Boolean) };
    } else if (row.type === 'operation') {
      const op = await db.mcpGetOperation(row.id), counts = await db.mcpOperationCounts(op.id);
      dto.progress = { phase: ACTIVE.has(op.status) ? op.status === 'cancel_requested' ? '等待当前单元安全结束' : '执行业务单元' : '本次执行结束', completed: Number(counts.succeeded) + Number(counts.failed), total: count(op.progress_total), unit: 'item' };
      dto.summary = `已成功 ${counts.succeeded}，失败 ${counts.failed}，未处理 ${counts.unprocessed}`;
      const failures = parse(op.error_json, []);
      dto.errorCodes = (Array.isArray(failures) ? failures : [failures]).map(e => code(e?.code || 'TASK_ERROR')).filter(Boolean);
      dto.retryUnavailableReason = await retryCapability(db, op, config); dto.canRetry = dto.retryUnavailableReason === null;
      dto.canCancel = ACTIVE.has(op.status); dto.cancelUnavailableReason = dto.canCancel ? null : '任务已结束';
      dto.href = op.kind === 'titles' ? '#/project?id=' + pid : dto.href;
      if (detail) {
        const expired = op.detail_expires_at && op.detail_expires_at <= new Date().toISOString();
        const items = expired ? [] : await db.mcpOperationItems(op.id, unitPage, 25);
        dto.details = { counts: { succeeded: Number(counts.succeeded), failed: Number(counts.failed), unprocessed: Number(counts.unprocessed) },
          expired: Boolean(expired), unitPage, unitPageSize: 25, unitTotal: Number(counts.total), parentOperationId: op.parent_operation_id,
          items: items.map((item, i) => ({ key: /^[\w|:.,-]{1,160}$/.test(item.item_key) ? item.item_key : `单元 ${(unitPage - 1) * 25 + i + 1}`,
            status: item.state, attempts: item.attempts, errorCode: code(parse(item.error_json).code), nextAttemptAt: date(item.next_attempt_at) })) };
      }
    } else {
      const job = await db.getResourceSyncJob(row.id), cursor = parse(job.cursor_json);
      dto.href = '#/accounts';
      dto.progress = { phase: ({ gsc: 'GSC 站点目录', properties: 'GA4 资源目录', streams: 'GA4 数据流', done: '目录同步结束' })[cursor.phase] || '等待目录同步', completed: count(job.units_done), total: null, unit: 'item' };
      const errors = parse(job.errors_json, []);
      dto.summary = errors.length ? `${errors.length} 个来源步骤未完成，可返回谷歌账号重新同步` : row.status === 'succeeded' ? '资源目录已更新' : null;
      if (detail) dto.details = { sources: (await db.listResourceSyncSources(job.account_id)).map(s => ({ source: s.source, lastSuccessAt: date(s.last_success_at), failed: Boolean(s.last_error) })),
        errors: errors.map(e => ({ source: ['gsc', 'ga4'].includes(e.source) ? e.source : null, phase: ['gsc', 'properties', 'streams'].includes(e.phase) ? e.phase : null, message: '目录来源请求未完成，请核查账号授权或稍后重试' })) };
    }
    if (!dto.summary && ['failed', 'partial'].includes(dto.status)) dto.summary = '本次执行未完整完成，请查看详情及原业务入口';
    if (config.DEPLOYMENT_HOLD) {
      dto.canRetry = false; dto.canCancel = false;
      dto.retryUnavailableReason = dto.cancelUnavailableReason = '部署校验期间任务操作暂停';
    }
    return dto;
  }
  async function get(actor, type, id, options) {
    const row = await db.backgroundTask(actor, type, id);
    if (!row) throw problem(404, '任务不存在或不可访问');
    const dto = await present(row, { detail: true, ...options });
    if (!(await db.backgroundTask(actor, type, id))) throw problem(404, '任务不存在或不可访问');
    return dto;
  }
  return { get, async list(actor, filters) {
    await db.failStaleJobs();
    const { rows, ...meta } = await db.backgroundTasks(actor, filters);
    const items = [];
    for (const row of rows) items.push(await present(row));
    // 撤权可能发生在明细读取期间；只返回仍可见的完整分页快照。
    for (const row of rows) if (!(await db.backgroundTask(actor, row.type, row.id))) return this.list(actor, filters);
    return { ...meta, items };
  }, async retryAi(actor, type, id) {
    const dto = await get(actor, type, id);
    if (type !== 'ai' || !dto.canRetry) throw problem(409, dto.retryUnavailableReason || '此任务不可重试');
    return insights.enqueue(dto.projectIds[0], actor, dto.module, { retry_of: id });
  } };
}
module.exports = { createBackgroundTasks, ACTIVE };
