// project-external-article-freezes.js —— 外链冻结段：停用原子冻结 / 恢复开新段（任务11）
//
// 契约要点：
//   - 停用在一个原子单元内完成「计算冻结值 → 条件 INSERT 冻结 → 条件 UPDATE 状态」，
//     INSERT 与 UPDATE 都验证 active、segment_revision 及登记修订；影响行数必须双正，
//     不允许「无条件 INSERT、UPDATE 零行也算成功」。
//   - 冻结值优先 INSERT…SELECT 内求和（同一原子快照）；窗口在外部算，提交时用
//     registry_revision 守卫平台登记没变。
//   - 唯一段修订（segment_revision）防并发/重复停用：同日多次恢复不会重复关闭同一段。
//   - 恢复保留旧段，从恢复日开新段；配置/日期变化只重算未冻结区间（读时计算，不落库）。

const { DATA_LAG_DAYS } = require('../../google/constants');
const { withAtomicGuard } = require('../../lib/atomic-guard');
const {
  computePlatformWindows, computeFreezeRange, aggregateDaily, dayAfter,
} = require('../../lib/external-windows');
const { buildFingerprint } = require('../../lib/external-fingerprint');

// 平台当前有效指纹（与日同步同一构造）
function fingerprintOf(projectRow) {
  return buildFingerprint(projectRow);
}

// 平台的日数据（当前指纹）按日期取值，供窗口聚合
async function loadPlatformDaily(db, projectId, domain, fingerprint, start, end) {
  const rows = await db.prepare(
    "SELECT date, source, value FROM project_external_daily_metrics WHERE project_id = ? AND domain = ? AND config_fingerprint = ? AND date >= ? AND date < ?"
  ).all(projectId, domain, fingerprint, start, end);
  const bySource = { users: [], events: [] };
  for (const r of rows) {
    if (!bySource[r.source]) bySource[r.source] = [];
    bySource[r.source].push({ date: r.date, value: r.value });
  }
  return bySource;
}

// 平台的数据截至日（当前指纹的最大日期）
async function platformDataThrough(db, projectId, domain, fingerprint) {
  const row = await db.prepare(
    'SELECT MAX(date) AS d FROM project_external_daily_metrics WHERE project_id = ? AND domain = ? AND config_fingerprint = ?'
  ).get(projectId, domain, fingerprint);
  return row && row.d ? row.d : null;
}

