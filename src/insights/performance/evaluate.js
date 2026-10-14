const { VERSION } = require('../contracts');
const { monthBounds, isValidDay } = require('../../lib/business-dates');
const { buildArticleFingerprints } = require('../../lib/article-fingerprint');
const { parseKeyEventNames } = require('../../google/project-config');
const { parseGscSite, resolveGscUrl, ga4PathsForArticle } = require('../../lib/article-fetch-urls');
const { number, daysBetween, fetchedDay, monthlySource, lastSuccess, rounded, meets, change, liveDays } = require('./quality');

const ISSUE_LABELS = {
  missing_month: '缺少该完整月的记录，等待基线',
  source_error: '最近一次来源同步失败',
  source_pending: '来源尚未同步完成',
  source_unavailable: '来源不可用',
  source_unconfigured: '项目尚未配置该来源',
  url_revision_changed: '指标对应的 URL 修订与当前登记不同',
  configuration_changed: '来源配置与当前项目绑定不同或无法确认',
  month_bounds_invalid: '记录的自然月边界无效',
  url_mapping_mismatch: 'URL 映射或数据完整性存在异常，需复核',
  partial_coverage: '来源未覆盖整个自然月',
  source_not_finalized: '来源尚未定稿，可能仍受数据延迟影响',
  freshness_unknown: '缺少有效抓取时间，无法确认新鲜度',
  future_sync_time: '抓取时间晚于当前业务日',
  source_delay: '抓取时间早于完整月结束',
  stale_data: '抓取时间超过项目配置的新鲜度期限',
  missing_primary_metric: '关键指标未知或无效，不能视为零',
  position_unknown: '排名未知或无效，零不代表排名',
  impressions_unknown: '展示量未知，CTR 无法计算',
};

function currentObservation(article, row, window, fingerprints, rules, asOfDay) {
  function source(prefix, state, value, endDate, fingerprint) {
    const day = fetchedDay(row?.[`${prefix}_success_at`] || row?.synced_at);
    const start = row?.range_start ?? null;
    const rangeValid = isValidDay(start) && isValidDay(endDate) && start >= monthBounds(window.current).start &&
      endDate >= start && endDate <= asOfDay && endDate.slice(0, 7) === window.current;
    const configured = Boolean(fingerprint && row?.[prefix === 'gsc' ? 'gsc_config_fingerprint' : 'ga4_config_fingerprint'] === fingerprint);
    // empty 可能保留已成功覆盖的零值；无截止日期的占位零仍不能当作统计事实。
    const valid = ['complete', 'empty'].includes(state) && rangeValid && configured &&
      !article.metrics_dirty && value !== null && day && day >= endDate && day <= asOfDay;
    return {
      state: state ?? 'not_synced', value: valid ? value : null, stored_value: value,
      value_origin: valid ? (state === 'empty' ? 'retained_success_or_empty_probe' : 'latest_complete') : 'unverified',
      current_attempt_complete: state === 'complete',
      range_start: start, through: endDate ?? null, range_valid: Boolean(rangeValid),
      identity_verified: !article.metrics_dirty, configuration_matches: configured,
      fetched_at: row?.[`${prefix}_success_at`] || row?.synced_at || null,
      age_days: day ? daysBetween(day, asOfDay) : null,
      stale: day ? daysBetween(day, asOfDay) > rules.stale_days : null,
      last_success: lastSuccess(row, prefix),
    };
  }
  return {
    id: `article:${article.id}:current:${window.current}`, kind: 'current_observation',
    month: window.current, complete_month: false, comparable: false, comparison: null,
    status: row ? 'current_observation' : 'not_synced',
    sources: {
      gsc_clicks: source('gsc', row?.gsc_state, number(row?.gsc_clicks), row?.gsc_end_date, fingerprints.gsc),
      ga4_pageviews: source('ga4_views', row?.ga4_views_state, number(row?.ga4_views), row?.ga4_end_date, fingerprints.ga4),
      ga4_key_events: source('ga4_key_events', row?.ga4_key_events_state, number(row?.ga4_key_events), row?.ga4_end_date, fingerprints.ga4),
    },
    limitations: [
      '当月尚未结束；没有相同长度基线，不生成环比评价。',
      '本月临时表没有 GSC 展示、CTR 或排名，未补造这些字段。',
      ...(article.metrics_dirty && row ? ['文章有待刷新项，本月临时记录的 URL 修订无法独立确认，仅保留存储值供复核。'] : []),
    ],
  };
}

