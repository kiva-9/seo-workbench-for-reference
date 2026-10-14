const { businessDay, isValidDay, monthBounds } = require('../../lib/business-dates');
const { hash } = require('../contracts');

function number(value, { positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) return null;
  return value;
}
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}
function fetchedDay(value) {
  if (typeof value !== 'string' || !isValidDay(value.slice(0, 10))) return null;
  const iso = value.replace(' ', 'T');
  const at = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(iso) || isValidDay(iso) ? iso : `${iso}Z`);
  return Number.isFinite(at) ? businessDay(new Date(at)) : null;
}
function configurationKey(value) { return value ? hash(value) : null; }
function lastSuccess(row, prefix) {
  let config = null;
  try { config = JSON.parse(row?.[`${prefix}_success_config`] || 'null'); } catch { /* 不猜存量未知口径。 */ }
  return {
    value: number(row?.[`${prefix}_success_value`]),
    fetched_at: row?.[`${prefix}_success_at`] ?? null,
    cover_start: config?.cover_start ?? null,
    cover_end: config?.cover_end ?? null,
    configuration_key: configurationKey(config?.fingerprint),
    kind: config?.kind ?? null,
    comparable: false,
  };
}

function monthlySource(row, source, { month, article, fingerprint, asOfDay, staleDays }) {
  const bounds = monthBounds(month);
  const values = source === 'gsc'
    ? {
      clicks: number(row?.gsc_clicks), impressions: number(row?.gsc_impressions),
      reported_ctr: number(row?.gsc_ctr), position: number(row?.gsc_position, { positive: true }),
    }
    : { pageviews: number(row?.ga4_pageviews), key_events: number(row?.ga4_key_events) };
  if (source === 'gsc') values.ctr = values.clicks !== null && values.impressions > 0 ? values.clicks / values.impressions : null;
  const fetchedAt = row?.[`${source}_fetched_at`] ?? null;
  const day = fetchedDay(fetchedAt);
  const ageDays = day ? daysBetween(day, asOfDay) : null;
  const profile = {
    source: source.toUpperCase(), month, present: Boolean(row), values,
    status: row?.[`${source}_status`] ?? 'missing',
    coverage: {
      expected_start: bounds.start, expected_end: bounds.end,
      actual_start: row?.[`${source}_cover_start`] ?? null,
      actual_end: row?.[`${source}_cover_end`] ?? null,
      complete: Boolean(row && row.month_start === bounds.start && row.month_end === bounds.end &&
        row[`${source}_cover_start`] === bounds.start && row[`${source}_cover_end`] === bounds.end),
    },
    finalized: row?.[`${source}_finalized`] === 1,
    fetched_at: fetchedAt, fetched_day: day, age_days: ageDays,
    configuration_key: configurationKey(row?.[`${source}_config_fingerprint`]),
    expected_configuration_key: configurationKey(fingerprint),
    fetch_revision: row?.fetch_revision ?? null,
    issues: [], hard_issues: [], comparable: false, fresh: false,
    last_success: source === 'gsc' ? { clicks: lastSuccess(row, 'gsc') }
      : { pageviews: lastSuccess(row, 'ga4_views'), key_events: lastSuccess(row, 'ga4_key_events') },
  };
  const hard = code => { profile.hard_issues.push(code); profile.issues.push(code); };
  const soft = code => profile.issues.push(code);
  if (!row) hard('missing_month');
  else {
    if (profile.status !== 'complete') hard(`source_${profile.status}`);
    if (row.fetch_revision !== article.fetch_revision) hard('url_revision_changed');
    if (!fingerprint) hard('source_unconfigured');
    else if (row[`${source}_config_fingerprint`] !== fingerprint) hard('configuration_changed');
    if (row.month_start !== bounds.start || row.month_end !== bounds.end) hard('month_bounds_invalid');
    if (row.mismatch_present) hard('url_mapping_mismatch');
    if (!profile.coverage.complete) soft('partial_coverage');
    if (!profile.finalized) soft('source_not_finalized');
    if (!day) soft('freshness_unknown');
    else if (ageDays < 0) hard('future_sync_time');
    else {
      if (day < bounds.end) soft('source_delay');
      if (ageDays > staleDays) soft('stale_data');
    }
    const key = source === 'gsc' ? 'clicks' : 'pageviews';
    if (values[key] === null) hard('missing_primary_metric');
    if (source === 'gsc') {
      if (row.gsc_position !== null && row.gsc_position !== undefined && values.position === null) soft('position_unknown');
      if (values.impressions === null) soft('impressions_unknown');
    }
  }
  profile.comparable = profile.hard_issues.length === 0 && profile.coverage.complete && profile.finalized &&
    Boolean(day && ageDays >= 0 && day >= bounds.end);
  profile.fresh = profile.comparable && ageDays <= staleDays;
  return profile;
}

// 展示精度避免二进制小数把恰好一个百分点的边界判成未达门槛。
function rounded(value) { return value === null ? null : Number(value.toFixed(6)); }
function meets(value, threshold) {
  return value >= threshold || Math.abs(value - threshold) <= Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(threshold)) * 8;
}
function change(baseline, current) {
  if (baseline === null || current === null) return null;
  const absolute = current - baseline;
  const ratio = baseline > 0 ? absolute / baseline : null;
  return {
    baseline, current, absolute: rounded(absolute), ratio: rounded(ratio),
    percentage: ratio === null ? null : rounded(ratio * 100),
    zero_baseline: baseline === 0, from_zero: baseline === 0 && current > 0,
  };
}
function liveDays(publishedAt, month) {
  if (!isValidDay(publishedAt)) return null;
  const bounds = monthBounds(month);
  if (publishedAt > bounds.end) return 0;
  return daysBetween(publishedAt > bounds.start ? publishedAt : bounds.start, bounds.end) + 1;
}

module.exports = { number, daysBetween, fetchedDay, configurationKey, monthlySource, lastSuccess, rounded, meets, change, liveDays };
