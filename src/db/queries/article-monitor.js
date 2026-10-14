// article-monitor.js —— 站内监控看板查询（任务09）
// 列表口径：先限制可访问项目（owner + 在册文案师 + admin），再过滤，再稳定排序，再分页；
// summary 基于全部命中集合（不是当页）。达标判定走 src/lib/attainment.js 纯函数。
// 累计按月份与来源选唯一成功事实；NULL=全未知、0=抓到零。

const { evaluateAttainment, attainmentRate } = require('../../lib/attainment');
const { detailMonths, currentMonthDetail } = require('../../lib/current-month');
const { businessToday, monthOf } = require('../../lib/business-dates');
const { rollupArticle } = require('../../lib/article-metric-rollup');
const { parseKeyEventNames, resolveAccounts } = require('../../google/project-config');

const SORT_WHITELIST = ['published_at', 'url', 'title', 'copywriter', 'clicks', 'views', 'attainment', 'created_at', 'project', 'events'];
const PAGE_SIZES = [25, 50, 100];
// 达标筛选值
const ATTAIN_FILTERS = ['attained', 'not-attained', 'observation', 'pending', 'syncing', 'data-issue', 'pending-key-events'];
const SYNC_FILTERS = ['dirty', 'error', 'ok'];
// 达标排序权重：已达标 → 未达标 → 待配置 → 数据异常 → 同步中 → 观察期 → 待判断
const ATTAIN_ORDER = {
  attained: 0, 'not-attained': 1, 'pending-key-events': 2, 'data-issue': 3,
  syncing: 4, observation: 5, pending: 6,
};
const ATTAIN_LABELS = {
  attained: '已达标', 'not-attained': '未达标', 'pending-key-events': '待配置关键事件',
  'data-issue': '数据异常', syncing: '同步中', observation: '观察期', pending: '待判断',
};

// 可访问项目 id 列表（admin 看全部）
async function accessibleProjectIds(db, { userId, isAdmin }) {
  if (isAdmin) {
    const rows = await db.prepare('SELECT id FROM projects').all();
    return rows.map((r) => Number(r.id));
  }
  const rows = await db.prepare(
    'SELECT id FROM projects WHERE owner_user_id = @uid ' +
    'UNION SELECT project_id AS id FROM project_copywriters WHERE user_id = @uid AND revoked_at IS NULL'
  ).all({ uid: userId });
  return rows.map((r) => Number(r.id));
}

// 每篇的展示行（含来源覆盖/截至日/同步状态）
function monitorRow(a, extra) {
  return {
    id: Number(a.id),
    project_id: Number(a.project_id),
    project_name: a.project_name,
    url: a.url,
    title: a.title,
    title_source: a.title_source ?? null,
    title_fetch_status: a.title_fetch_status ?? null,
    title_fetch_error: a.title_fetch_error ?? null,
    keyword: a.keyword,
    copywriter_id: a.copywriter_id === null ? null : Number(a.copywriter_id),
    copywriter_user_id: a.copywriter_user_id === null ? null : Number(a.copywriter_user_id),
    copywriter_name: a.copywriter_name || null,
    copywriter_email: a.copywriter_email || null,
    published_at: a.published_at,
    status: a.status,
    sort_order: a.sort_order,
    metrics_dirty: Number(a.metrics_dirty) === 1,
    last_synced_at: a.last_synced_at,
    last_error: a.last_error,
    gsc: {
      coverEnd: a.gsc_cover_end || null, fetchedAt: a.gsc_fetched_at || null,
      status: a.gsc_cover_end ? 'complete' : 'pending',
    },
    ga4: {
      coverEnd: a.ga4_cover_end || null, fetchedAt: a.ga4_fetched_at || null,
      status: a.ga4_cover_end ? 'complete' : 'pending',
    },
    ...extra,
  };
}

