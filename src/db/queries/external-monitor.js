// external-monitor.js —— 外链平台看板查询（任务12）
// 平台 = 项目 × 域名。汇总与文章参考分开展示：
//   - 平台值：当前有效日数据的单独 SUM（不冻结、不分摊），带数据截至日与完整性；
//   - 文章参考值：冻结段已知和 + 活跃段区间和（窗口∩活跃段），带窗口/share/冻结状态。
// 筛选口径：先按文章属性（状态/文案师/搜索）确定命中平台集合，再排序分页；
// 文案师筛选下平台数字仍标「命中平台整体数据」（平台按整体呈现，不按作者切分）。

const { buildFingerprint } = require('../../lib/external-fingerprint');
const { computePlatformWindows, aggregateDaily, dayAfter } = require('../../lib/external-windows');
const { businessToday } = require('../../lib/business-dates');
const { loadPlatformAggregates } = require('./external-platform-aggregates');

// 可访问项目（owner + 在册文案师 + admin）
async function externalProjectIds(db, { userId, isAdmin }) {
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

// 平台集合（不含分页）：列表与导出共用
async function collectPlatforms(db, who, filters) {
    const projectIds = await externalProjectIds(db, who);
    if (!projectIds.length) return { rows: [], summary: emptySummary(), domains: [] };

    const arts = await db.prepare(
      'SELECT a.*, u.name AS copywriter_name, u.email AS copywriter_email, p.name AS project_name, p.ga4_account_id, p.account_id, p.ga4_property_id, p.key_event_names, ' +
      'c.user_id AS copywriter_user_id ' +
      'FROM project_external_articles a ' +
      'JOIN projects p ON p.id = a.project_id ' +
      'LEFT JOIN project_copywriters c ON c.id = a.copywriter_id LEFT JOIN users u ON u.id = c.user_id ' +
      'WHERE a.project_id IN (SELECT value FROM json_each(?))' + (filters.project_id ? ' AND a.project_id = ?' : '')
    ).all(JSON.stringify(projectIds), ...(filters.project_id ? [Number(filters.project_id)] : []));

    // 文章级筛选 → 命中平台集合（筛选项：
    // 域名/状态/文案师/缺发布日期/未指派/搜索）
    const q = filters.q && String(filters.q).trim() ? String(filters.q).trim().toLowerCase() : null;
    const statusFilter = ['active', 'inactive'].includes(filters.status) ? filters.status : null;
    const cwFilter = filters.copywriter_user_id ? Number(filters.copywriter_user_id) : null;
    const domainFilter = filters.domain ? String(filters.domain).trim().toLowerCase() : null;
    const missingDate = Boolean(filters.missing_published_at);
    const unassigned = Boolean(filters.unassigned);
    const matches = (a) => {
      if (domainFilter && !String(a.domain || '').toLowerCase().includes(domainFilter)) return false;
      if (statusFilter && a.status !== statusFilter) return false;
      if (cwFilter && Number(a.copywriter_user_id || 0) !== cwFilter) return false;
      if (missingDate && String(a.published_at || '').trim()) return false;
      if (unassigned && a.copywriter_id !== null && a.copywriter_id !== undefined) return false;
      if (q) {
        const hay = (a.url + ' ' + (a.title || '') + ' ' + (a.anchor_text || '') + ' ' + (a.domain || '') + ' ' + (a.project_name || '') + ' ' + (a.copywriter_name || '') + ' ' + (a.copywriter_email || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };

    // 平台聚合
    const byPlatform = new Map();
    for (const a of arts) {
      const key = a.project_id + '|' + a.domain;
      if (!byPlatform.has(key)) {
        byPlatform.set(key, {
          project_id: Number(a.project_id), project_name: a.project_name, domain: a.domain,
          articles: [], matched: [],
        });
      }
      const pl = byPlatform.get(key);
      pl.articles.push(a);
      if (matches(a)) pl.matched.push(a);
    }

    const matchedPlatforms = [...byPlatform.values()].filter(pl => pl.matched.length);
    const aggregates = await loadPlatformAggregates(db, matchedPlatforms);
    const rows = [];
    for (const pl of matchedPlatforms) {
      const project = pl.articles[0];
      const { aggregate: agg,freezeCount } = aggregates.get(pl.project_id + '|' + pl.domain);
      // 平台同步状态（徽标 + 跟进卡筛选用）：
      //   unconfigured  项目没配 GA4（事件/用户都取不到）
      //   issue         配置有变更未重抓（旧配置）/ 数据不完整
      //   pending       还没同步过（没有数据截至日）
      //   ok            完整
      const ga4Configured = Boolean(project.ga4_property_id);
      const syncStatus = !ga4Configured ? 'unconfigured'
        : agg.staleConfig ? 'issue'
        : (!agg.dataThrough && (agg.usersTotal === null && agg.eventsTotal === null)) ? 'pending'
        : agg.complete ? 'ok' : 'issue';
      rows.push({
        project_id: pl.project_id,
        project_name: pl.project_name,
        domain: pl.domain,
        matchedArticleCount: pl.matched.length,
        registeredArticleCount: pl.articles.length,
        activeArticleCount: pl.articles.filter((a) => a.status === 'active').length,
        usersTotal: agg.usersTotal,
        eventsTotal: agg.eventsTotal,
        days: agg.days,
        dataThrough: agg.dataThrough,
        complete: agg.complete,
        staleConfig: agg.staleConfig,
        syncStatus,
        ga4Configured,
        freezeCount,
        lastSyncedAt: agg.lastSyncedAt,
      });
    }

    // 平台级同步筛选（跟进卡：未配置项目 / 同步异常平台）
    const syncFilter = ['unconfigured', 'issue', 'pending', 'ok'].includes(filters.sync) ? filters.sync : null;
    const visible = syncFilter ? rows.filter((r) => r.syncStatus === syncFilter) : rows;

    // summary（全筛选命中的平台集合，不是当页）：
    //   用户/事件总数有一个平台未知就是 null（「—」不是 0）；
    //   未配置事件的项目不进事件总数分母（没有就是没配，不是 0）。
    const unconfiguredProjects = new Set(visible.filter((r) => r.syncStatus === 'unconfigured').map((r) => r.project_id));
    const issuePlatforms = visible.filter((r) => r.syncStatus === 'issue');
    const knownUsers = visible.filter((r) => r.usersTotal !== null && r.usersTotal !== undefined);
    const eventsRequired = visible.filter((r) => r.ga4Configured && r.eventsTotal !== null && r.eventsTotal !== undefined);
    const dataAsOf = visible.map((r) => r.dataThrough).filter(Boolean).sort().at(-1) || null;
    const dataStatus = !visible.length ? 'empty'
      : visible.some((r) => r.syncStatus === 'unconfigured') ? 'unconfigured'
      : visible.some((r) => r.syncStatus === 'issue' || r.syncStatus === 'pending') ? 'partial'
      : 'complete';
    const matchedArticles = visible.flatMap(r => byPlatform.get(r.project_id + '|' + r.domain).matched);
    const summary = {
      platformCount: visible.length,
      matchedProjectCount: new Set(visible.map((r) => r.project_id)).size,
      registeredArticleCount: visible.reduce((a, r) => a + r.registeredArticleCount, 0),
      matchedArticleCount: visible.reduce((a, r) => a + r.matchedArticleCount, 0),
      activeArticleCount: visible.reduce((a, r) => a + r.activeArticleCount, 0),
      freezeCount: visible.reduce((a, r) => a + r.freezeCount, 0),
      users: visible.length && knownUsers.length === visible.length ? knownUsers.reduce((a, r) => a + r.usersTotal, 0) : null,
      keyEvents: eventsRequired.length ? eventsRequired.reduce((a, r) => a + r.eventsTotal, 0) : null,
      unconfiguredProjectCount: unconfiguredProjects.size,
      syncIssuePlatformCount: issuePlatforms.length,
      missingPublishedAtArticleCount: matchedArticles.filter(a => !String(a.published_at || '').trim()).length,
      unassignedArticleCount: matchedArticles.filter(a => a.copywriter_id == null).length,
      dataStatus,
      dataAsOf,
    };

    // 排序（白名单 + 未知最后 + 同值追加项目/域名）
    const sort = ['usersTotal', 'domain', 'matchedArticleCount', 'dataThrough', 'project_name', 'syncStatus', 'eventsTotal', 'registeredArticleCount', 'activeArticleCount', 'lastSyncedAt'].includes(filters.sort) ? filters.sort : 'usersTotal';
    const dir = filters.dir === 'asc' ? 1 : -1;
    const sorted = [...visible];
    sorted.sort((x, y) => {
      const xv = x[sort], yv = y[sort];
      const xNull = xv === null || xv === undefined, yNull = yv === null || yv === undefined;
      if (xNull && yNull) return (x.project_id - y.project_id) || x.domain.localeCompare(y.domain);
      if (xNull) return 1;
      if (yNull) return -1;
      if (typeof xv === 'string') return xv.localeCompare(yv, 'zh') * dir || (x.project_id - y.project_id) || x.domain.localeCompare(y.domain);
      return (xv - yv) * dir || (x.project_id - y.project_id) || x.domain.localeCompare(y.domain);
    });
    // 平台选项独立于分页和当前搜索，切换筛选后仍能选回其他平台。
    const domains = [...new Set(arts.filter(a => !filters.project_id || Number(a.project_id) === Number(filters.project_id)).map(a => a.domain))].sort();
    return { rows: sorted, summary, domains };
}

module.exports = (db) => ({
  // 可访问项目（owner + 在册文案师 + admin）
  async externalProjectIds({ userId, isAdmin }) {
    if (isAdmin) {
      const rows = await db.prepare('SELECT id FROM projects').all();
      return rows.map((r) => Number(r.id));
    }
    const rows = await db.prepare(
      'SELECT id FROM projects WHERE owner_user_id = @uid ' +
      'UNION SELECT project_id AS id FROM project_copywriters WHERE user_id = @uid AND revoked_at IS NULL'
    ).all({ uid: userId });
    return rows.map((r) => Number(r.id));
  },

  // 平台列表 + summary（分页）
  async listPlatforms(who, filters = {}) {
    const { rows, summary, domains } = await collectPlatforms(db, who, filters);
    const pageSize = Math.min(Math.max(Number(filters.page_size) || 50, 1), 100);
    const page = Math.max(Number(filters.page) || 1, 1);
    return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, summary, domains };
  },

  // 全量平台（导出用，不分页）
  async listPlatformsAll(who, filters = {}) {
    const { rows, summary } = await collectPlatforms(db, who, filters);
    return { rows, total: rows.length, summary };
  },


  // 展开：平台下文章的参考明细（窗口/share/冻结段/活跃段区间和）
  async platformArticles(projectId, domain) {
    const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return null;
    const fp = buildFingerprint(project);
    const articles = await db.prepare(
      `SELECT a.*, u.name AS copywriter_name, u.email AS copywriter_email
       FROM project_external_articles a
       LEFT JOIN project_copywriters c ON c.id = a.copywriter_id
       LEFT JOIN users u ON u.id = c.user_id
       WHERE a.project_id = ? AND a.domain = ? ORDER BY a.created_at ASC, a.id ASC`
    ).all(projectId, domain);
    if (!articles.length) return null;
    const agg = await platformAggregate(db, projectId, domain, fp);
    const windowsByArticle = mapWindows(articles, agg.dataThrough);
    const out = [];
    for (const a of articles) {
      const freezes = await db.prepare(
        'SELECT * FROM project_external_article_freezes WHERE article_id = ? ORDER BY segment_revision'
      ).all(a.id);
      // 活跃段区间和（窗口 ∩ 活跃段，半开到数据截至日后一日）
      const win = windowsByArticle.get(Number(a.id));
      const segStart = a.status === 'active' ? (a.active_segment_started_at || (win ? win.start : null)) : null;
      const activeEnd = agg.dataThrough ? dayAfter(agg.dataThrough) : null;
      let active = null;
      if (segStart && activeEnd && activeEnd > segStart && win && (!win.end || segStart < win.end)) {
        const to = win.end && win.end < activeEnd ? win.end : activeEnd;
        const from = segStart > win.start ? segStart : win.start;
        if (to > from) {
          const rows = await db.prepare(
            "SELECT date, value FROM project_external_daily_metrics WHERE project_id = ? AND domain = ? AND source = 'users' AND config_fingerprint = ? AND date >= ? AND date < ?"
          ).all(projectId, domain, fp, from, to);
          active = { from, to, users: aggregateDaily(rows, from, to) };
        }
      }
      const frozenUsers = freezes.reduce((s, f) => s + (f.users_value === null ? 0 : f.users_value), 0);
      out.push({
        id: Number(a.id),
        url: a.url,
        title: a.title,
        title_source: a.title_source ?? null,
        title_fetch_status: a.title_fetch_status ?? null,
        title_fetch_error: a.title_fetch_error ?? null,
        anchor_text: a.anchor_text,
        published_at: a.published_at,
        status: a.status,
        copywriter_name: a.copywriter_name || null,
        copywriter_email: a.copywriter_email || null,
        window: win ? { start: win.start, end: win.end, share: win.share } : null,
        freezes: freezes.map((f) => ({
          segmentRevision: f.segment_revision, from: f.freeze_start, to: f.freeze_end, share: f.share,
          usersValue: f.users_value, eventsValue: f.events_value,
          usersStatus: f.users_status, eventsStatus: f.events_status, dataThrough: f.data_through,
          revokedAt: f.revoked_at,
        })),
        activeSegment: a.status === 'active' ? { start: segStart, users: active ? active.users : null } : null,
        referenceUsers: frozenUsers + (active && active.users.value !== null ? active.users.value : 0),
        referenceComplete: freezes.every((f) => f.users_status === 'complete')
          && (a.status === 'inactive' || Boolean(active && active.users.complete)),
      });
    }
    return {
      project_id: Number(projectId), domain,
      platform: { usersTotal: agg.usersTotal, eventsTotal: agg.eventsTotal, dataThrough: agg.dataThrough, complete: agg.complete, staleConfig: agg.staleConfig },
      articles: out,
    };
  },
});

async function platformAggregate(db, projectId, domain, fingerprint) {
  if (!fingerprint) return { usersTotal:null,eventsTotal:null,days:0,dataThrough:null,complete:false,staleConfig:true,lastSyncedAt:null };
  const aggregates = await loadPlatformAggregates(db,[{project_id:projectId,domain,fingerprint}],{includeFreezes:false});
  return aggregates.get(projectId + '|' + domain).aggregate;
}

// 每篇文章所在窗口（完整登记清单切）
function mapWindows(articles, dataThrough) {
  const { windows } = computePlatformWindows(articles, businessToday(), dataThrough);
  const byArticle = new Map();
  for (const w of windows) for (const id of w.articleIds) byArticle.set(Number(id), w);
  return byArticle;
}

function emptySummary() {
  return { platformCount: 0, registeredArticleCount: 0, matchedArticleCount: 0, activeArticleCount: 0, freezeCount: 0 };
}
