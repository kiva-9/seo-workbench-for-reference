// fetch-external-daily.js —— 外链平台日数据同步执行器（任务10）
//
// 平台身份 = 项目 × 域名（见 src/lib/domain.js）。请求按「项目 × 月 × 域名批次 × 来源」
// 组织：GA4 的 sessionSource 维度一次拿整批域名的逐日 users / 关键事件。
// 复用任务07 的全部同步约定：数据库条件认领 + 租约、指纹守卫、截断不写、
// 完整成功范围内物化 0、来源独立状态、范围契约（同 MAX_MONTHS_PER_SYNC / 请求预算）。
//
// 与旧 fetchProjectExternalLinks（根域名累计账本）的区别：不再向 external_links 写累计，
// 日数据进 project_external_daily_metrics；旧账本由任务14 切换消费者后退役（任务15）。

const { DATA_LAG_DAYS } = require('./constants');
const { buildFingerprint } = require('../lib/external-fingerprint');
const { isAuthError } = require('./oauth');
const { resolveAccounts, parseKeyEventNames } = require('./project-config');
const { chunk } = require('../lib/chunk');
const { runUnitBatch } = require('../lib/unit-batch');
const {
  businessToday, monthBounds, shiftMonth, monthOf, safeMonthEnd, isValidMonth, isValidDay,
} = require('../lib/business-dates');
const { fail } = require('../services/mcp-common');
const { sourceRequest } = require('./source-request');

// 同步范围与站内一致，限制单次 Google 抓取规模
const MAX_MONTHS_PER_SYNC = 6;
const MAX_GOOGLE_REQUESTS_PER_SYNC = 45;
// GA4 inListFilter 单批域名数（与旧外链反查一致的保守值）
const IN_LIST_MAX = 50;



function monthFetchRange(month, today, lagDays = DATA_LAG_DAYS) {
  const bounds = monthBounds(month);
  const safeEnd = safeMonthEnd(month, today, lagDays);
  if (!safeEnd || safeEnd < bounds.start) return null;
  return { start: bounds.start, end: safeEnd, monthEnd: bounds.end };
}

function datesInRange(start, end) {
  const out = [];
  let d = start;
  while (d <= end) {
    out.push(d);
    const dt = new Date(d + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + 1);
    d = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }
  return out;
}

