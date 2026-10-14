// article-current.js —— 本月临时数据的读写
//
// 写入是「整行覆盖」：每篇文章一行、每轮重算所有来源。探测失败时截止日沿用上一次
// 成功值（限本月）——否则一轮失败会把本月临时行从统计窗口里抹掉。

const { now } = require('../helpers');
const { buildArticleFingerprints } = require('../../lib/article-fingerprint');

module.exports = (db) => ({
  // 项目级同步状态（明细面板的「本月数据同步中…」用）
  getCurrentSyncState: async (projectId) => db.prepare(
    'SELECT * FROM project_article_current_sync_state WHERE project_id = ?'
  ).get(projectId),

  setCurrentSyncState: async (projectId, patch) => {
    const at = now();
    await db.prepare(
      `INSERT INTO project_article_current_sync_state
        (project_id, status, month, gsc_end_date, ga4_end_date, external_requests, rows_written,
         last_synced_at, last_error, updated_at)
       VALUES (@pid, @status, @month, @gscEnd, @ga4End, @req, @rows, @syncedAt, @err, @at)
       ON CONFLICT(project_id) DO UPDATE SET
         status = excluded.status, month = excluded.month,
         gsc_end_date = excluded.gsc_end_date, ga4_end_date = excluded.ga4_end_date,
         external_requests = excluded.external_requests, rows_written = excluded.rows_written,
         last_synced_at = excluded.last_synced_at, last_error = excluded.last_error,
         updated_at = excluded.updated_at`
    ).run({
      pid: projectId, status: patch.status, month: patch.month ?? null,
      gscEnd: patch.gscEndDate ?? null, ga4End: patch.ga4EndDate ?? null,
      req: Number(patch.externalRequests || 0), rows: Number(patch.rowsWritten || 0),
      syncedAt: patch.lastSyncedAt ? String(patch.lastSyncedAt).slice(0, 20) : null,
      err: patch.lastError ? String(patch.lastError).slice(0, 500) : null, at,
    });
  },

  // 批量读临时行（列表/导出用）
  listCurrentForArticles: async (articleIds) => {
    const ids = [...new Set((articleIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return [];
    return db.prepare(
      `SELECT * FROM project_article_current_metrics WHERE article_id IN (SELECT value FROM json_each(?))`
    ).all(JSON.stringify(ids));
  },

  getCurrentForArticle: async (articleId) => db.prepare(
    'SELECT * FROM project_article_current_metrics WHERE article_id = ?'
  ).get(articleId),

  // 本月起始后各来源已成功写入的截止日（探测失败时保留旧窗口用）
  latestCurrentEndDates: async (projectId, month, startDate) => {
    const rows = await db.prepare(
      'SELECT gsc_end_date, ga4_end_date FROM project_article_current_metrics WHERE project_id = ? AND month = ?'
    ).all(projectId, month);
    const max = (a, b) => (b && b >= startDate && (!a || b > a) ? b : a);
    let gsc = null; let ga4 = null;
    for (const r of rows) {
      gsc = max(gsc, r.gsc_end_date);
      ga4 = max(ga4, r.ga4_end_date);
    }
    return { gscEndDate: gsc, ga4EndDate: ga4 };
  },

  // 保存来源级成功事实与配置，失败只推进尝试层；换月不能沿用上个月事实。
  upsertCurrentRows: async (projectId, rows, options = {}) => {
    if (!rows.length) return 0;
    const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return 0;
    const fingerprints = options.fingerprints || buildArticleFingerprints(project);
    const configRevision = options.configRevision ?? project.config_revision;
    const at = now();
    const cols = [
      'article_id', 'project_id', 'month', 'range_start', 'gsc_end_date', 'ga4_end_date',
      'gsc_clicks', 'ga4_views', 'ga4_key_events', 'gsc_impressions', 'gsc_ctr', 'gsc_position',
      'gsc_state', 'ga4_views_state', 'ga4_key_events_state', 'errors_json', 'synced_at', 'updated_at',
      'gsc_config_fingerprint', 'ga4_config_fingerprint',
      'gsc_success_value', 'gsc_success_config', 'gsc_success_at', 'gsc_success_details',
      'ga4_views_success_value', 'ga4_views_success_config', 'ga4_views_success_at',
      'ga4_key_events_success_value', 'ga4_key_events_success_config', 'ga4_key_events_success_at',
    ];
    const selected=c=>!options.source || !/^(gsc_|ga4_)/.test(c) || c.startsWith(options.source+'_');
    const facts = [
      { prefix: 'gsc', state: 'gsc_state', value: 'gsc_clicks', end: 'gsc_end_date', fingerprint: 'gsc_config_fingerprint' },
      { prefix: 'ga4_views', state: 'ga4_views_state', value: 'ga4_views', end: 'ga4_end_date', fingerprint: 'ga4_config_fingerprint' },
      { prefix: 'ga4_key_events', state: 'ga4_key_events_state', value: 'ga4_key_events', fingerprint: 'ga4_config_fingerprint' },
    ];
    // 空探测不是新的取数成功。即使上次尝试失败，同月同配置的成功事实仍是有效回退。
    const preserveEmpty = f => `excluded.${f.state}='empty'
      AND project_article_current_metrics.month=excluded.month
      AND ${f.prefix}_success_value IS NOT NULL
      AND json_extract(${f.prefix}_success_config,'$.fingerprint')=excluded.${f.fingerprint}`;
    const regular = cols.slice(2).filter(c => !c.includes('_success_')).map(c => {
      if (!selected(c)) return `${c} = CASE WHEN project_article_current_metrics.month=excluded.month THEN project_article_current_metrics.${c} ELSE excluded.${c} END`;
      const f = facts.find(f => f.value === c || f.end === c);
      if (!f) return `${c} = excluded.${c}`;
      const retained = c === f.value ? `${f.prefix}_success_value` : `json_extract(${f.prefix}_success_config,'$.cover_end')`;
      return `${c} = CASE WHEN ${preserveEmpty(f)} THEN ${retained} ELSE excluded.${c} END`;
    });
    const factUpdates = cols.filter(c => c.includes('_success_')).map(c => {
      const prefix = c.slice(0, c.indexOf('_success_'));
      const f = facts.find(f => f.prefix === prefix);
      return `${c} = CASE WHEN ${selected(c)?`excluded.${prefix}_success_value IS NOT NULL AND NOT (${preserveEmpty(f)})`:'0'} THEN excluded.${c}
        WHEN project_article_current_metrics.month = excluded.month THEN project_article_current_metrics.${c} END`;
    });
    const stmt = db.prepare(`INSERT INTO project_article_current_metrics (${cols.join(', ')})
      SELECT ${cols.map(() => '?').join(', ')}
      WHERE (SELECT config_revision FROM projects WHERE id = ?) = ?
        AND EXISTS (SELECT 1 FROM project_articles a WHERE a.id = ? AND a.project_id = ?
          AND a.status = 'active' AND (? IS NULL OR a.fetch_revision = ?))
      ON CONFLICT(article_id) DO UPDATE SET ${[...regular, ...factUpdates].join(', ')}`);
    const fact = (state, value, fingerprint, endDate, rangeStart) => {
      const known = state === 'complete' && value != null ? Number(value)
        : state === 'empty' && value == null ? 0 : null;
      return known === null ? [null, null, null]
        : [known, JSON.stringify({ kind: 'v2', fingerprint, cover_start: rangeStart, cover_end: endDate ?? null }), at];
    };
    const bound = rows.map(r => stmt.bind(
      r.articleId, projectId, r.month, r.rangeStart,
      r.gscEndDate ?? null, r.ga4EndDate ?? null,
      r.gscClicks ?? null, r.ga4Views ?? null, r.ga4KeyEvents ?? null,
      r.gscImpressions ?? null, r.gscCtr ?? null, r.gscPosition ?? null,
      r.gscState, r.ga4ViewsState, r.ga4KeyEventsState,
      JSON.stringify(r.errors || []), at, at, fingerprints.gsc, fingerprints.ga4,
      ...fact(r.gscState, r.gscClicks, fingerprints.gsc, r.gscEndDate, r.rangeStart),
      r.gscState === 'complete' && r.gscClicks != null
        ? JSON.stringify({ impressions: r.gscImpressions ?? null, ctr: r.gscCtr ?? null, position: r.gscPosition ?? null }) : null,
      ...fact(r.ga4ViewsState, r.ga4Views, fingerprints.ga4, r.ga4EndDate, r.rangeStart),
      ...fact(r.ga4KeyEventsState, r.ga4KeyEvents, fingerprints.ga4, r.ga4EndDate, r.rangeStart),
      projectId, configRevision, r.articleId, projectId, r.revision ?? null, r.revision ?? null,
    ));
    let written = 0;
    for (let i = 0; i < bound.length; i += 50) {
      const results = await (options.commit || db.batchAtomic)(bound.slice(i, i + 50));
      written += results.reduce((sum, r) => sum + Number(r.changes || 0), 0);
    }
    return written;
  },

  // 停用/删除的文章清掉旧行（重新启用时不露出过期本月数）
  clearCurrentForInactive: async (projectId) => {
    const info = await db.prepare(
      `DELETE FROM project_article_current_metrics
       WHERE project_id = ? AND article_id NOT IN (
         SELECT id FROM project_articles WHERE project_id = ? AND status = 'active'
       )`
    ).run(projectId, projectId);
    return Number(info.changes || 0);
  },
});
