// current-month.js —— 本月临时数据的纯函数：窗口、合并、读时折算
//
// 三处读取共用同一套口径，行为不分叉：
//   - 列表累计/达标（瘦聚合行）：月度表只算「已过去的完整月」，本月临时行按来源折算后加上去；
//   - 展开明细：本月临时行单独一行展示（各源截止日 + 同步时间）；
//   - XLSX 导出：与列表同口径，月度矩阵里本月行标「含临时数据」。
//
// 接管规则：某个来源在月度表里
// 已有「完整 + 有值 + 定稿 + 抓取时间已过月末+3 天」的行，正式值接管该来源；否则临时值
// 继续生效（失败/未定稿的月度行不能把本月已有贡献顶掉）。

const { monthBounds, monthOf } = require('./business-dates');
const { settledDate } = require('../google/freshness');

// current = 临时表列名；monthly = 月度表列名；state/end = 临时表的状态与截止日列
const SOURCES = [
  { key: 'gsc', current: 'gsc_clicks', monthly: 'gsc_clicks', state: 'gsc_state', end: 'gsc_end_date' },
  { key: 'views', current: 'ga4_views', monthly: 'ga4_pageviews', state: 'ga4_views_state', end: 'ga4_end_date' },
  { key: 'events', current: 'ga4_key_events', monthly: 'ga4_key_events', state: 'ga4_key_events_state', end: null },
];

// 本月（临时数据所属月）
function currentMonthOf(today) {
  return monthOf(today);
}

// 最新日期落在本月之前（每月头一两天）时窗口为空：明细显示「本月数据暂未产生」。
function currentWindow(month, latestDate) {
  const range = monthBounds(month);
  const latest = /^\d{4}-\d{2}-\d{2}$/.test(String(latestDate || '')) ? latestDate : null;
  if (!latest || latest < range.start) {
    return { startDate: range.start, endDate: null, empty: true };
  }
  return { startDate: range.start, endDate: latest > range.end ? range.end : latest, empty: false };
}

