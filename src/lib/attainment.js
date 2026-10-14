// attainment.js —— 达标判定
//
// 契约：
//   - 阈值固定：点击 ≥20 或 浏览 ≥50 或 所选事件/浏览 ≥1%；不做项目阈值配置。
//   - 状态集：
//       observation      观察期：发布日期起不满 30 天
//       syncing          同步中：存在真实活动同步任务（观察期之后、证据之前）
//       attained         已达标：任一适用判据有已知证据即达标（部分范围超阈值也算）
//       data-issue       数据异常：未达标且覆盖不完整 / 有失败月
//       pending-key-events 待配置关键事件：GA4 已配置但没选关键事件，转化率判据无法评
//       not-attained     未达标：所有适用且覆盖完整的判据均未达标
//       pending          待判断：缺/未来发布日期、历史覆盖未知、无适用判据
//   - 达标率分母 = 命中数 − 观察期。
//   - 缺少发布日期时提示补填；不使用登记或创建日期替代。
//   - 转化率用同配置、同覆盖区间的事件与浏览；浏览 0 → NULL，该比率不参与；
//     不许拿历史基线或不同月份除出比率。
//   - 累计只汇总 complete 的月度行：全未知 NULL，部分已知标「范围不完整」。

const OBSERVATION_DAYS = 30;
const THRESHOLDS = { clicks: 20, views: 50, ratio: 0.01 };
const { isValidDay } = require('./business-dates');

