const createQueries = require('../db/queries/ai-performance');
const { businessDay, monthOf, shiftMonth } = require('../lib/business-dates');
const { evaluateArticle } = require('./performance/evaluate');
const { fail } = require('./contracts');
const { MODEL_INPUT_VERSION, buildNarrative } = require('./performance/narrative');
const {attachHistory,attachPeers}=require('./performance/history');

async function plan({ db, project, settings, now, assertActive }) {
  const asOfDay = businessDay(new Date(now));
  const currentMonth = monthOf(asOfDay);
  const baselineMonth = shiftMonth(currentMonth, -2);
  const comparisonMonth = shiftMonth(currentMonth, -1);
  const historyStart=shiftMonth(comparisonMonth,-Math.max((settings.performance?.history_months||12)-1,12));
  await assertActive();
  const { snapshot, guard } = await createQueries(db.db).aiPerformanceInput(project.id, {
    baselineMonth, historyStart, comparisonMonth, currentMonth, limit: settings.max_articles,
  });
  await assertActive();
  return {
    window_key: `${baselineMonth}:${comparisonMonth}`,
    input: {
      model_input_version: MODEL_INPUT_VERSION,
      project_id: project.id, as_of_day: asOfDay,
      window: { baseline: baselineMonth, comparison: comparisonMonth, current: currentMonth,history_start:historyStart },
      ...snapshot,
    },
    guards: [guard],
  };
}

async function run(ctx) {
  await ctx.assertActive();
  const { input, settings } = ctx;
  if (input.model_input_version !== MODEL_INPUT_VERSION) fail('STALE_AUTHORIZATION', '文章解读证据版本已变化，请重新运行');
  const counts = {
    processed: 0, total_active: input.total_active,
    skipped: Math.max(0, input.total_active - input.articles.length),
    review: 0, optimize: 0, observe: 0, unknown: 0,
    model_succeeded: 0, model_disabled: 0, model_failed: 0, source_errors: 0,
  };
  const cards = [];
  const warnings = [];
  if (counts.skipped) warnings.push({ code: 'ARTICLE_LIMIT', skipped: counts.skipped, limit: settings.max_articles });
  const prepared=input.articles.map(article=>{
    const args={article,monthly:input.monthly.filter(row=>row.article_id===article.id),current:input.current.find(row=>row.article_id===article.id),history:input.url_history.filter(row=>row.article_id===article.id),input,settings};
    return attachHistory(evaluateArticle(args),args);
  });
  attachPeers(prepared);
  for (const article of input.articles) {
    await ctx.assertActive();
    const card = prepared.find(card=>card.entity_key===String(article.id));
    for (const source of ['gsc', 'ga4']) {
      for (const profile of Object.values(card.sources[source])) {
        if (profile.status === 'error') {
          counts.source_errors++;
          warnings.push({ code: 'METRIC_SOURCE_ERROR', entity_key: card.entity_key, source, month: profile.month });
        }
      }
    }
    for (const [source, profile] of Object.entries(card.current_observation.sources)) {
      if (profile.state === 'error') {
        counts.source_errors++;
        warnings.push({ code: 'CURRENT_SOURCE_ERROR', entity_key: card.entity_key, source, month: input.window.current });
      }
    }
    await ctx.assertActive();
    const narrative = buildNarrative(card);
    card.evidence.push(narrative.stored);
    card.model = await ctx.explain([narrative.model]);
    await ctx.assertActive();
    if (card.model.status === 'succeeded') counts.model_succeeded++;
    else if (card.model.status === 'disabled') counts.model_disabled++;
    else {
      counts.model_failed++;
      warnings.push({ code: card.model.error_code || 'MODEL_UNAVAILABLE', entity_key: card.entity_key, status: card.model.status });
    }
    counts.processed++;
    counts[card.category]++;
    cards.push(card);
  }
  await ctx.assertActive();
  return { cards, counts, warnings };
}

module.exports = { plan, run };