// 过滤 → 达标 → 排序（不含分页）：列表与导出共用的命中集合
async function collectMatched(db, who, filters) {
    const today = filters.today || businessToday();
    // 权限、项目配置与活动任务直接 JOIN 到列表，减少查询次数。
    // 不把项目 id 展开为绑定参数，项目增多也不会突破单语句参数上限。
    const conds = [who.isAdmin ? '1 = 1' : `(p.owner_user_id = ? OR EXISTS (
      SELECT 1 FROM project_copywriters member
      WHERE member.project_id = p.id AND member.user_id = ? AND member.revoked_at IS NULL
    ))`];
    const params = who.isAdmin ? [] : [who.userId, who.userId];
    if (filters.project_id) { conds.push('a.project_id = ?'); params.push(Number(filters.project_id)); }
    if (filters.status && ['active', 'inactive'].includes(filters.status)) {
      conds.push('a.status = ?'); params.push(filters.status);
    } else {
      conds.push("a.status = 'active'"); // 默认只看看在册
    }
    if (filters.query && String(filters.query).trim()) {
      conds.push('(a.url LIKE ? OR a.title LIKE ? OR a.keyword LIKE ? OR p.name LIKE ? OR u.name LIKE ? OR u.email LIKE ?)');
      const q = `%${String(filters.query).trim()}%`;
      params.push(q, q, q, q, q, q);
    }
    if (filters.copywriter_user_id) {
      conds.push('a.copywriter_id IN (SELECT id FROM project_copywriters WHERE user_id = ?)');
      params.push(Number(filters.copywriter_user_id));
    }
    if (filters.missing_published_at) conds.push("TRIM(COALESCE(a.published_at, '')) = ''");
    if (filters.unassigned) conds.push('a.copywriter_id IS NULL');
    const where = conds.join(' AND ');
    const currentMonth = monthOf(today);
    const rows = await db.prepare(
      `SELECT a.*, p.name AS project_name,
              p.gsc_account_id, p.account_id, p.gsc_site, p.ga4_account_id, p.ga4_property_id, p.key_event_names,
              j.job_id, j.status AS job_status,
              EXISTS(SELECT 1 FROM project_monitor_sync_state s WHERE s.project_id=a.project_id AND s.run_id IS NOT NULL AND s.lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS engine_active,
              EXISTS(SELECT 1 FROM business_operations o WHERE o.kind='sync' AND o.status IN ('queued','running','cancel_requested')
                AND json_extract(o.input_json,'$.scope')='internal' AND json_extract(o.project_ids_json,'$[0]')=a.project_id
                AND (json_extract(o.input_json,'$.article_ids') IS NULL OR EXISTS(SELECT 1 FROM json_each(o.input_json,'$.article_ids') WHERE value=a.id))) AS operation_active,
              c.user_id AS copywriter_user_id, u.name AS copywriter_name, u.email AS copywriter_email
       FROM project_articles a JOIN projects p ON p.id = a.project_id
       LEFT JOIN project_copywriters c ON c.id = a.copywriter_id
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN article_monitor_sync_jobs j ON j.project_id = a.project_id AND j.status IN ('queued', 'running')
         AND (j.scope='project' OR j.article_id=a.id)
         AND (j.queue_json IS NOT NULL OR j.updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes'))
       WHERE ${where}`
    ).all(...params);
    // 一次读取各月份的来源事实，列表、明细、导出复用同月唯一贡献合同。
    const articleIds = JSON.stringify(rows.map(row => Number(row.id)));
    const currentById = new Map(), monthlyById = new Map();
    if (rows.length) {
      for (const row of await db.prepare('SELECT * FROM project_article_current_metrics WHERE article_id IN (SELECT value FROM json_each(?))').all(articleIds)) {
        currentById.set(Number(row.article_id), row);
      }
      for (const row of await db.prepare('SELECT * FROM project_article_monthly_metrics WHERE article_id IN (SELECT value FROM json_each(?)) AND month <= ?').all(articleIds, currentMonth)) {
        const id = Number(row.article_id);
        if (!monthlyById.has(id)) monthlyById.set(id, []);
        monthlyById.get(id).push(row);
      }
    }

    // 逐篇：累计 + 达标
    const matched = [];
    for (const a of rows) {
      const { gscAccountId, ga4AccountId } = resolveAccounts(a);
      const cfg = {
        gscConfigured: Boolean(gscAccountId && a.gsc_site),
        ga4Configured: Boolean(ga4AccountId && a.ga4_property_id),
        eventsConfigured: parseKeyEventNames(a.key_event_names).length > 0,
      };
      const rollup = rollupArticle(a, monthlyById.get(Number(a.id)) || [], currentById.get(Number(a.id)), today, cfg);
      const { cum, expectedMonths: expected } = rollup;
      const hasPendingMonths = expected !== null && !rollup.coverageComplete;
      const syncing = Boolean(a.job_id || a.engine_active || a.operation_active);
      const att = evaluateAttainment(a, cum, {
        today,
        gscConfigured: cfg.gscConfigured, ga4Configured: cfg.ga4Configured, eventsConfigured: cfg.eventsConfigured,
        coverageComplete: rollup.coverageComplete,
        expectedMonths: expected || 0,
        hasPendingMonths,
        syncing,
      });
      const job = a.job_id ? { job_id: a.job_id, status: a.job_status } : null;
      matched.push({
        row: monitorRow(a, {
          cumulative: { clicks: cum.clicks, views: cum.views, events: cum.events, ratio: ratioOrNull(cum), conversionViews: cum.conversionViews, conversionEvents: cum.conversionEvents },
          coverage: { businessStart: a.published_at || null, completeMonths: cum.completeMonths, errorMonths: cum.errorMonths, sources: rollup.coverage },
          gsc: { coverEnd: rollup.coverage.gsc.end, coverStart: rollup.coverage.gsc.start, fetchedAt: rollup.coverage.gsc.fetchedAt, status: cum.clicks === null ? 'pending' : rollup.coverage.gsc.missingMonths.length ? 'partial' : 'complete' },
          ga4: { coverEnd: rollup.coverage.views.end, coverStart: rollup.coverage.views.start, fetchedAt: rollup.coverage.views.fetchedAt, status: cum.views === null ? 'pending' : rollup.coverage.views.missingMonths.length ? 'partial' : 'complete' },
          attainment: { status: att.status, label: ATTAIN_LABELS[att.status] || att.status, reasons: att.reasons || [], evidence: att.evidence || [], ageDays: att.ageDays ?? null },
          expectedMonths: expected,
          syncStatus: syncStatusOf(a, cum),
          // 有活动任务时同步列说「同步中」（覆盖 dirty/ok）
          job: job ? { jobId: job.job_id, status: job.status } : syncing ? { jobId: null, status: 'running' } : null,
          anomaly: cum.mismatch || cum.errorMonths > 0 || Boolean(a.last_error),
          mismatches: mismatchList(a),
        }),
        status: att.status,
      });
    }

    // 筛选：达标 / 同步状态
    let filtered = matched;
    if (filters.attainment && ATTAIN_FILTERS.includes(filters.attainment)) {
      filtered = filtered.filter((m) => m.status === filters.attainment);
    }
    if (filters.sync && SYNC_FILTERS.includes(filters.sync)) {
      filtered = filtered.filter((m) => m.row.syncStatus === filters.sync);
    }
    // 汇总与列表共用全部筛选条件，在分页前计算。
    const summary = summarize(filtered);
    // 排序（白名单 + 同值追加 id；未知数最后）
    const sort = SORT_WHITELIST.includes(filters.sort) ? filters.sort : 'published_at';
    const dir = filters.dir === 'asc' ? 1 : -1;
    filtered.sort((x, y) => cmpMonitor(x.row, y.row, sort, dir) || x.row.id - y.row.id);
    return { filtered, summary };
}

