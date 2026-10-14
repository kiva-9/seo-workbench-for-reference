// project-article-monthly.js —— 月度指标写入与计划查询（任务07）
// 字段契约见 migrations/0002_article_registry.sql 头部注释。
//
// 写入守卫（任务07契约「旧响应写入保护」）：
//   UPSERT 的 DO UPDATE 带 WHERE (SELECT fetch_revision FROM project_articles WHERE id=@aid) = @rev
//   —— 计划时读到的文章修订和写入时不一致（同步途中改址/启停），该文章的这次写入整句不生效，
//   dirty 不清。运行标识（run_id）由调用方在单元里一起带，最终由 release 时校验。
//   指纹（配置修订）不一致的行不跳过重抓：计划阶段就根本不会把该来源排进抓取。

const { monthBounds } = require('../../lib/business-dates');

// 一个来源的列映射（GSC / GA4 各自独立状态与覆盖 + 最后成功事实，迁移 0009）
const SOURCE_COLS = {
  gsc: {
    status: 'gsc_status', error: 'gsc_error', coverStart: 'gsc_cover_start', coverEnd: 'gsc_cover_end',
    fetchedAt: 'gsc_fetched_at', finalized: 'gsc_finalized', fp: 'gsc_config_fingerprint',
    value: 'gsc_clicks', successValue: 'gsc_success_value', successConfig: 'gsc_success_config', successAt: 'gsc_success_at',
  },
  ga4: {
    status: 'ga4_status', error: 'ga4_error', coverStart: 'ga4_cover_start', coverEnd: 'ga4_cover_end',
    fetchedAt: 'ga4_fetched_at', finalized: 'ga4_finalized', fp: 'ga4_config_fingerprint',
    value: null, // GA4 有两个指标列，事实列按调用方给的 valueColumn/prefix 拼
    successValue: null, successConfig: null, successAt: null,
  },
};

// 事实三元组的列名（gsc / ga4_views / ga4_key_events 三个来源，迁移 0009）
const FACT_COLS = {
  gsc_clicks: { value: 'gsc_success_value', config: 'gsc_success_config', at: 'gsc_success_at' },
  ga4_views: { value: 'ga4_views_success_value', config: 'ga4_views_success_config', at: 'ga4_views_success_at' },
  ga4_key_events: { value: 'ga4_key_events_success_value', config: 'ga4_key_events_success_config', at: 'ga4_key_events_success_at' },
};
// 单来源键 → 事实列（写入与回读共用）
function factColsOf(sourceKey) { return FACT_COLS[sourceKey]; }

// 事实写入的「成功才更新」SQL：attempt 完整且值非 NULL → 新事实；否则保留旧事实。
// SQLite 的 SET 都看更新前的行，CASE 右侧的裸列名就是旧值。
function factAssignments(sourceKey, attemptStateExpr, attemptValueExpr) {
  const f = factColsOf(sourceKey);
  if (!f) return { insertExprs: [], updateExprs: [] };
  const ok = `(${attemptStateExpr} = 'complete' AND ${attemptValueExpr} IS NOT NULL)`;
  return {
    insertExprs: [
      `CASE WHEN ${ok} THEN ${attemptValueExpr} END`,
      `CASE WHEN ${ok} THEN json_object('kind','v2','fingerprint',@fp,'cover_start',@cs,'cover_end',@ce) END`,
      `CASE WHEN ${ok} THEN @fa END`,
    ],
    updateExprs: [
      `${f.value} = CASE WHEN ${ok} THEN ${attemptValueExpr} ELSE ${f.value} END`,
      `${f.config} = CASE WHEN ${ok} THEN excluded.${f.config} ELSE ${f.config} END`,
      `${f.at} = CASE WHEN ${ok} THEN excluded.${f.at} ELSE ${f.at} END`,
    ],
  };
}