module.exports = (db) => {
  // 本模块由 api.js 注入后端（不是扁平 api），读都走 db.prepare；
  // 内部读助手不进返回对象——api.js 对重名直接报错
  const getArticle = async (id) => db.prepare('SELECT * FROM project_external_articles WHERE id = ?').get(id);

  return {
  // ============ 读 ============

  listArticleFreezes: async (articleId) => db.prepare(
    'SELECT * FROM project_external_article_freezes WHERE article_id = ? ORDER BY segment_revision'
  ).all(articleId),

  // 平台的窗口视图（任务11 第1/2条；含 inactive；作者筛选不影响窗口）
  async platformWindows(projectId, domain, today, fingerprint) {
    const articles = await db.prepare(
      'SELECT id, url, published_at, created_at, status FROM project_external_articles WHERE project_id = ? AND domain = ?'
    ).all(projectId, domain);
    const dataThrough = fingerprint ? await platformDataThrough(db, projectId, domain, fingerprint) : null;
    return computePlatformWindows(articles, today, dataThrough);
  },

  // ============ 写：停用原子冻结 ============

  // 组装「停用」原子单元的语句（不执行，返回 { statements, meta }）。
  // 调用方（路由）在执行前后做业务校验；media 计算全部内嵌在 SQL 里。
  async buildDisableUnit(articleId, { today = null } = {}) {
    const { businessToday } = require('../../lib/business-dates');
    const day = today || businessToday();
    const article = await getArticle(articleId);
    if (!article) return { ok: false, reason: '外链文章不存在' };
    if (article.status !== 'active') return { ok: false, reason: '只有活跃中的外链可以停用' };

    const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(article.project_id);
    const fingerprint = fingerprintOf(project);
    const articles = await db.prepare(
      'SELECT id, url, published_at, created_at, status FROM project_external_articles WHERE project_id = ? AND domain = ? LIMIT 1001'
    ).all(article.project_id, article.domain);
    if (articles.length > 1000) return { ok: false, reason: '单平台超过 1000 篇，冻结窗口超出单次预算' };
    const dataThrough = fingerprint ? await platformDataThrough(db, article.project_id, article.domain, fingerprint) : null;
    const { windows } = computePlatformWindows(articles, day, dataThrough);
    const idx = windows.findIndex((w) => w.articleIds.includes(Number(articleId)));
    if (idx === -1) {
      // 缺发布日仍可停用，但不能用登记日伪造统计窗口或冻结零值。
      const statement = db.prepare(
        `UPDATE project_external_articles
         SET status = 'inactive', active_segment_started_at = NULL,
             segment_revision = segment_revision + 1, updated_at = @at
         WHERE id = @aid AND status = 'active' AND segment_revision = @rev AND registry_revision = @reg`
      ).bind({ aid: articleId, rev: article.segment_revision, reg: article.registry_revision, at: new Date().toISOString() });
      return {
        ok: true,
        statements: withAtomicGuard(db, [statement], 'SELECT EXISTS(SELECT 1 FROM project_external_articles a JOIN projects p ON p.id=a.project_id WHERE a.id=? AND a.revision=? AND p.data_revision=? AND p.config_revision=?)', [article.id,article.revision,project.data_revision,project.config_revision]),
        meta: { unknownRange: true, freezeRange: null, share: null, dataThrough,
          users: { value: null, complete: false }, events: { value: null, complete: false } },
      };
    }
    const win = windows[idx];
    const nextGroupStart = idx + 1 < windows.length ? windows[idx + 1].start : null;

    const range = computeFreezeRange({
      windowStart: win.start,
      segmentStart: article.active_segment_started_at || win.start,
      disabledAt: day,
      nextGroupStart,
      today: day,
      lagDays: DATA_LAG_DAYS,
    });

    // 冻结区间聚合（外部算只用于展示与状态；提交值以 SQL 内求和为准）
    const daily = fingerprint && !range.empty ? await loadPlatformDaily(db, article.project_id, article.domain, fingerprint, range.start, range.end) : { users: [], events: [] };
    const usersAgg = range.empty ? { value: 0, complete: true } : aggregateDaily(daily.users, range.start, range.end);
    const eventsAgg = range.empty ? { value: 0, complete: true } : aggregateDaily(daily.events, range.start, range.end);

    const statements = [
      // 1) 冻结行：值/覆盖/状态在 INSERT…SELECT 里现场求和（同一原子快照）；
      //    WHERE 守卫 active + segment_revision——并发/重复停用直接被挡
      db.prepare(
        `INSERT INTO project_external_article_freezes
          (article_id, project_id, domain, segment_revision, freeze_start, freeze_end, share,
           users_value, events_value, users_status, events_status, data_through, config_fingerprint, revoked_at, created_at)
         SELECT @aid, @pid, @domain, @rev, @start, @end, @share,
           CASE WHEN @start >= @end THEN 0 ELSE
             (SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE SUM(value) END FROM project_external_daily_metrics
               WHERE project_id = @pid AND domain = @domain AND source = 'users'
                 AND date >= @start AND date < @end AND config_fingerprint = @fp)
           END,
           CASE WHEN @start >= @end THEN 0 ELSE
             (SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE SUM(value) END FROM project_external_daily_metrics
               WHERE project_id = @pid AND domain = @domain AND source = 'events'
                 AND date >= @start AND date < @end AND config_fingerprint = @fp)
           END,
           @usersStatus, @eventsStatus, @dataThrough, @fp, @at, @at
         FROM (SELECT 1) 
         WHERE (SELECT status FROM project_external_articles WHERE id = @aid) = 'active'
           AND (SELECT segment_revision FROM project_external_articles WHERE id = @aid) = @rev`
      ).bind({
        aid: articleId, pid: article.project_id, domain: article.domain,
        rev: article.segment_revision,
        start: range.empty ? day : range.start, end: range.empty ? day : range.end,
        share: win.share,
        usersStatus: range.empty ? 'complete' : (usersAgg.value === null ? 'pending' : (usersAgg.complete ? 'complete' : 'partial')),
        eventsStatus: range.empty ? 'complete' : (eventsAgg.value === null ? 'pending' : (eventsAgg.complete ? 'complete' : 'partial')),
        dataThrough, fp: fingerprint, at: new Date().toISOString(),
      }),
      // 2) 状态推进：active + segment_revision + registry_revision 三条件；
      //    平台登记在同步途中变过（registry_revision 变了）→ 整单元不生效
      db.prepare(
        `UPDATE project_external_articles
         SET status = 'inactive', active_segment_started_at = NULL,
             segment_revision = segment_revision + 1, updated_at = @at
         WHERE id = @aid AND status = 'active' AND segment_revision = @rev AND registry_revision = @reg`
      ).bind({ aid: articleId, rev: article.segment_revision, reg: article.registry_revision, at: new Date().toISOString() }),
    ];
    return {
      ok: true, statements: withAtomicGuard(db, statements, 'SELECT EXISTS(SELECT 1 FROM project_external_articles a JOIN projects p ON p.id=a.project_id WHERE a.id=? AND a.revision=? AND p.data_revision=? AND p.config_revision=?)', [article.id,article.revision,project.data_revision,project.config_revision]),
      meta: {
        freezeRange: range.empty ? { empty: true } : { start: range.start, end: range.end },
        share: win.share,
        dataThrough,
        users: usersAgg, events: eventsAgg,
      },
    };
  },

  // 执行停用（原子单元）。返回 { ok, reason?, meta? }；ok=false 时 reason 说明
  // 是「单元被守卫挡下」还是业务前置不满足。
  async disableArticle(articleId, opts = {}) {
    const unit = await this.buildDisableUnit(articleId, opts);
    if (!unit.ok) return { ok: false, reason: unit.reason };
    const results = await db.batchAtomic(unit.statements);
    const inserted = Number(results[1]?.changes || 0);
    const updated = Number(results[unit.meta.unknownRange ? 1 : 2]?.changes || 0);
    if ((!unit.meta.unknownRange && !inserted) || !updated) {
      return { ok: false, reason: '停用未生效（该外链状态在提交前发生变化，请刷新后重试）' };
    }
    return { ok: true, meta: unit.meta };
  },

  // 恢复：保留旧段，从恢复日开新段（segment_revision +1；唯一修订防重复关闭）。
  async resumeArticle(articleId, { today = null } = {}) {
    const { businessToday } = require('../../lib/business-dates');
    const day = today || businessToday();
    const article = await getArticle(articleId);
    if (!article) return { ok: false, reason: '外链文章不存在' };
    if (article.status !== 'inactive') return { ok: false, reason: '只有已停用的外链可以恢复' };
    const results = await db.batchAtomic([
      db.prepare(
        `UPDATE project_external_articles
         SET status = 'active', active_segment_started_at = @day,
             segment_revision = segment_revision + 1, metrics_dirty = 1, updated_at = @at
         WHERE id = @aid AND status = 'inactive' AND segment_revision = @rev`
      ).bind({ aid: articleId, day, rev: article.segment_revision, at: new Date().toISOString() }),
    ]);
    if (!Number(results[0]?.changes || 0)) {
      return { ok: false, reason: '恢复未生效（该外链状态在提交前发生变化，请刷新后重试）' };
    }
    return { ok: true, segmentRevision: article.segment_revision + 1 };
  },

  // 改平台必须把关闭旧段、归属变化和新段放进同一个事务。
  // planOnly 让其他入口在同一业务单元附加权限、配置和幂等守卫。
  async buildExternalDomainChangeUnit(articleId, newDomain, opts = {}) {
    const article = await getArticle(articleId);
    if (!article) return { ok: false, reason: '外链文章不存在' };
    if (article.domain === newDomain) {
      const source=opts.domainSource || 'manual';
      const statements=article.domain_source===source?[]:[db.prepare('UPDATE project_external_articles SET domain_source=?,updated_at=? WHERE id=?').bind(source,new Date().toISOString(),article.id)];
      return {ok:true,changed:statements.length>0,statements:statements.length?withAtomicGuard(db,statements,'SELECT EXISTS(SELECT 1 FROM project_external_articles WHERE id=? AND revision=?)',[article.id,article.revision]):[],article,frozenSegments:0,meta:null};
    }
    const { businessToday } = require('../../lib/business-dates');
    const statements = [];
    let frozen = null;
    if (article.status === 'active') {
      frozen = await this.buildDisableUnit(articleId, opts);
      if (!frozen.ok) return frozen;
      statements.push(...frozen.statements);
    }
    const expectedSegment = article.segment_revision + (article.status === 'active' ? 1 : 0);
    statements.push(db.prepare(
      `UPDATE project_external_articles
       SET domain = @domain, domain_source = @source, status = 'active',
           active_segment_started_at = @day, segment_revision = segment_revision + 1,
           registry_revision = registry_revision + 1, metrics_dirty = 1, updated_at = @at
       WHERE id = @aid AND status = 'inactive' AND segment_revision = @rev`
    ).bind({ aid: articleId, domain: newDomain, source: opts.domainSource || 'manual',
      day: opts.today || businessToday(), rev: expectedSegment, at: new Date().toISOString() }));
    return { ok: true, statements: frozen ? statements : withAtomicGuard(db,statements,'SELECT EXISTS(SELECT 1 FROM project_external_articles WHERE id=? AND revision=?)',[article.id,article.revision]), article, frozenSegments: frozen && !frozen.meta.unknownRange ? 1 : 0, meta: frozen?.meta || null };
  },

  async changeArticleDomain(articleId, newDomain, opts = {}) {
    const unit = await this.buildExternalDomainChangeUnit(articleId, newDomain, opts);
    if (!unit.ok) return unit;
    if (!unit.statements.length) return {ok:true,changed:false};
    const results = await db.batchAtomic(unit.statements);
    if (results.some((r) => !Number(r.changes || 0))) {
      return { ok: false, reason: '域名切换未生效（状态在提交前发生变化）' };
    }
    return { ok: true };
  },
  };
};