// 两个业务日相差天数（date-only 减法）
function daysBetween(fromDay, toDay) {
  const a = Date.parse(fromDay + 'T00:00:00Z');
  const b = Date.parse(toDay + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

// 观察期只从发布日期起算；登记时间不能替代未知的业务日期。
function probationBasis(article) {
  const pub = String(article?.published_at || '').trim();
  return isValidDay(pub) ? pub : null;
}

// 累计汇总：只收 complete 的行。返回 { clicks, views, events, clicksKnown, viewsKnown,
// eventsKnown, completeMonths, errorMonths, mismatch } —— NULL=全未知。
function cumulative(monthlyRows = []) {
  const out = {
    clicks: null, views: null, events: null,
    clicksKnown: false, viewsKnown: false, eventsKnown: false,
    completeMonths: 0, errorMonths: 0, mismatch: false,
  };
  let clicks = 0, views = 0, events = 0;
  let anyClicks = false, anyViews = false, anyEvents = false;
  for (const r of monthlyRows) {
    if (r.gsc_status === 'complete') {
      out.completeMonths++;
      if (r.gsc_clicks !== null && r.gsc_clicks !== undefined) { clicks += Number(r.gsc_clicks); anyClicks = true; }
    }
    if (r.gsc_status === 'error') out.errorMonths++;
    if (r.ga4_status === 'complete') {
      if (r.ga4_pageviews !== null && r.ga4_pageviews !== undefined) { views += Number(r.ga4_pageviews); anyViews = true; }
      if (r.ga4_key_events !== null && r.ga4_key_events !== undefined) { events += Number(r.ga4_key_events); anyEvents = true; }
    }
    if (r.ga4_status === 'error') out.errorMonths++;
    if (r.mismatch) out.mismatch = true;
  }
  if (anyClicks) { out.clicks = clicks; out.clicksKnown = true; }
  if (anyViews) { out.views = views; out.viewsKnown = true; }
  if (anyEvents) { out.events = events; out.eventsKnown = true; }
  return out;
}

// 转化率：同源月度/浏览（月度行同源，天然同配置同覆盖）。两边都有完整数据且浏览>0
// 才有比率；浏览 0 → NULL（该比率不参与）；任一侧无完整数据 → uncovered。
function ratioOf(cum) {
  if ('conversionViews' in cum) {
    if (cum.conversionViews == null || cum.conversionEvents == null) return { ratio: null, uncovered: true };
    return { ratio: cum.conversionViews > 0 ? cum.conversionEvents / cum.conversionViews : null, uncovered: false };
  }
  if (!cum.eventsKnown || !cum.viewsKnown) return { ratio: null, uncovered: true };
  if (!cum.views) return { ratio: null, uncovered: false };
  return { ratio: cum.events / cum.views, uncovered: false };
}

// 主判定。输入：
//   article: { published_at, created_at, status }
//   cum: cumulative(monthlyRows) 的结果
//   opts: { today, gscConfigured, ga4Configured, eventsConfigured,
//           coverageComplete（null=业务起点未知）, expectedMonths, hasPendingMonths,
//           syncing（存在真实活动同步任务） }
// 「适用」由数据源配置决定（未配置项不参与）；「覆盖完整」由数据决定。
function evaluateAttainment(article, cum, opts = {}) {
  const {
    today, gscConfigured = false, ga4Configured = false, eventsConfigured = false,
    coverageComplete = null, expectedMonths = 0, hasPendingMonths = false, syncing = false,
  } = opts;
  const reasons = [];

  // 缺日期 / 未来日期 → 待判断（不把未来日期当观察期）
  const pub = article?.published_at;
  if (pub && !isValidDay(pub)) {
    return { status: 'pending', reasons: ['发布日期格式不正确'] };
  }
  if (pub && pub > today) {
    return { status: 'pending', reasons: ['发布日期晚于今天（日期异常）'] };
  }

  // 观察期：仅使用发布日起算 30 天
  const basis = probationBasis(article);
  if (!basis) {
    return { status: 'pending', reasons: ['请补填发布日期，无法判断业务范围与观察期'] };
  }
  if (basis > today) {
    return { status: 'pending', reasons: ['观察期基准日晚于今天（日期异常）'] };
  }
  const age = daysBetween(basis, today);
  if (age < OBSERVATION_DAYS) {
    return {
      status: 'observation',
      reasons: [`发布 ${age} 天，不满 ${OBSERVATION_DAYS} 天观察期`],
      ageDays: age,
    };
  }

  // 适用判据（未配置不参与）；一个都没配 → 待判断
  const applicable = [];
  if (gscConfigured) applicable.push('clicks');
  if (ga4Configured) applicable.push('views');
  if (ga4Configured && eventsConfigured) applicable.push('ratio');
  if (!applicable.length) {
    return { status: 'pending', reasons: ['未配置任何判定项（GSC/GA4 数据源）'], ageDays: age };
  }

  // 只有活动任务才表示执行中；dirty 和历史缺口不证明后台仍在运行。
  if (syncing) {
    return { status: 'syncing', reasons: ['存在活动同步任务，数据仍在更新'], ageDays: age };
  }

  const evidence = [];
  const uncovered = [];
  if (gscConfigured) {
    if (!cum.clicksKnown) uncovered.push('GSC 点击没有完整数据');
    else if (cum.clicks >= THRESHOLDS.clicks) evidence.push(`累计点击 ${cum.clicks} ≥ ${THRESHOLDS.clicks}`);
    else reasons.push(`累计点击 ${cum.clicks} < ${THRESHOLDS.clicks}`);
  }
  if (ga4Configured) {
    if (!cum.viewsKnown) uncovered.push('GA4 浏览没有完整数据');
    else if (cum.views >= THRESHOLDS.views) evidence.push(`累计浏览 ${cum.views} ≥ ${THRESHOLDS.views}`);
    else reasons.push(`累计浏览 ${cum.views} < ${THRESHOLDS.views}`);
  }
  if (ga4Configured && eventsConfigured) {
    const r = ratioOf(cum);
    if (r.uncovered) uncovered.push('转化率缺少完整数据');
    else if (r.ratio !== null && r.ratio >= THRESHOLDS.ratio) evidence.push(`转化率 ${(r.ratio * 100).toFixed(2)}% ≥ 1%`);
    else if (r.ratio !== null) reasons.push(`转化率 ${(r.ratio * 100).toFixed(2)}% < 1%`);
    // 浏览 0 → ratio null：不参与也不记未覆盖
  }

  // 任一适用判据有已知证据即达标（部分范围超阈值也算证据）
  if (evidence.length) return { status: 'attained', evidence, ageDays: age };

  // 无证据：覆盖不完整/失败月 → 数据异常；GA4 在但没配关键事件 → 待配置；否则未达标
  if (uncovered.length || coverageComplete !== true || cum.errorMonths > 0 || hasPendingMonths) {
    if (coverageComplete === null) reasons.push('发布日期或历史采集覆盖未知');
    else if (coverageComplete === false) reasons.push(`历史数据覆盖不完整（${cum.completeMonths}/${expectedMonths} 个月）`);
    reasons.push(...uncovered);
    if (cum.errorMonths) reasons.push(`${cum.errorMonths} 个月抓取失败`);
    if (hasPendingMonths) reasons.push('有月份还没同步');
    return { status: 'data-issue', reasons, ageDays: age };
  }
  if (ga4Configured && !eventsConfigured) {
    return { status: 'pending-key-events', reasons: ['GA4 已配置但未选择关键事件，转化率无法评定'], ageDays: age };
  }
  return { status: 'not-attained', reasons, ageDays: age };
}

// 达标率 = 已达标 / (总数 − 观察期)；分母 0 → null
function attainmentRate(summary) {
  const denom = (summary.total || 0) - (summary.observation || 0);
  if (!denom || denom <= 0) return { rate: null, numerator: summary.attained || 0, denominator: Math.max(denom, 0) };
  return { rate: (summary.attained || 0) / denom, numerator: summary.attained || 0, denominator: denom };
}

module.exports = {
  OBSERVATION_DAYS, THRESHOLDS,
  daysBetween, cumulative, ratioOf, evaluateAttainment, attainmentRate,
};