module.exports = (db) => ({
  // ============ 读（计划用） ============

  listArticleMonthly: async (articleId) => db.prepare(
    'SELECT * FROM project_article_monthly_metrics WHERE article_id = ? ORDER BY month DESC'
  ).all(articleId),

  getArticleMonthly: async (articleId, month) =>
    db.prepare('SELECT * FROM project_article_monthly_metrics WHERE article_id = ? AND month = ?').get(articleId, month),

  listProjectMonths: async (projectId) => {
    const rows = await db.prepare(
      "SELECT DISTINCT m.month FROM project_article_monthly_metrics m " +
      'JOIN project_articles a ON a.id = m.article_id ' +
      "WHERE a.project_id = ? AND m.gsc_status = 'complete' ORDER BY m.month"
    ).all(projectId);
    return rows.map((r) => r.month);
  },

  // 计划用：一次取出项目全部文章在给定月份集合上的行（含文章当前修订，供比对）
  listPlanRows: async (projectId, months) => {
    if (!months.length) return [];
    const named = { pid: projectId };
    const inList = months.map((m, i) => { named['k' + i] = m; return '@k' + i; }).join(',');
    return db.prepare(
      'SELECT m.*, a.fetch_revision AS article_revision, a.status AS article_status ' +
      'FROM project_article_monthly_metrics m ' +
      'JOIN project_articles a ON a.id = m.article_id ' +
      'WHERE a.project_id = @pid AND m.month IN (' + inList + ')'
    ).all(named);
  },

  // 指定文章 × 指定月份的月度行（本月临时数据合并时取「同月过渡行」用）
  listMonthlyForArticleMonths: async (articleIds, months) => {
    const ids = [...new Set((articleIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const ms = [...new Set((months || []).filter(Boolean))];
    if (!ids.length || !ms.length) return [];
    return db.prepare(
      `SELECT * FROM project_article_monthly_metrics
       WHERE article_id IN (SELECT value FROM json_each(?)) AND month IN (SELECT value FROM json_each(?))`
    ).all(JSON.stringify(ids), JSON.stringify(ms));
  },

  // 同步归集的 URL 全集：当前地址 + 曾用地址（改址不删历史指标）
  listArticleUrlsForSync: async (projectId) => {
    const articles = await db.prepare("SELECT id, url, published_at, fetch_revision FROM project_articles WHERE project_id = ? AND status = 'active'").all(projectId);
    const history = await db.prepare(
      'SELECT article_id, url FROM project_article_url_history WHERE project_id = ?'
    ).all(projectId);
    const byArticle = new Map();
    for (const a of articles) byArticle.set(Number(a.id), { id: Number(a.id), url: a.url, published_at: a.published_at, fetch_revision: Number(a.fetch_revision ?? 1), urls: [a.url] });
    for (const h of history) {
      const entry = byArticle.get(Number(h.article_id));
      if (entry) entry.urls.push(h.url);
    }
    return [...byArticle.values()];
  },

  // ============ 写（守卫） ============

  // 构造单来源月度写入语句（守卫内嵌）。调用方按业务单元自行 batchAtomic。
  monthlyWriteStmt(articleId, month, source, values, { revision, fingerprint, coverStart, coverEnd, finalized = false, error = null, mismatch = null, fetchedAt = null }) {
    const cols = SOURCE_COLS[source];
    if (!cols) throw new Error('未知来源：' + source);
    const bounds = monthBounds(month);
    const at = new Date().toISOString();
    const fa = fetchedAt || at; // 抓取时间可显式指定（测试/补偿写库）；默认现在
    const isGsc = source === 'gsc';
    const named = {
      aid: articleId, month, mStart: bounds.start, mEnd: bounds.end,
      status: error ? 'error' : 'complete',
      err: error ? String(error).slice(0, 500) : null,
      cs: coverStart || null, ce: coverEnd || null,
      fa, fin: finalized ? 1 : 0, fp: fingerprint ?? null,
      rev: revision, at, mismatch: mismatch ? String(mismatch).slice(0, 500) : null,
    };
    if (isGsc) {
      named.clicks = values.clicks ?? null;
      named.impressions = values.impressions ?? null;
      named.ctr = values.ctr ?? null;
      named.position = values.position ?? null;
    } else {
      named.pageviews = values.pageviews ?? null;
      named.keyEvents = values.keyEvents ?? null;
    }
    const metricCols = isGsc
      ? ['gsc_clicks', 'gsc_impressions', 'gsc_ctr', 'gsc_position']
      : ['ga4_pageviews', 'ga4_key_events'];
    const metricVals = isGsc
      ? ['@clicks', '@impressions', '@ctr', '@position']
      : ['@pageviews', '@keyEvents'];
    // 事实三元组：本次尝试完整且值非 NULL → 新事实；失败尝试只写尝试层、保留旧事实
    const factKeys = isGsc ? ['gsc_clicks'] : ['ga4_views', 'ga4_key_events'];
    const factExprs = isGsc
      ? factAssignments('gsc_clicks', '@status', '@clicks')
      : {
        insertExprs: [
          ...factAssignments('ga4_views', '@status', '@pageviews').insertExprs,
          ...factAssignments('ga4_key_events', '@status', '@keyEvents').insertExprs,
        ],
        updateExprs: [
          ...factAssignments('ga4_views', 'excluded.' + cols.status, 'excluded.ga4_pageviews').updateExprs,
          ...factAssignments('ga4_key_events', 'excluded.' + cols.status, 'excluded.ga4_key_events').updateExprs,
        ],
      };
    const insertCols = [metricCols, cols.status, cols.error, cols.coverStart, cols.coverEnd, cols.fetchedAt, cols.finalized, cols.fp, 'fetch_revision', 'mismatch', ...factKeys.flatMap((k) => [FACT_COLS[k].value, FACT_COLS[k].config, FACT_COLS[k].at]), 'updated_at'].join(', ');
    const insertVals = ['@aid', '@month', '@mStart', '@mEnd', metricVals, '@status', '@err', '@cs', '@ce', '@fa', '@fin', '@fp', '@rev', '@mismatch', ...factExprs.insertExprs, '@at'].join(', ');
    const updateSets = [
      ...metricCols.map((c) => c + ' = excluded.' + c),
      cols.status + ' = excluded.' + cols.status,
      cols.error + ' = excluded.' + cols.error,
      cols.coverStart + ' = excluded.' + cols.coverStart,
      cols.coverEnd + ' = excluded.' + cols.coverEnd,
      cols.fetchedAt + ' = excluded.' + cols.fetchedAt,
      cols.finalized + ' = excluded.' + cols.finalized,
      cols.fp + ' = excluded.' + cols.fp,
      'fetch_revision = excluded.fetch_revision',
      // mismatch 是跨来源共享列：本次没有新备注时不能把上一来源写的异常冲掉
      'mismatch = CASE WHEN excluded.mismatch IS NULL THEN project_article_monthly_metrics.mismatch ELSE excluded.mismatch END',
      ...factExprs.updateExprs,
      'updated_at = excluded.updated_at',
    ].join(', ');
    // INSERT 走 SELECT ... WHERE 形式：守卫同时管「建行」和「更新」两条路径——
    // 同步途中文章修订变化时，旧执行者连新行都建不了，更谈不上覆盖/清 dirty
    const sql = 'INSERT INTO project_article_monthly_metrics ' +
      '(article_id, month, month_start, month_end, ' + insertCols + ') ' +
      'SELECT ' + insertVals + ' ' +
      'WHERE (SELECT fetch_revision FROM project_articles WHERE id = @aid) = @rev ' +
      'ON CONFLICT(article_id, month) DO UPDATE SET ' + updateSets + ' ' +
      'WHERE (SELECT fetch_revision FROM project_articles WHERE id = @aid) = @rev';
    return db.prepare(sql).bind(named);
  },

  // 多行月度写入（任务08 容量修正）：一次语句写多篇。每行守卫经 s.rev /
  // excluded.fetch_revision 实现——INSERT…SELECT 的 WHERE 挡「建行」，DO UPDATE 的 WHERE
  // 挡「更新」，两条路径都只放行「文章修订与计划时一致」的行。
  // rows: [{ articleId, values, revision, mismatch }]（revision = 计划时读到的文章修订）。
  // 返回 bound statement；调用方按业务单元（一批文章）自行 batchAtomic，
  // 用 changes 与 rows.length 的差判断「有行被守卫挡下」。
  monthlyWriteMultiStmt(source, month, rows, { fingerprint, coverStart, coverEnd, finalized = false, error = null, projectId = null, configRevision = null }) {
    const cols = SOURCE_COLS[source];
    if (!cols) throw new Error('未知来源：' + source);
    if (!rows.length) throw new Error('monthlyWriteMultiStmt: rows 不能为空');
    const bounds = monthBounds(month);
    const at = new Date().toISOString();
    const isGsc = source === 'gsc';
    const metricCols = isGsc
      ? ['gsc_clicks', 'gsc_impressions', 'gsc_ctr', 'gsc_position']
      : ['ga4_pageviews', 'ga4_key_events'];
    // 内层每行的列别名：article_id, m1..mN（指标）, rev, mismatch
    const innerCols = ['article_id', ...metricCols.map((_, i) => 'm' + (i + 1)), 'rev', 'mismatch'];
    const named = {
      month, mStart: bounds.start, mEnd: bounds.end,
      status: error ? 'error' : 'complete',
      err: error ? String(error).slice(0, 500) : null,
      cs: coverStart || null, ce: coverEnd || null,
      fa: at, fin: finalized ? 1 : 0, fp: fingerprint ?? null, at,
      writeProjectId: projectId, writeConfigRevision: configRevision,
    };
    const inner = rows.map((row, i) => {
      const vals = isGsc
        ? [row.values.clicks ?? null, row.values.impressions ?? null, row.values.ctr ?? null, row.values.position ?? null]
        : [row.values.pageviews ?? null, row.values.keyEvents ?? null];
      const cells = [row.articleId, ...vals, row.revision, row.mismatch ? String(row.mismatch).slice(0, 500) : null];
      cells.forEach((v, j) => { named['r' + i + '_' + j] = v; });
      return 'SELECT ' + innerCols.map((c, j) => '@r' + i + '_' + j + ' AS ' + c).join(', ');
    }).join(' UNION ALL ');
    // 事实三元组（迁移 0009）：完整且值非 NULL → 新事实；失败尝试保留旧事实。
    // INSERT 侧读内层子查询列（s.m1/s.m2），DO UPDATE 侧读 excluded.*
    const factPairs = isGsc
      ? [{ key: 'gsc_clicks', insert: factAssignments('gsc_clicks', '@status', 's.m1').insertExprs, update: factAssignments('gsc_clicks', 'excluded.' + cols.status, 'excluded.gsc_clicks').updateExprs }]
      : [
        { key: 'ga4_views', insert: factAssignments('ga4_views', '@status', 's.m1').insertExprs, update: factAssignments('ga4_views', 'excluded.' + cols.status, 'excluded.ga4_pageviews').updateExprs },
        { key: 'ga4_key_events', insert: factAssignments('ga4_key_events', '@status', 's.m2').insertExprs, update: factAssignments('ga4_key_events', 'excluded.' + cols.status, 'excluded.ga4_key_events').updateExprs },
      ];
    const factInsertCols = factPairs.flatMap((f) => [FACT_COLS[f.key].value, FACT_COLS[f.key].config, FACT_COLS[f.key].at]);
    const outerVals = [
      's.article_id', '@month', '@mStart', '@mEnd',
      ...metricCols.map((_, i) => 's.m' + (i + 1)),
      '@status', '@err', '@cs', '@ce', '@fa', '@fin', '@fp',
      's.rev', 's.mismatch', ...factPairs.flatMap((f) => f.insert), '@at',
    ];
    const updateSets = [
      ...metricCols.map((c) => c + ' = excluded.' + c),
      cols.status + ' = excluded.' + cols.status,
      cols.error + ' = excluded.' + cols.error,
      cols.coverStart + ' = excluded.' + cols.coverStart,
      cols.coverEnd + ' = excluded.' + cols.coverEnd,
      cols.fetchedAt + ' = excluded.' + cols.fetchedAt,
      cols.finalized + ' = excluded.' + cols.finalized,
      cols.fp + ' = excluded.' + cols.fp,
      // 失败来源不能替尚未执行的来源认领新修订，否则下一轮会跳过旧成功行。
      `fetch_revision = CASE WHEN excluded.${cols.status} = 'complete' THEN excluded.fetch_revision ELSE project_article_monthly_metrics.fetch_revision END`,
      'mismatch = CASE WHEN excluded.mismatch IS NULL THEN project_article_monthly_metrics.mismatch ELSE excluded.mismatch END',
      ...factPairs.flatMap((f) => f.update),
      'updated_at = excluded.updated_at',
    ].join(', ');
    const projectGuard = articleRef => `(@writeProjectId IS NULL OR EXISTS (
      SELECT 1 FROM project_articles guard_a JOIN projects guard_p ON guard_p.id = guard_a.project_id
      WHERE guard_a.id = ${articleRef} AND guard_a.project_id = @writeProjectId AND guard_a.status = 'active'
        AND (@writeConfigRevision IS NULL OR guard_p.config_revision = @writeConfigRevision)))`;
    const sql = 'INSERT INTO project_article_monthly_metrics ' +
      '(article_id, month, month_start, month_end, ' + metricCols.join(', ') + ', ' +
      cols.status + ', ' + cols.error + ', ' + cols.coverStart + ', ' + cols.coverEnd + ', ' +
      cols.fetchedAt + ', ' + cols.finalized + ', ' + cols.fp + ', fetch_revision, mismatch, ' +
      factInsertCols.join(', ') + ', updated_at) ' +
      'SELECT ' + outerVals.join(', ') + ' FROM (' + inner + ') AS s ' +
      'WHERE (SELECT fetch_revision FROM project_articles WHERE id = s.article_id) = s.rev AND ' + projectGuard('s.article_id') + ' ' +
      'ON CONFLICT (article_id, month) DO UPDATE SET ' + updateSets + ' ' +
      'WHERE (SELECT fetch_revision FROM project_articles WHERE id = article_id) = excluded.fetch_revision AND ' + projectGuard('excluded.article_id');
    return db.prepare(sql).bind(named);
  },

  // 单来源月度写入（执行包装：返回是否真正落库）  // 单来源月度写入（执行包装：返回是否真正落库）
  async writeMonthly(articleId, month, source, values, opts) {
    const r = await db.batchAtomic([this.monthlyWriteStmt(articleId, month, source, values, opts)]);
    return Number(r[0].changes || 0) > 0;
  },

  // 来源不可用（未配置 / 来源范围不支持）：写状态但不动数值
  monthlyUnavailableStmt(articleId, month, source, reason, { revision, fingerprint }) {
    const cols = SOURCE_COLS[source];
    const bounds = monthBounds(month);
    const at = new Date().toISOString();
    const sql = 'INSERT INTO project_article_monthly_metrics ' +
      '(article_id, month, month_start, month_end, ' + cols.status + ', ' + cols.error + ', ' + cols.fp + ', fetch_revision, updated_at) ' +
      "SELECT @aid, @month, @mStart, @mEnd, 'unavailable', @err, @fp, @rev, @at " +
      'WHERE (SELECT fetch_revision FROM project_articles WHERE id = @aid) = @rev ' +
      'ON CONFLICT(article_id, month) DO UPDATE SET ' +
      cols.status + " = 'unavailable', " + cols.error + ' = excluded.' + cols.error + ', ' +
      cols.fp + ' = excluded.' + cols.fp + ', fetch_revision = excluded.fetch_revision, updated_at = excluded.updated_at ' +
      'WHERE (SELECT fetch_revision FROM project_articles WHERE id = @aid) = @rev';
    return db.prepare(sql).bind({
      aid: articleId, month, mStart: bounds.start, mEnd: bounds.end,
      err: String(reason || '').slice(0, 500), fp: fingerprint ?? null, rev: revision, at,
    });
  },

  async writeMonthlyUnavailable(articleId, month, source, reason, opts) {
    const r = await db.batchAtomic([this.monthlyUnavailableStmt(articleId, month, source, reason, opts)]);
    return Number(r[0].changes || 0) > 0;
  },

  // 结束清 dirty：只清「修订没变」的文章——同步途中改过址的留着脏等下次刷新
  clearArticleDirty: async (articleId, expectedRevision, { projectId = null, configRevision = null } = {}) => {
    const info = await db.prepare(
      `UPDATE project_articles SET metrics_dirty = 0, last_synced_at = @at WHERE id = @id AND fetch_revision = @rev
       AND (@pid IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=project_articles.project_id AND p.id=@pid AND p.config_revision=@config))`
    ).run({ id: articleId, rev: expectedRevision, at: new Date().toISOString(), pid: projectId, config: configRevision });
    return Number(info.changes || 0) > 0;
  },
});
