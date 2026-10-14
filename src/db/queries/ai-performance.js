// 输入和守卫来自同一次 SELECT，避免读完指标后再采版本时漏掉并发同步。
const ARTICLE_FIELDS = [
  'id', 'project_id', 'url', 'title', 'keyword', 'published_at', 'status', 'sort_order',
  'fetch_revision', 'metrics_dirty', 'last_synced_at',
];
const MONTHLY_FIELDS = [
  'article_id', 'month', 'month_start', 'month_end', 'fetch_revision',
  'gsc_clicks', 'gsc_impressions', 'gsc_ctr', 'gsc_position',
  'ga4_pageviews', 'ga4_key_events',
  'gsc_status', 'gsc_cover_start', 'gsc_cover_end', 'gsc_fetched_at',
  'gsc_finalized', 'gsc_config_fingerprint',
  'ga4_status', 'ga4_cover_start', 'ga4_cover_end', 'ga4_fetched_at',
  'ga4_finalized', 'ga4_config_fingerprint',
  'gsc_success_value', 'gsc_success_config', 'gsc_success_at',
  'ga4_views_success_value', 'ga4_views_success_config', 'ga4_views_success_at',
  'ga4_key_events_success_value', 'ga4_key_events_success_config', 'ga4_key_events_success_at',
];
const CURRENT_FIELDS = [
  'article_id', 'project_id', 'month', 'range_start', 'gsc_end_date', 'ga4_end_date',
  'gsc_clicks', 'ga4_views', 'ga4_key_events',
  'gsc_state', 'ga4_views_state', 'ga4_key_events_state',
  'gsc_config_fingerprint', 'ga4_config_fingerprint', 'synced_at',
  'gsc_success_value', 'gsc_success_config', 'gsc_success_at',
  'ga4_views_success_value', 'ga4_views_success_config', 'ga4_views_success_at',
  'ga4_key_events_success_value', 'ga4_key_events_success_config', 'ga4_key_events_success_at',
];
const PROJECT_FIELDS = [
  'id', 'account_id', 'gsc_account_id', 'ga4_account_id', 'gsc_site',
  'ga4_property_id', 'key_event_names', 'config_revision',
];

function jsonObject(alias, fields, extra = []) {
  return `json_object(${[...fields.map(field => `'${field}',${alias}.${field}`), ...extra].join(',')})`;
}
function jsonArray(from, object, order) {
  return `json((SELECT json_group_array(${object}) FROM (SELECT * FROM ${from} ORDER BY ${order}) r))`;
}

const INPUT_SQL = `WITH selected AS (
  SELECT * FROM project_articles WHERE project_id=? AND status='active'
  ORDER BY COALESCE(sort_order,id),id LIMIT ?
)
SELECT json_object(
  'source_config',json((SELECT ${jsonObject('p', PROJECT_FIELDS)} FROM projects p WHERE p.id=?)),
  'total_active',(SELECT COUNT(*) FROM project_articles WHERE project_id=? AND status='active'),
  'articles',${jsonArray('selected', jsonObject('r', ARTICLE_FIELDS, [
    "'last_error_present',CASE WHEN r.last_error IS NOT NULL AND TRIM(r.last_error)<>'' THEN 1 ELSE 0 END",
  ]), 'COALESCE(sort_order,id),id')},
  'monthly',${jsonArray(`project_article_monthly_metrics m WHERE m.article_id IN (SELECT id FROM selected) AND m.month BETWEEN ? AND ?`, jsonObject('r', MONTHLY_FIELDS, [
    "'gsc_error_present',CASE WHEN r.gsc_error IS NOT NULL AND TRIM(r.gsc_error)<>'' THEN 1 ELSE 0 END",
    "'ga4_error_present',CASE WHEN r.ga4_error IS NOT NULL AND TRIM(r.ga4_error)<>'' THEN 1 ELSE 0 END",
    "'mismatch_present',CASE WHEN r.mismatch IS NOT NULL AND TRIM(r.mismatch)<>'' THEN 1 ELSE 0 END",
  ]), 'article_id,month')},
  'current',${jsonArray(`project_article_current_metrics c WHERE c.article_id IN (SELECT id FROM selected) AND c.project_id=(SELECT project_id FROM selected LIMIT 1) AND c.month=?`, jsonObject('r', CURRENT_FIELDS, [
    "'errors_present',CASE WHEN r.errors_json<>'[]' THEN 1 ELSE 0 END",
  ]), 'article_id')},
  'url_history',${jsonArray(`project_article_url_history h WHERE h.article_id IN (SELECT id FROM selected) AND h.project_id=(SELECT project_id FROM selected LIMIT 1)`, jsonObject('r', ['id', 'article_id', 'url', 'url_changed_at']), 'article_id,id')}
) AS snapshot`;

module.exports = backend => ({
  async aiPerformanceInput(projectId, { baselineMonth, historyStart=baselineMonth, comparisonMonth, currentMonth, limit }) {
    const args = [projectId, limit, projectId, projectId, historyStart, comparisonMonth, currentMonth];
    const row = await backend.prepare(INPUT_SQL).get(...args);
    return {
      snapshot: JSON.parse(row.snapshot),
      guard: { sql: INPUT_SQL, args, expected: row.snapshot },
    };
  },
});