function createExternalDailyFetchers({ db, ga4 }) {
  // 后台只提交一个平台、一个来源和至多八个业务日；月覆盖在全部日期成功后另行定稿。
  async function fetchExternalDailyUnit(project,{domain,source,month,start,end,today=businessToday()}) {
    const fp=buildFingerprint(project);
    if(!fp)fail('SOURCE_UNCONFIGURED','项目未配置 GA4 数据源');
    if(!['users','events'].includes(source) || !isValidMonth(month) || !isValidDay(start) || !isValidDay(end)
      || start>end || start.slice(0,7)!==month || end.slice(0,7)!==month)fail('VALIDATION_ERROR','平台来源或日期范围无效');
    const range=monthFetchRange(month,today);
    if(!range || start<range.start || end>range.end)fail('RANGE_TOO_LARGE','日期不在当前可抓取窗口');
    const dates=datesInRange(start,end);
    if(dates.length>8)fail('RANGE_TOO_LARGE','平台来源单元最多抓取八个业务日');
    const eventNames=[...new Set(parseKeyEventNames(project.key_event_names))].sort();
    if(source==='events' && !eventNames.length)fail('SOURCE_UNCONFIGURED','项目未配置所选关键事件');
    const {ga4AccountId}=resolveAccounts(project);
    const response=await sourceRequest(()=>source==='users'?ga4.ga4ReferrerQuery(ga4AccountId,project.ga4_property_id,start,end,[domain])
      :ga4.ga4ReferrerKeyEventsQuery(ga4AccountId,project.ga4_property_id,start,end,eventNames,[domain]));
    if(response.truncated)fail('SOURCE_ERROR','GA4 返回已截断，保留上次成功值');
    const fetchedAt=new Date().toISOString();
    const units=buildDailyUnits(source,project.id,[domain],dates,response.byDate,fp,{start,end},fetchedAt);
    if(units.length!==1)fail('BUDGET_EXCEEDED','平台日期范围不能形成完整业务单元');
    const result={status:'complete',kind:'external_days',month,source,domain,start,end,rows_written:dates.length,fetched_at:fetchedAt};
    const results=await (db.db.commitSyncUnit?db.db.commitSyncUnit(units[0].statements,result,{expectedChanges:dates.length}):db.db.batchAtomic(units[0].statements));
    if(Number(results[0]?.changes)!==dates.length)fail('CONFLICT','平台日数据未完整写入');
    return result;
  }

  async function finalizeExternalDailyUnit(project,{domain,source,month,start,end,status='complete',fetchedAt,today=businessToday()}) {
    const fp=buildFingerprint(project);
    if(!fp)fail('SOURCE_UNCONFIGURED','项目未配置 GA4 数据源');
    if(!['users','events'].includes(source) || !isValidMonth(month) || !['complete','error','unavailable'].includes(status))fail('VALIDATION_ERROR','平台月来源状态无效');
    const patch={[source+'_status']:status};
    if(status==='complete') {
      const range=monthFetchRange(month,today);
      if(!range || start!==range.start || end!==range.end)fail('CONFLICT','平台月覆盖窗口已变化，请重新计划');
      patch[source+'_cover_start']=start;patch[source+'_cover_end']=end;patch[source+'_fingerprint']=fp;
      patch[source+'_fetched_at']=fetchedAt||new Date().toISOString();patch.finalized=end>=range.monthEnd?1:0;patch.error=null;
    } else patch.error=status==='unavailable'?'未配置所选关键事件':'平台日期单元未全部成功';
    const result={status,kind:'external_finalize',month,source,domain,cover_start:status==='complete'?start:null,cover_end:status==='complete'?end:null};
    const statement=db.monthStateStmt(project.id,domain,month,patch);
    const rows=await (db.db.commitSyncUnit?db.db.commitSyncUnit([statement],result,{expectedChanges:1}):db.db.batchAtomic([statement]));
    if(Number(rows[0]?.changes)!==1)fail('CONFLICT','平台月状态未写入');
    return result;
  }
  // ---- 计划（不请求不写库） ----
  async function planExternalDaily(project, { months, force = false, today = businessToday() } = {}) {
    const fp = buildFingerprint(project);
    if (!fp) return { skipped: 'unconfigured', months: [], requests: 0, domains: [] };
    const articles = await db.listExternalArticles(project.id);
    const domains = [...new Set(articles.map((a) => a.domain))].sort();
    let monthList;
    if (Array.isArray(months) && months.length) {
      monthList = [...new Set(months.filter(isValidMonth))].sort();
    } else {
      monthList = [];
      for (let m = shiftMonth(monthOf(today), -5); m <= monthOf(today); m = shiftMonth(m, 1)) monthList.push(m);
    }
    const batches = Math.max(1, Math.ceil(domains.length / IN_LIST_MAX));
    const planMonths = [];
    let requests = 0;
    for (const month of monthList) {
      const range = monthFetchRange(month, today);
      if (!range) { planMonths.push({ month, need: false, reason: '未到可抓取窗口（today−lag 未进入该月）' }); continue; }
      if (!domains.length) { planMonths.push({ month, need: false, reason: '没有登记外链' }); continue; }
      requests += batches * 2; // users + events 两路
      planMonths.push({ month, need: true, range, domains: domains.length, batches });
    }
    return { fingerprint: fp, domains, months: planMonths, requests, articleCount: articles.length };
  }

  // ---- 主执行 ----
  async function fetchExternalDaily(project, { months, force = false, today = businessToday(), domain = null } = {}) {
    const fp = buildFingerprint(project);
    if (!fp) return { status: 'skipped', reason: '未配置 GA4 账号/资源', months: [] };

    const runId = `ext-${project.id}-${Date.now().toString(36)}`;
    const at = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const claimed = await db.claimMonitorSyncState(project.id, { runId, leaseUntil, at });
    if (!claimed) return { status: 'busy', reason: '该项目正在刷新中，请稍后再试', months: [] };

    const result = { status: 'ok', runId, months: [], warnings: [], fetched: { domains: 0, days: 0, sourceMonths: 0 }, failed: [] };
    try {
      const plan = await planExternalDaily(project, { months, force, today });
      if (plan.skipped === 'unconfigured') {
        await db.releaseMonitorSyncState(project.id, { runId, at });
        return { status: 'skipped', reason: '未配置 GA4 账号/资源', months: [] };
      }
      const wanted = domain ? [domain] : plan.domains;
      const eventNames = [...new Set(parseKeyEventNames(project.key_event_names))].sort();
      const eventsConfigured = eventNames.length > 0;
      const { ga4AccountId } = resolveAccounts(project);
      const propertyId = project.ga4_property_id;

      const monthList = plan.months.filter((m) => m.need).map((m) => m.month);
      if (monthList.length > MAX_MONTHS_PER_SYNC) {
        await db.releaseMonitorSyncState(project.id, { runId, at });
        return rangeExceeded(monthList, `一次最多同步 ${MAX_MONTHS_PER_SYNC} 个月，请分次选择`);
      }
      if (plan.requests > MAX_GOOGLE_REQUESTS_PER_SYNC) {
        await db.releaseMonitorSyncState(project.id, { runId, at });
        return rangeExceeded(monthList, `预计 Google 请求数 ${plan.requests} 超过单次上限 ${MAX_GOOGLE_REQUESTS_PER_SYNC}（域名太多，请减少单次同步范围）`);
      }

      for (const month of monthList) {
        const range = monthFetchRange(month, today);
        const mr = { month, users: 'skipped', events: 'skipped', detail: [] };
        const dates = datesInRange(range.start, range.end);
        const fetchedAt = new Date().toISOString();

        // 两个来源分别抓（独立成败）；按域名分批（IN_LIST_MAX）——
        // 单批只问这批域名的 referral，响应规模有界；一个域名只属于一批，不会重复累计
        const domainChunks = chunk(wanted, IN_LIST_MAX);
        const users = await safeQuery(
          () => fetchByDomainChunks((chunkDomains) => ga4.ga4ReferrerQuery(ga4AccountId, propertyId, range.start, range.end, chunkDomains), domainChunks),
          result, mr, 'users');
        const events = eventsConfigured
          ? await safeQuery(
            () => fetchByDomainChunks((chunkDomains) => ga4.ga4ReferrerKeyEventsQuery(ga4AccountId, propertyId, range.start, range.end, eventNames, chunkDomains), domainChunks),
            result, mr, 'events')
          : { status: 'unavailable', byDate: null };

        // users：完整成功 → 逐域名物化日数据（缺行 0）+ 月状态
        if (users.status === 'ok') {
          const units = buildDailyUnits('users', project.id, wanted, dates, users.byDate, fp, range, fetchedAt);
          const st = await applyDailyUnits(units, month, 'users', result, mr);
          mr.users = st;
          await writeMonthState(project.id, wanted, month, 'users', {
            status: st, coverStart: range.start, coverEnd: range.end, fingerprint: fp, fetchedAt,
            finalized: range.end >= range.monthEnd ? 1 : 0,
          });
        } else if (users.status === 'unavailable') {
          mr.users = 'unavailable';
        } else {
          await writeMonthState(project.id, wanted, month, 'users', {
            status: 'error', error: mr.detail.filter((d) => d.startsWith('users')).join(';') || 'users 抓取失败',
          });
        }
        // events：同上；未配置 → 月状态标 unavailable
        if (events.status === 'ok') {
          const units = buildDailyUnits('events', project.id, wanted, dates, events.byDate, fp, range, fetchedAt);
          const st = await applyDailyUnits(units, month, 'events', result, mr);
          mr.events = st;
          await writeMonthState(project.id, wanted, month, 'events', {
            status: st, coverStart: range.start, coverEnd: range.end, fingerprint: fp, fetchedAt,
            finalized: range.end >= range.monthEnd ? 1 : 0,
          });
        } else if (events.status === 'unavailable') {
          mr.events = 'unavailable';
          mr.detail.push('未配置所选事件');
          await writeMonthState(project.id, wanted, month, 'events', {
            status: 'unavailable', error: '未配置所选事件',
          });
        } else {
          // 抓取失败：来源状态与原因落月状态（数值不动，保留上次）
          await writeMonthState(project.id, wanted, month, 'events', {
            status: 'error', error: mr.detail.filter((d) => d.startsWith('events')).join(';') || 'events 抓取失败',
          });
        }
        result.months.push(mr);
      }

      // 同步结束：清 dirty（登记修订没变才清；守卫在 SQL 里）
      const articles = await db.listExternalArticles(project.id);
      for (const a of articles) {
        await db.clearExternalDirty(a.id, Number(a.registry_revision ?? 1));
      }
      await db.releaseMonitorSyncState(project.id, { runId, at: new Date().toISOString() });
      return result;
    } catch (e) {
      await db.releaseMonitorSyncState(project.id, {
        runId, at: new Date().toISOString(), lastError: String(e.message || e).slice(0, 500),
      });
      result.status = 'error';
      result.error = String(e.message || e);
      result.authError = isAuthError(e);
      return result;
    }
  }

  // 按域名分批抓取并合并：一批一个请求（inListFilter 限定来源域名），
  // 域名不跨批 → byDate 直接合并不重复累计；任一批截断 → 整个来源截断
  async function fetchByDomainChunks(fn, domainChunks) {
    const byDate = new Map();
    let truncated = false;
    for (const domains of domainChunks) {
      const r = await fn(domains);
      if (r.truncated) truncated = true;
      for (const [domain, dateMap] of r.byDate) {
        if (!byDate.has(domain)) byDate.set(domain, dateMap);
      }
    }
    return { byDate, truncated };
  }

  // 单个来源的抓取：鉴权错误直接抛（停止无意义重试）；截断/其它错误记来源失败
  async function safeQuery(fn, result, mr, source) {
    try {
      const r = await fn();
      if (r.truncated) {
        mr.detail.push(`${source} 返回行数达到上限，本月不写入（保留上次值）`);
        result.failed.push({ source, reason: 'truncated' });
        mr[source] = 'truncated';
        return { status: 'truncated', byDate: null };
      }
      return { status: 'ok', byDate: r.byDate };
    } catch (e) {
      if (isAuthError(e)) throw e;
      mr.detail.push(`${source} 抓取失败: ${e.message}`);
      result.failed.push({ source, reason: e.message });
      mr[source] = 'error';
      return { status: 'error', byDate: null };
    }
  }

  function rangeExceeded(months, reason) {
    const sorted = [...months].sort();
    const batches = [];
    for (let i = 0; i < sorted.length; i += MAX_MONTHS_PER_SYNC) batches.push(sorted.slice(i, i + MAX_MONTHS_PER_SYNC));
    return {
      status: 'range-exceeded', reason,
      hint: { maxMonthsPerSync: MAX_MONTHS_PER_SYNC, suggestedBatches: batches },
      months: [],
    };
  }

  // ---- 写入单元：一个域名一个来源的一批日期（完整业务单元） ----
  function buildDailyUnits(source, projectId, domains, dates, byDate, fingerprint, range, fetchedAt) {
    const units = [];
    for (const domain of domains) {
      const acc = byDate ? byDate.get(domain) : null;
      const field = source === 'users' ? 'users' : 'keyEvents';
      const rows = dates.map((date) => ({
        date,
        value: acc && acc.get(date) ? Number(acc.get(date)[field] || 0) : 0,
      }));
      units.push({
        ids: [`${domain}:${source}`],
        statements: [db.dailyWriteStmt(source, projectId, domain, rows, {
          fingerprint, fetchedAt,
        })],
      });
    }
    return units;
  }

  async function applyDailyUnits(units, month, source, result, mr) {
    let applied = 0;
    const r = await runUnitBatch(units, async (u) => {
      const res = await db.db.batchAtomic(u.statements);
      applied += Number(res[0].changes || 0);
    });
    result.fetched.days += applied;
    result.fetched.sourceMonths += 1;
    if (!units.length) return 'complete';
    if (r.failed.length) {
      mr.detail.push(`${source} 有 ${r.failed.length} 个写入单元失败`);
      result.failed.push({ source, count: r.failed.length });
      return 'partial';
    }
    return 'complete';
  }

  // 月状态：逐域名一个单元（ON CONFLICT 更新，幂等）
  async function writeMonthState(projectId, domains, month, source, { status, coverStart, coverEnd, fingerprint, fetchedAt, finalized, error }) {
    const col = source + '_status';
    const patch = { [col]: status };
    if (coverStart !== undefined) patch[source + '_cover_start'] = coverStart;
    if (coverEnd !== undefined) patch[source + '_cover_end'] = coverEnd;
    if (fingerprint !== undefined) patch[source + '_fingerprint'] = fingerprint;
    if (fetchedAt !== undefined) patch[source + '_fetched_at'] = fetchedAt;
    if (finalized !== undefined) patch.finalized = finalized;
    if (error !== undefined) patch.error = error;
    const units = domains.map((d) => ({
      ids: [d + ':' + source + ':state'],
      statements: [db.monthStateStmt(projectId, d, month, patch)],
    }));
    if (!units.length) return;
    await runUnitBatch(units, (u) => db.db.batchAtomic(u.statements));
  }

  return { planExternalDaily, fetchExternalDaily, fetchExternalDailyUnit, finalizeExternalDailyUnit };
}

module.exports = { createExternalDailyFetchers };
