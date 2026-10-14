const { isValidDay, monthOf, monthBounds, shiftMonth, safeMonthEnd } = require('./business-dates');
const { SOURCES, detailMonths } = require('./current-month');

// 业务窗口只由发布日期决定；实际来源覆盖独立记录，未知历史不能用临时值补足。
function publicationMonths(publishedAt, today, lagDays = 3) {
  if (!isValidDay(publishedAt) || publishedAt > today) return null;
  const months = [];
  for (let month = monthOf(publishedAt); month <= monthOf(today); month = shiftMonth(month, 1)) {
    if (safeMonthEnd(month, today, lagDays) === monthBounds(month).end) months.push(month);
  }
  return months;
}

function pairedConversion(views, events) {
  return views.value !== null && events.value !== null
    && views.startDate === events.startDate && views.endDate === events.endDate
    && views.fingerprint === events.fingerprint;
}

function rollupArticle(article, monthlyRows, currentRow, today, config) {
  const expected = publicationMonths(article.published_at, today);
  const rows = detailMonths(monthlyRows, currentRow, monthOf(today))
    .filter(row => !isValidDay(article.published_at) || row.month >= monthOf(article.published_at));
  const required = [config.gscConfigured && 'gsc', config.ga4Configured && 'views', config.ga4Configured && config.eventsConfigured && 'events'].filter(Boolean);
  const cum = { clicks: null, views: null, events: null, clicksKnown: false, viewsKnown: false, eventsKnown: false,
    completeMonths: 0, errorMonths: 0, mismatch: false, conversionViews: null, conversionEvents: null };
  const byMonth = new Map(rows.map(row => [row.month, row]));
  const coverage = Object.fromEntries(SOURCES.map(source => [source.key, { start: null, end: null, knownMonths: 0, fetchedAt: null, completeMonths: 0, missingMonths: [] }]));
  for (const row of rows) {
    for (const [source, key] of [['gsc', 'clicks'], ['views', 'views'], ['events', 'events']]) {
      const fact = row.sourceCoverage[source];
      if (fact.value === null) continue;
      cum[key] = (cum[key] ?? 0) + Number(fact.value); cum[key + 'Known'] = true;
      const c = coverage[source]; c.knownMonths++;
      if (fact.fetchedAt && (!c.fetchedAt || fact.fetchedAt > c.fetchedAt)) c.fetchedAt = fact.fetchedAt;
      if (fact.startDate && (!c.start || fact.startDate < c.start)) c.start = fact.startDate;
      if (fact.endDate && (!c.end || fact.endDate > c.end)) c.end = fact.endDate;
    }
    if (config.eventsConfigured && pairedConversion(row.sourceCoverage.views, row.sourceCoverage.events)) {
      cum.conversionViews = (cum.conversionViews ?? 0) + row.ga4Pageviews;
      cum.conversionEvents = (cum.conversionEvents ?? 0) + row.ga4KeyEvents;
    }
    const attempt = monthlyRows.find(value => value.month === row.month);
    if (required.some(source => row.sourceCoverage[source].state === 'error' || (source === 'gsc' ? attempt?.gsc_status : attempt?.ga4_status) === 'error')) cum.errorMonths++;
    if (row.mismatch) cum.mismatch = true;
  }
  for (const month of expected || []) {
    const row = byMonth.get(month), bounds = monthBounds(month);
    const start = article.published_at > bounds.start ? article.published_at : bounds.start;
    const complete = required.map(source => {
      const fact = row?.sourceCoverage[source];
      const valid = Boolean(fact && fact.state === 'complete' && fact.value !== null && !fact.provisional
        && fact.startDate && fact.startDate <= start && fact.endDate && fact.endDate >= bounds.end);
      if (valid) coverage[source].completeMonths++;
      else coverage[source].missingMonths.push(month);
      return valid;
    });
    if (complete.length && complete.every(Boolean)) cum.completeMonths++;
  }
  return { cum, rows, coverage, expectedMonths: expected?.length ?? null,
    coverageComplete: expected === null ? null : required.length > 0 && cum.completeMonths === expected.length };
}

module.exports = { publicationMonths, pairedConversion, rollupArticle };
