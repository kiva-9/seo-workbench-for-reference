const { randomUUID } = require('node:crypto');
const { businessToday, isValidDay } = require('../lib/business-dates');
const { jobResultPatch } = require('./article-sync-result');
const { articleSyncAuthority } = require('./article-sync-authority');

const LEASE_MS = 2 * 60_000;
const MAX_MONTHS = 6;
const MAX_REQUESTS = 45;
const parse = value => JSON.parse(value);
const cost = requests => Number(requests.gsc) + Number(requests.ga4);
const pendingMonths = state => [...new Set(state.groups.flatMap(group => group.months))].sort().reverse();

function createArticleSyncQueue({ db, google, today = businessToday, now = () => new Date().toISOString() }) {
  let draining = null;
  const service = { enqueue, runOnce, wake() {
    // 路由可独立挂载；正式服务用带停止/恢复生命周期的调度循环替换 wake。
    if (!draining) draining = (async () => { while ((await runOnce()).processed) {} })()
      .catch(() => {}).finally(() => { draining = null; });
    return draining;
  } };

  async function enqueue(project, input) {
    const day = today();
    const articles = (await db.listArticleUrlsForSync(project.id)).filter(a => !input.articleId || a.id === input.articleId);
    const plan = await google.planArticleSync(project, { months: input.months, force: input.force, articleId: input.articleId, today: day });
    const months = plan.months.map(pm => pm.month).sort().reverse();
    const queue = { version: 1, today: day, configRevision: project.config_revision,
      articles: articles.map(a => ({ id: a.id, revision: Number(a.fetch_revision ?? 1) })),
      finalizeIds: articles.filter(a => isValidDay(a.published_at) && a.published_at <= day).map(a => a.id),
      groups: [{ articleIds: articles.map(a => a.id), months }],
      requestedMonths: months, completedMonths: [], batches: 0, warnings: [], fetched: { articles: 0, sourceMonths: 0 }, current: null };
    try { return { jobId: await db.createJob(project.id, { ...input, queue }), reused: false }; }
    catch (error) {
      // 两个提交可能同时完成纯读取计划，唯一索引是最终防重边界。
      const active = await db.getActiveJob(project.id);
      if (active) return { jobId: active.job_id, reused: true };
      throw error;
    }
  }

  async function runOnce() {
    const at = now(), leaseId = randomUUID();
    const job = await db.claimArticleSyncJob(leaseId, at, new Date(Date.parse(at) + LEASE_MS).toISOString());
    if (!job) return { processed: 0 };
    const state = parse(job.queue_json);
    const authority = articleSyncAuthority(db, job, state);
    let heartbeat;
    const engineRunId = `article-job-${job.job_id}-${leaseId}`;
    async function save(status, patch = {}, { delay = 0, guarded = true, finalize = false } = {}) {
      const stamp = now();
      const metrics = { autoContinue: true, batches: state.batches, months: state.completedMonths.length,
        totalMonths: state.requestedMonths.length, remainingMonths: pendingMonths(state),
        unprocessed: state.groups.reduce((sum, group) => sum + group.articleIds.length, 0),
        current: state.current, fetched: state.fetched, dataThrough: state.dataThrough ?? null,
        warnings: state.warnings, ...patch.metrics };
      const statements = [];
      if (finalize) {
        statements.push(db.db.prepare(`UPDATE project_articles SET metrics_dirty=0,last_synced_at=? WHERE project_id=?
          AND id IN (SELECT value FROM json_each(?))`).bind(stamp,job.project_id,JSON.stringify(state.finalizeIds)));
        statements.push(db.db.prepare('UPDATE project_monitor_sync_state SET last_success_at=?,last_error=NULL,updated_at=? WHERE project_id=?').bind(stamp,stamp,job.project_id));
      }
      statements.push(db.db.prepare(`UPDATE article_monitor_sync_jobs SET status=?, queue_json=?, metrics_json=?, errors_json=?,
        progress_step=?, updated_at=?, finished_at=?, lease_id=NULL, lease_until=NULL, next_attempt_at=?
        WHERE job_id=? AND lease_id=? AND lease_until>? AND status='running'`).bind(status,JSON.stringify(state),JSON.stringify(metrics),
        JSON.stringify(patch.errors || []),patch.progressStep ?? (status === 'queued' ? `已完成 ${state.batches} 批，剩余历史自动排队` : null),
        stamp,['queued','running'].includes(status) ? null : stamp,delay ? new Date(Date.parse(stamp)+delay).toISOString() : null,
        job.job_id,leaseId,stamp));
      if (guarded) await authority.atomic(statements); else await db.db.batchAtomic(statements);
    }
    try {
      // 重新认领使旧租约失效后，只回收该任务旧执行者的引擎锁。
      // 无需等待引擎的保守租期，也不触碰等待式/MCP 的执行窗口。
      const prefix = `article-job-${job.job_id}-`;
      await db.db.prepare(`UPDATE project_monitor_sync_state SET run_id=NULL,lease_until=NULL
        WHERE project_id=? AND substr(run_id,1,?)=? AND run_id<>?
        AND EXISTS(SELECT 1 FROM article_monitor_sync_jobs WHERE job_id=? AND lease_id=? AND lease_until>?)`)
        .run(job.project_id,prefix.length,prefix,engineRunId,job.job_id,leaseId,now());
      await authority.check();
      if (today().slice(0,7) !== state.today.slice(0,7)) throw new Error('业务月份已变化，请重新同步以更新历史和本月范围');
      heartbeat = setInterval(() => db.db.prepare(`UPDATE article_monitor_sync_jobs SET lease_until=?,updated_at=?
        WHERE job_id=? AND lease_id=? AND status='running' AND lease_until>?`).run(
        new Date(Date.now()+LEASE_MS).toISOString(),now(),job.job_id,leaseId,now()).catch(() => {}), 30_000);
      heartbeat.unref?.();
      const project = await db.getProject(job.project_id), group = state.groups[0];
      let requests = 0;
      const scopedGoogle = google.createArticleScoped ? google.createArticleScoped(authority.db, async () => {
        await authority.check();
        if (requests >= MAX_REQUESTS) require('./mcp-common').fail('BUDGET_EXCEEDED', '本批 Google 请求预算已用完');
        requests++;
      }) : google;
      const plan = await scopedGoogle.planArticleSync(project, { months: group.months, currentOnly: !group.months.length,
        force: Boolean(job.force), articleIds: group.articleIds, today: state.today });
      const currentCost = cost(plan.current.requests);
      const oversized = currentCost > MAX_REQUESTS - 2 || plan.months.some(pm => currentCost + cost(pm.requests) > MAX_REQUESTS - 2);
      if (oversized) {
        if (group.articleIds.length <= 1) throw new Error('单篇来源窗口超出执行预算，请核查文章 URL 历史规模');
        const split = Math.ceil(group.articleIds.length / 2);
        state.groups.splice(0, 1, ...[group.articleIds.slice(0,split),group.articleIds.slice(split)].map(articleIds => ({ articleIds, months: [...group.months] })));
        await save('queued'); return { processed: 1 };
      }
      const selected = [];
      let planned = currentCost;
      for (const month of group.months) {
        const pm = plan.months.find(pm => pm.month === month);
        const increment = pm ? cost(pm.requests) : 0;
        // 为两个账号的 OAuth 刷新留出空间；每批仍有真实请求计数兜底。
        if (selected.length >= (group.batchSize || MAX_MONTHS) || planned + increment > MAX_REQUESTS - 2) break;
        selected.push(month); planned += increment;
      }
      const last = selected.length === group.months.length;
      const out = await scopedGoogle.fetchArticleMetrics(project, { months: selected, currentOnly: !selected.length,
        includeCurrent: last, deferCompletion: true, runId: engineRunId,
        force: Boolean(job.force), articleIds: group.articleIds, today: state.today });
      if (out.status === 'busy') {
        await save('queued', { progressStep: '等待当前项目执行窗口，随后自动继续' }, { delay: 30_000 });
        return { processed: 0 };
      }
      state.batches++;
      state.dataThrough = out.dataThrough ?? state.dataThrough ?? null;
      const patch = jobResultPatch(out);
      const budgetHit = /本批 Google 请求预算已用完/.test(JSON.stringify(out));
      if (budgetHit && (group.articleIds.length > 1 || selected.length > 1)) {
        if (group.articleIds.length > 1) {
          const half = Math.ceil(group.articleIds.length / 2);
          state.groups.splice(0,1,...[group.articleIds.slice(0,half),group.articleIds.slice(half)].map(articleIds => ({ ...group,articleIds,months:[...group.months] })));
        } else group.batchSize = Math.max(1,Math.floor(selected.length / 2));
        await save('queued', { progressStep: '本批预算已用完，已自动拆分并继续排队' });
        return { processed: 1 };
      }
      state.warnings = [...new Set([...state.warnings,...out.warnings || []])];
      state.fetched.articles += out.fetched?.articles || 0;
      state.fetched.sourceMonths += out.fetched?.sourceMonths || 0;
      if (out.current) state.current = out.current;
      if (patch.status !== 'succeeded') {
        // 来源失败不自动重试；完整保留本批及后续范围，防止无限重试掩盖失败。
        await save(patch.status, { ...patch, metrics: { engineStatus: out.status, reason: patch.metrics.reason,
          hint: patch.metrics.hint, dataThrough: out.dataThrough, remainingMonths: pendingMonths(state), autoContinue: false } });
        return { processed: 1 };
      }
      group.months = group.months.filter(month => !selected.includes(month));
      if (last) state.groups.shift();
      state.completedMonths = state.requestedMonths.filter(month => !pendingMonths(state).includes(month));
      if (state.groups.length) await save('queued');
      else await save('succeeded', { metrics: { engineStatus: out.status, remainingMonths: [], unprocessed: 0 } }, { finalize: true });
    } catch (error) {
      // 仅释放本执行者认领的引擎锁；撤权/修订变化也不能遗留“同步中”。
      await db.releaseMonitorSyncState(job.project_id, { runId: engineRunId, at: now(),
        lastError: '同步权限、文章或配置已变化，未完整完成' });
      await save(state.batches ? 'partial' : 'failed', { progressStep: '同步未完整完成，请核查失败原因',
        errors: [String(error.message || error).slice(0,500)], metrics: { autoContinue: false, reason: '同步权限、修订或来源发生变化，已保留完成结果和剩余范围' } }, { guarded: false });
    } finally { clearInterval(heartbeat); }
    return { processed: 1 };
  }
  return service;
}

function startArticleSyncBackground(service, { enabled = true, setTimer = setTimeout, clearTimer = clearTimeout,
  onError = () => console.error('[文章同步后台] 执行暂不可用') } = {}) {
  let stopped = false, timer, running, again = false;
  function schedule(delay) { if (!stopped && enabled) { timer=setTimer(tick,delay); timer.unref?.(); } }
  async function tick() {
    timer=null; if (stopped || running) return;
    running=service.runOnce(); let result;
    try { result=await running; } catch (error) { onError(error); }
    running=null; const delay=again || result?.processed ? 100 : 5000; again=false; schedule(delay);
  }
  function wake() { if (stopped || !enabled) return; if (running) { again=true; return; } if (timer) clearTimer(timer); schedule(0); }
  schedule(0);
  return { wake, stop() { stopped=true; if (timer) clearTimer(timer); return running || Promise.resolve(); } };
}
module.exports = { createArticleSyncQueue, startArticleSyncBackground, MAX_MONTHS, MAX_REQUESTS };