// 探测响应 → 最新日期（GSC 行是 {keys:[date]}，GA4 行是 {dimensionValues:[{value:'YYYYMMDD'}]}）
function latestGscDateOf(rows) {
  const dates = (rows || []).map((r) => String(r?.keys?.[0] || '')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return dates.length ? dates.sort().at(-1) : null;
}

function latestGa4DateOf(rows) {
  const dates = (rows || [])
    .map((r) => String(r?.dimensionValues?.[0]?.value || ''))
    .map((v) => (/^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : ''))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return dates.length ? dates.sort().at(-1) : null;
}

// 临时行的「有效值」：empty 且从来没有过成功值时是 0 占位（探测结论：本月还没有
// 任何数据）；unavailable/unconfigured/pending 都没有本月贡献（null）。
function provisionalValue(row, source) {
  if (!row) return null;
  const state = row[source.state];
  if (state !== 'complete' && state !== 'empty') {
    const factColumn = source.key === 'gsc' ? 'gsc_success_value' : source.key === 'views' ? 'ga4_views_success_value' : 'ga4_key_events_success_value';
    const fact = row[factColumn];
    return fact == null ? null : Number(fact);
  }
  const raw = row[source.current];
  if (raw === null || raw === undefined) return state === 'empty' ? 0 : null;
  return Number(raw);
}

// 正式行是否接管某来源：完整 + 有值 + 定稿 + 抓取时间已过定稿日（月末+3 天）
function formalTakesOver(monthlyRow, source, month) {
  if (!monthlyRow || monthlyRow.month !== month) return false;
  const status = source.key === 'gsc' ? monthlyRow.gsc_status : monthlyRow.ga4_status;
  if (status !== 'complete') return false;
  const value = monthlyRow[source.monthly];
  if (value === null || value === undefined) return false;
  const finalized = source.key === 'gsc' ? monthlyRow.gsc_finalized : monthlyRow.ga4_finalized;
  if (!finalized) return false;
  const fetched = String((source.key === 'gsc' ? monthlyRow.gsc_fetched_at : monthlyRow.ga4_fetched_at) || '').slice(0, 10);
  const settled = settledDate(monthBounds(month).end);
  return Boolean(settled) && fetched >= settled;
}

// 一个来源在某月的「有效结果」：谁生效、值多少、截止日、状态。
// monthlyRow = 月度表同月行（可不存在）；currentRow = 临时行（可不存在）。
function effectiveSource(monthlyRow, currentRow, source, month) {
  const prefix = source.key === 'gsc' ? 'gsc' : source.key === 'views' ? 'ga4_views' : 'ga4_key_events';
  const fingerprintColumn = source.key === 'gsc' ? 'gsc_config_fingerprint' : 'ga4_config_fingerprint';
  const readConfig = row => {
    try { return JSON.parse(row?.[prefix + '_success_config'] || '{}'); } catch { return {}; }
  };
  const current = currentRow?.month === month ? currentRow : null;
  const monthly = monthlyRow?.month === month ? monthlyRow : null;
  const temporary = () => {
    const state = current[source.state], fromLastSuccess = state !== 'complete' && current[prefix + '_success_value'] != null;
    const config = readConfig(current);
    const useConfig = fromLastSuccess || (state === 'empty' && current[prefix + '_success_value'] != null);
    const hasCoverage = state === 'complete' || useConfig;
    return { value: provisionalValue(current, source), provisional: true, state, fromLastSuccess,
      startDate: hasCoverage ? (useConfig ? config.cover_start : current.range_start) || null : null,
      endDate: hasCoverage ? (useConfig ? config.cover_end : current[source.end || 'ga4_end_date']) || null : null,
      fingerprint: (useConfig ? config.fingerprint : current[fingerprintColumn]) || null,
      fetchedAt: (useConfig ? current[prefix + '_success_at'] : current.synced_at) || null };
  };
  const formal = () => {
    const state = source.key === 'gsc' ? monthly.gsc_status : monthly.ga4_status;
    const fromLastSuccess = state !== 'complete' && monthly[prefix + '_success_value'] != null;
    const config = readConfig(monthly), gsc = source.key === 'gsc';
    return { value: monthlyValue(monthly, source.key), provisional: false, state, fromLastSuccess,
      startDate: (fromLastSuccess ? config.cover_start : monthly[gsc ? 'gsc_cover_start' : 'ga4_cover_start']) || null,
      endDate: (fromLastSuccess ? config.cover_end : monthly[gsc ? 'gsc_cover_end' : 'ga4_cover_end']) || null,
      fingerprint: (fromLastSuccess ? config.fingerprint : monthly[fingerprintColumn]) || null,
      fetchedAt: (fromLastSuccess ? monthly[prefix + '_success_at'] : monthly[gsc ? 'gsc_fetched_at' : 'ga4_fetched_at']) || null };
  };
  let result;
  if (monthly && formalTakesOver(monthly, source, month)) result = formal();
  else if (current && provisionalValue(current, source) !== null) result = temporary();
  else if (monthly && monthlyValue(monthly, source.key) !== null) result = formal();
  else if (current) result = temporary();
  else if (monthly) result = formal();
  else result = { value: null, provisional: false, endDate: null, startDate: null, fingerprint: null, state: 'pending', fromLastSuccess: false };
  return { ...result, active: result.value !== null };
}

// 最后成功事实列（迁移 0009）：gsc 点击数 / GA4 浏览 / GA4 关键事件 各自独立
const FACT_VALUE_COLS = { gsc: 'gsc_success_value', views: 'ga4_views_success_value', events: 'ga4_key_events_success_value' };

// 月度行的展示值：attempt 完整用尝试值，否则回退最后成功事实。
function monthlyValue(m, key) {
  const spec = SOURCES.find((x) => x.key === key);
  const attemptOk = key === 'gsc' ? m.gsc_status === 'complete' : m.ga4_status === 'complete';
  if (attemptOk) return m[spec.monthly] ?? null;
  const fact = m[FACT_VALUE_COLS[key]];
  return fact === null || fact === undefined ? null : Number(fact);
}

// 这个来源本次是否在展示「旧成功值」
function monthlyFromLastSuccess(m, key) {
  const attemptOk = key === 'gsc' ? m.gsc_status === 'complete' : m.ga4_status === 'complete';
  if (attemptOk) return false;
  return m[FACT_VALUE_COLS[key]] !== null && m[FACT_VALUE_COLS[key]] !== undefined;
}

// 明细面板行：结束月份用月度行；本月（或跨月未接管的临时残留）单独一行。
function currentGscDetails(row) {
  if (!row) return { impressions: null, ctr: null, position: null };
  if (row.gsc_state !== 'complete' && row.gsc_success_details) {
    try { return JSON.parse(row.gsc_success_details || '{}'); } catch { return {}; }
  }
  return { impressions: row.gsc_impressions ?? null, ctr: row.gsc_ctr ?? null, position: row.gsc_position ?? null };
}

function detailMonths(monthlyRows, currentRow, currentMonth) {
  const monthlyByMonth = new Map((monthlyRows || []).map(row => [row.month, row]));
  const months = new Set(monthlyByMonth.keys());
  if (currentRow && currentRow.month <= currentMonth) months.add(currentRow.month);
  return [...months].filter(month => month <= currentMonth).sort().reverse().map(month => {
    const m = monthlyByMonth.get(month), c = currentRow?.month === month ? currentRow : null;
    const [gsc, views, events] = SOURCES.map(source => effectiveSource(m, c, source, month));
    const extras = gsc.provisional ? currentGscDetails(c) : { impressions: m?.gsc_impressions, ctr: m?.gsc_ctr, position: m?.gsc_position };
    return { month, rangeStart: [gsc.startDate, views.startDate].filter(Boolean).sort()[0] || m?.month_start || c?.range_start || null,
      rangeEnd: [gsc.endDate, views.endDate].filter(Boolean).sort().at(-1) || m?.month_end || null,
      gscClicks: gsc.value, gscImpressions: extras.impressions ?? null, gscCtr: extras.ctr ?? null, gscPosition: extras.position ?? null,
      ga4Pageviews: views.value, ga4KeyEvents: events.value,
      gscCoverStart: gsc.startDate, ga4CoverStart: views.startDate, gscCoverEnd: gsc.endDate, ga4CoverEnd: views.endDate,
      gscFinalized: !gsc.provisional && m?.gsc_finalized ? 1 : 0, ga4Finalized: !views.provisional && m?.ga4_finalized ? 1 : 0,
      provisional: gsc.provisional || views.provisional || events.provisional,
      fromLastSuccess: { gsc: gsc.fromLastSuccess, views: views.fromLastSuccess, events: events.fromLastSuccess },
      sourceCoverage: { gsc, views, events }, state: { gsc: gsc.state, views: views.state, events: events.state },
      mismatch: m?.mismatch || null, syncedAt: c?.synced_at || null, errors: c ? safeParse(c.errors_json) : [], isCurrentMonth: month === currentMonth };
  });
}

// 列表累计的本月折算。调用方传来的 rollup 来自 SQL 聚合（含「已过去的完整月」）：
//   - 当前月的月度残留在 SQL 里已被排除，这里直接把临时值加上去；
//   - 过渡月（月份已翻页、临时行还没刷新）的月度行**已算进 SQL**：正式值接管时
//     什么都不做（SQL 已经算对）；临时值生效时先把正式值剔掉、再加临时值——
//     同一个月只能有一份贡献，不能双倍。
function foldIntoRollup(rollup, currentRow, monthlyRowForSameMonth, month) {
  const out = { ...rollup };
  if (!currentRow || currentRow.month !== month) return out;
  for (const source of SOURCES) {
    const key = source.key === 'gsc' ? 'clicks' : source.key === 'views' ? 'views' : 'events';
    const eff = effectiveSource(monthlyRowForSameMonth, currentRow, source, month);
    // SQL 同样包含失败时保留的成功事实，替换必须扣除实际已计入的那一份。
    const counted = monthlyRowForSameMonth?.month === month ? monthlyValue(monthlyRowForSameMonth, source.key) : null;
    if (counted !== null) out[key] = (out[key] ?? 0) - Number(counted);
    if (eff.value !== null) { out[key] = (out[key] ?? 0) + eff.value; out[key + 'Known'] = true; }
  }
  // 临时指标不增加历史完整月。过渡月的错误状态也只按月份调整一次。
  const monthlyError = monthlyRowForSameMonth && (monthlyRowForSameMonth.gsc_status === 'error' || monthlyRowForSameMonth.ga4_status === 'error');
  const effectiveError = SOURCES.some(source => effectiveSource(monthlyRowForSameMonth, currentRow, source, month).state === 'error');
  out.errorMonths = Math.max(0, out.errorMonths || 0);
  if (!monthlyError && effectiveError) out.errorMonths = (out.errorMonths || 0) + 1;
  return out;
}

// 明细面板的「本月临时」行；还没有临时行时给等待/同步中文案
function currentMonthDetail(currentRow, syncState, month) {
  if (!currentRow) {
    const waiting = syncState && ['queued', 'running'].includes(syncState.status)
      ? '本月数据同步中…' : '本月数据等待首次同步';
    return { month, state: 'waiting', note: waiting, gscEndDate: null, ga4EndDate: null, clicks: null, views: null, syncedAt: null };
  }
  return {
    month: currentRow.month,
    state: 'ready',
    gscEndDate: effectiveSource(null, currentRow, SOURCES[0], currentRow.month).endDate,
    ga4EndDate: effectiveSource(null, currentRow, SOURCES[1], currentRow.month).endDate,
    gscImpressions: currentGscDetails(currentRow).impressions ?? null,
    gscCtr: currentGscDetails(currentRow).ctr ?? null,
    gscPosition: currentGscDetails(currentRow).position ?? null,
    clicks: provisionalValue(currentRow, SOURCES[0]),
    views: provisionalValue(currentRow, SOURCES[1]),
    events: provisionalValue(currentRow, SOURCES[2]),
    sourceState: {
      gsc: currentRow.gsc_state, views: currentRow.ga4_views_state, events: currentRow.ga4_key_events_state,
    },
    errors: safeParse(currentRow.errors_json),
    syncedAt: currentRow.synced_at,
    syncStatus: syncState?.status || null,
  };
}

function safeParse(json) {
  try { return JSON.parse(json || '[]'); } catch { return []; }
}

module.exports = {
  SOURCES, currentMonthOf, currentWindow, latestGscDateOf, latestGa4DateOf,
  provisionalValue, formalTakesOver, effectiveSource, detailMonths,
  foldIntoRollup, currentMonthDetail,
  monthlyValue, monthlyFromLastSuccess, currentGscDetails, FACT_VALUE_COLS,
};