module.exports = (db) => ({
  accessibleProjectIds: (who) => accessibleProjectIds(db, who),

  // 主列表：过滤 → 达标 → 排序 → 分页；summary 全量
  async listMonitor(who, filters = {}) {
    const { filtered, summary } = await collectMatched(db, who, filters);
    const pageSize = PAGE_SIZES.includes(Number(filters.page_size)) ? Number(filters.page_size) : 50;
    const page = Math.max(Number(filters.page) || 1, 1);
    const start = (page - 1) * pageSize;
    const sort = SORT_WHITELIST.includes(filters.sort) ? filters.sort : 'published_at';
    const dir = filters.dir === 'asc' ? 'asc' : 'desc';
    return {
      rows: filtered.slice(start, start + pageSize).map((m) => m.row),
      total: filtered.length,
      page, pageSize, sort, dir,
      summary,
    };
  },

  // 全量命中（导出用，不分页）：rows 为全部命中行 + summary
  async listMonitorAll(who, filters = {}) {
    const { filtered, summary } = await collectMatched(db, who, filters);
    return { rows: filtered.map((m) => m.row), total: filtered.length, summary };
  },

  // 展开明细的全量版本（导出月度矩阵用）：命中文章的月度行一次取回
  listMonthlyForArticles: async (articleIds) => {
    const ids = [...new Set((articleIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return [];
    return db.prepare(
      `SELECT * FROM project_article_monthly_metrics WHERE article_id IN (SELECT value FROM json_each(?)) ORDER BY article_id, month`
    ).all(JSON.stringify(ids));
  },


  // 展开：月度明细 + 本月临时行 + 曾用地址（展开才查）
  // 本月（当前自然月）的未定稿月度行是旧模型残留：有临时行就不展示它（避免双倍），
  // 临时行单独一行（各源截止日 + 同步时间 + 状态）。
  getArticleMonthlyDetail: async (articleId, { today } = {}) => {
    const article = await db.prepare('SELECT project_id, published_at FROM project_articles WHERE id = ?').get(articleId);
    const currentMonth = today ? String(today).slice(0, 7) : monthOf(businessToday());
    const all = await db.prepare(
      'SELECT * FROM project_article_monthly_metrics WHERE article_id = ? ORDER BY month DESC'
    ).all(articleId);
    const current = await db.prepare(
      'SELECT * FROM project_article_current_metrics WHERE article_id = ?'
    ).get(articleId);
    const syncState = article
      ? await db.prepare('SELECT * FROM project_article_current_sync_state WHERE project_id = ?').get(article.project_id)
      : null;
    const history = await db.prepare(
      'SELECT url, url_changed_at FROM project_article_url_history WHERE article_id = ? ORDER BY url_changed_at DESC, id DESC'
    ).all(articleId);
    return {
      monthly: detailMonths(all, current, currentMonth).filter(row => !article?.published_at || row.month >= article.published_at.slice(0, 7)),
      current: currentMonthDetail(current, syncState, currentMonth),
      history,
    };
  },
});

function ratioOrNull(cum) {
  if (cum.conversionViews == null || cum.conversionEvents == null || !cum.conversionViews) return null;
  return cum.conversionEvents / cum.conversionViews;
}

function syncStatusOf(a, cum) {
  if (a.last_error) return 'error';
  if (cum.errorMonths > 0) return 'error';
  if (Number(a.metrics_dirty) === 1 || !a.last_synced_at) return 'dirty';
  return 'ok';
}

// mismatch 单列 → 行内展示用的小列表
function mismatchList(a) {
  const note = String(a.mismatch_note || '').trim();
  return note ? [{ url: '', clicks: null, note }] : [];
}

function emptySummary() {
  return {
    total: 0, attained: 0, notAttained: 0, observation: 0, pending: 0,
    pendingKeyEvents: 0, dataIssue: 0, syncing: 0, missingPublishedAt: 0,
    anomaly: 0, conversionViews: 0, conversionKeyEvents: 0, conversionRate: null, conversionKnownArticles: 0, conversionExcludedArticles: 0,
    rate: null, rateNumerator: 0, rateDenominator: 0,
  };
}

function summarize(matched) {
  const s = emptySummary();
  for (const m of matched) {
    s.total++;
    if (m.status === 'attained') s.attained++;
    else if (m.status === 'not-attained') s.notAttained++;
    else if (m.status === 'observation') s.observation++;
    else if (m.status === 'pending-key-events') s.pendingKeyEvents++;
    else if (m.status === 'data-issue') s.dataIssue++;
    else if (m.status === 'syncing') s.syncing++;
    else s.pending++;
    // 待补发布日期：影响观察期基准与达标判断，是最常见的待办
    if (!String(m.row.published_at || '').trim()) s.missingPublishedAt++;
    // 数据异常：抓取失败 / mismatch 标注 / 同步报错（与达标状态独立计数）
    if (m.row.syncStatus === 'error' || m.row.anomaly) s.anomaly++;
    // 总转化率 = 累计关键事件 ÷ 累计浏览
    const { conversionViews, conversionEvents } = m.row.cumulative;
    if (conversionViews != null && conversionEvents != null) {
      s.conversionViews += conversionViews; s.conversionKeyEvents += conversionEvents; s.conversionKnownArticles++;
    } else s.conversionExcludedArticles++;
  }
  s.conversionRate = s.conversionViews > 0 ? s.conversionKeyEvents / s.conversionViews : null;
  const rate = attainmentRate(s);
  s.rate = rate.rate; s.rateNumerator = rate.numerator; s.rateDenominator = rate.denominator;
  return s;
}

// 排序比较：未知/空值永远排最后（不管方向）
function cmpMonitor(x, y, field, dir) {
  const xv = sortValue(x, field);
  const yv = sortValue(y, field);
  const xNull = xv === null || xv === undefined;
  const yNull = yv === null || yv === undefined;
  if (xNull && yNull) return 0;
  if (xNull) return 1;
  if (yNull) return -1;
  if (typeof xv === 'string') return xv.localeCompare(yv, 'zh') * dir;
  return (xv - yv) * dir;
}

function sortValue(row, field) {
  switch (field) {
    case 'project': return row.project_name || null;
    case 'events': return row.cumulative.events;
    case 'url': return row.url;
    case 'title': return row.title || null;
    case 'published_at': return row.published_at || null;
    case 'copywriter': return row.copywriter_name || row.copywriter_email || null;
    case 'clicks': return row.cumulative.clicks;
    case 'views': return row.cumulative.views;
    case 'attainment': return ATTAIN_ORDER[row.attainment.status] ?? null;
    case 'created_at': return row.sort_order ?? null;
    default: return null;
  }
}