function evaluateArticle({ article, monthly, current, history, input, settings }) {
  const { window, as_of_day: asOfDay } = input;
  const rules = { ...settings.rules, position_min: settings.rules.position_min ?? 3, position_max: settings.rules.position_max ?? 20 };
  const fingerprints = buildArticleFingerprints(input.source_config || {});
  const eventsConfigured = parseKeyEventNames(input.source_config?.key_event_names).length > 0;
  const registeredUrls = [article.url, ...history.map(row => row.url)];
  const site = parseGscSite(input.source_config?.gsc_site);
  const mappings = registeredUrls.map(url => ({ registered_url: url, ...resolveGscUrl(url, site) }));
  const ga4Mapping = ga4PathsForArticle(registeredUrls);
  const sourceProfile = (month, source) => monthlySource(monthly.find(row => row.month === month), source, {
    month, article, fingerprint: fingerprints[source], asOfDay, staleDays: rules.stale_days,
  });
  const sources = {
    gsc: { baseline: sourceProfile(window.baseline, 'gsc'), current: sourceProfile(window.comparison, 'gsc') },
    ga4: { baseline: sourceProfile(window.baseline, 'ga4'), current: sourceProfile(window.comparison, 'ga4') },
  };
  const publishedValid = isValidDay(article.published_at) && article.published_at <= asOfDay;
  const maturity = {
    published_at: article.published_at ?? null,
    age_days: publishedValid ? daysBetween(article.published_at, asOfDay) : null,
    age_days_at_comparison_end: publishedValid ? daysBetween(article.published_at, monthBounds(window.comparison).end) : null,
    baseline_live_days: publishedValid ? liveDays(article.published_at, window.baseline) : null,
    comparison_live_days: publishedValid ? liveDays(article.published_at, window.comparison) : null,
    full_lifetime_coverage: publishedValid && article.published_at <= monthBounds(window.baseline).start,
    mature: false,
  };
  maturity.mature = maturity.full_lifetime_coverage && maturity.age_days_at_comparison_end >= rules.mature_days;

  const gscComparable = sources.gsc.baseline.comparable && sources.gsc.current.comparable && maturity.full_lifetime_coverage &&
    mappings.every(mapping => !mapping.error);
  const ga4Comparable = sources.ga4.baseline.comparable && sources.ga4.current.comparable && maturity.full_lifetime_coverage &&
    ga4Mapping.ambiguous.length === 0;
  const changes = {
    gsc_clicks: gscComparable ? change(sources.gsc.baseline.values.clicks, sources.gsc.current.values.clicks) : null,
    gsc_impressions: gscComparable ? change(sources.gsc.baseline.values.impressions, sources.gsc.current.values.impressions) : null,
    gsc_ctr: gscComparable ? change(sources.gsc.baseline.values.ctr, sources.gsc.current.values.ctr) : null,
    gsc_position: gscComparable ? change(sources.gsc.baseline.values.position, sources.gsc.current.values.position) : null,
    ga4_pageviews: ga4Comparable ? change(sources.ga4.baseline.values.pageviews, sources.ga4.current.values.pageviews) : null,
    ga4_key_events: ga4Comparable && eventsConfigured ? change(sources.ga4.baseline.values.key_events, sources.ga4.current.values.key_events) : null,
  };
  if (changes.gsc_ctr) changes.gsc_ctr.points = rounded((sources.gsc.current.values.ctr - sources.gsc.baseline.values.ctr) * 100);
  const reasons = [];
  const limitations = [];
  const hardIssues = [...sources.gsc.baseline.hard_issues, ...sources.gsc.current.hard_issues];
  if (mappings.some(mapping => mapping.error)) hardIssues.push('url_unresolved');
  if (article.published_at && (!isValidDay(article.published_at) || article.published_at > asOfDay)) hardIssues.push('published_date_invalid');
  for (const group of Object.values(sources)) {
    for (const profile of Object.values(group)) {
      for (const issue of profile.issues) limitations.push(`${profile.source} ${profile.month}：${ISSUE_LABELS[issue] || issue}。`);
    }
  }
  if (!publishedValid) limitations.push('无法确认有效发布日期，未把登记时间当作成熟度证据。');
  if (publishedValid && !maturity.full_lifetime_coverage) limitations.push('上线时间没有覆盖两个月的完整周期，未直接比较月度总量。');
  if (publishedValid && !maturity.mature) limitations.push(`截至比较月末未满足项目暂定的 ${rules.mature_days} 天成熟度门槛。`);
  if (article.last_error_present) limitations.push('文章最近一次同步记录有错误；仅展示来源事实，需核查最新同步。');
  if (!eventsConfigured) limitations.push('项目未配置 GA4 关键事件集合，关键事件未知值未按零处理。');
  if (ga4Mapping.ambiguous.length) limitations.push('GA4 登记地址存在跨主机同路径歧义，未计算浏览或关键事件变化。');
  if (registeredUrls.some(url => /[?#]/.test(url))) limitations.push('GSC 保留登记地址的查询参数；GA4 沿用既有 pagePath 聚合，不能据其区分查询参数页面。');
  limitations.push('平均排名是 GSC 按展示计算的指标，变化不等于逐个关键词的排名变化。');
  limitations.push('没有查询构成、SERP 或页面改动证据，变化原因仅能通过后续核查确认。');

  let category = 'observe';
  let priority = 20;
  const signals = [];
  const clicks = changes.gsc_clicks;
  const candidateReady = gscComparable && sources.gsc.baseline.fresh && sources.gsc.current.fresh && maturity.mature && !article.last_error_present;
  if (hardIssues.length) {
    category = 'unknown'; priority = 10; reasons.push(...new Set(hardIssues));
  } else if (!candidateReady) {
    if (!maturity.mature) reasons.push(publishedValid ? 'article_not_mature' : 'published_date_unknown');
    if (!sources.gsc.baseline.fresh || !sources.gsc.current.fresh) reasons.push('coverage_or_freshness_insufficient');
    if (article.last_error_present) reasons.push('latest_sync_failed');
  } else {
    if (rules.click_enabled && clicks && clicks.baseline > 0 && clicks.absolute !== 0 && clicks.baseline >= rules.min_baseline_clicks &&
      meets(Math.abs(clicks.current - clicks.baseline), rules.min_click_change) &&
      meets(Math.abs((clicks.current - clicks.baseline) / clicks.baseline), rules.click_change_ratio)) {
      signals.push(clicks.absolute < 0 ? 'click_decline' : 'click_growth');
    }
    const ctrDrop = changes.gsc_ctr ? (sources.gsc.baseline.values.ctr - sources.gsc.current.values.ctr) * 100 : null;
    const comparison = sources.gsc.current.values;
    if (rules.ctr_enabled && ctrDrop !== null && ctrDrop > 0 && meets(ctrDrop, rules.ctr_drop_points) &&
      comparison.impressions >= rules.min_impressions && comparison.position !== null &&
      comparison.position >= rules.position_min && comparison.position <= rules.position_max) signals.push('ctr_opportunity');
    if (signals.includes('click_decline')) { category = 'optimize'; priority = 90; }
    else if (signals.includes('ctr_opportunity')) { category = 'optimize'; priority = 80; }
    else if (signals.includes('click_growth')) { category = 'review'; priority = 70; }
    reasons.push(...signals);
    if (!signals.length) {
      if (!rules.click_enabled && !rules.ctr_enabled) reasons.push('rules_disabled');
      else if (clicks?.zero_baseline) reasons.push('zero_baseline');
      else if (clicks && clicks.baseline < rules.min_baseline_clicks) reasons.push('low_sample');
      else reasons.push('below_candidate_thresholds');
    }
  }

  const clickFact = clicks ? `GSC 点击 ${clicks.baseline} → ${clicks.current}，绝对变化 ${clicks.absolute}` +
    (clicks.percentage === null ? `（${clicks.from_zero ? '从零起量' : '零基期'}，不计算百分比）` : `（${clicks.percentage}%）`) : 'GSC 点击缺少可比的完整月证据';
  const summaries = {
    review: `${clickFact}，达到项目暂定的复盘候选规则；建议核查可复用的选题与结构。`,
    optimize: `${clickFact}${signals.includes('ctr_opportunity') ? `；CTR 下降 ${-changes.gsc_ctr.points} 个百分点` : ''}，进入优先优化候选；原因尚未确认。`,
    observe: `${clickFact}；继续观察，当前证据未满足自动候选条件。`,
    unknown: `${clickFact}；无法判断，需先补齐或核查数据口径与同步状态。`,
  };
  const observation = currentObservation(article, current, window, fingerprints, rules, asOfDay);
  const evidence = [
    {
      id: `article:${article.id}:identity`, kind: 'article_identity', project_id: article.project_id,
      article_id: article.id, title: article.title || '', registered_keyword:article.keyword||null, registered_url: article.url,
      fetch_revision: article.fetch_revision, status: article.status,
      registered_urls: registeredUrls, url_history: history,
      gsc_mapping: mappings, ga4_mapping: { paths: ga4Mapping.paths, ambiguous: ga4Mapping.ambiguous }, maturity,
    },
    ...Object.values(sources).flatMap(group => Object.values(group).map(profile => ({
      id: `article:${article.id}:${profile.source.toLowerCase()}:${profile.month}`, kind: 'monthly_metrics', ...profile,
    }))),
    {
      id: `article:${article.id}:comparison:${window.baseline}:${window.comparison}`, kind: 'deterministic_comparison',
      period: { baseline: window.baseline, comparison: window.comparison },
      comparable: { gsc: gscComparable, ga4: ga4Comparable }, eligible_for_classification: candidateReady,
      changes, category, reasons, signals, source_scope: 'onsite_url_metrics',
    },
    { id: `rules:${VERSION}`, kind: 'rules', version: VERSION, status: 'provisional', label: '暂定规则，待项目历史样本校准', values: rules },
    observation,
  ];
  const completeObservation = category === 'observe' && gscComparable;
  const needsSamples = completeObservation && reasons.some(reason => ['low_sample', 'zero_baseline'].includes(reason));
  const checks = category === 'review'
    ? ['核查查询构成、推广活动与页面改动记录，再判断选题和结构是否可复用。']
    : category === 'optimize'
      ? ['核查查询构成与 SERP 展示，人工检查搜索结果标题、页面内容和近期改动。']
      : needsSamples
        ? ['继续积累搜索样本，结合后续完整月观察变化；现有基线已可比较。']
        : completeObservation && !maturity.mature
          ? ['继续观察文章成熟度，保留现有完整月事实，暂不作强候选判断。']
          : completeObservation && !candidateReady
            ? ['先核查统计来源新鲜度和最新同步状态，再结合完整月事实继续观察。']
        : completeObservation
          ? ['持续观察后续完整月趋势，必要时核查查询构成和近期页面改动。']
          : ['核查发布日期、完整月覆盖、来源配置与最近一次同步，等待可比基线。'];
  // 模型需同时看到界面采用的判断和限制，避免仅凭指标扩大结论。
  const decision = {
    id: `article:${article.id}:decision:${window.baseline}:${window.comparison}`, kind: 'deterministic_decision',
    category, summary: summaries[category], limitations: [...new Set(limitations)],
    recommended_checks: checks,
    suggested_actions: category === 'review' ? ['人工标记值得复盘的内容，核查后再提炼经验。']
      : category === 'optimize' ? ['先确认数据与可能原因，再由人工决定优化动作。']
        : needsSamples ? ['继续积累搜索样本，暂不据此判定表现差。']
          : completeObservation && !candidateReady ? ['复核成熟度或同步状态后，结合完整月事实继续观察。']
          : completeObservation ? ['保持观察，结合后续完整月再核查候选条件。'] : ['补齐数据并继续观察。'],
  };
  evidence.push(decision);
  return {
    entity_key: String(article.id), project_id: article.project_id, category, priority,
    title: article.title || article.url, url: mappings[0]?.url ?? null,
    summary: decision.summary, evidence, limitations: decision.limitations,
    period: { baseline: window.baseline, comparison: window.comparison },
    source_scope: 'onsite_url_metrics', as_of_day: asOfDay, sources, changes, maturity,
    rule_status: 'provisional', rules_version: VERSION, reasons, signals,
    current_observation: observation, recommended_checks: decision.recommended_checks,
    suggested_actions: decision.suggested_actions,
    provenance: 'stored_metrics',
  };
}

module.exports = { evaluateArticle };
