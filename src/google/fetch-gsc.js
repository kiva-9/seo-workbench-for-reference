// fetch-gsc.js —— 抓 GSC 并入库：按月窗口指标（url_metrics）+ 全量快照（gsc_snapshot_*）

const { indexGet, normPath } = require('../lib/url-match');
const { fmtDate, parseDay, addDays, today } = require('../lib/dates');
const { DATA_LAG_DAYS } = require('./constants');
const { isAuthError } = require('./oauth');
const { resolveAccounts } = require('./project-config');
const { lagWarning } = require('./freshness');

function createGscFetchers({ db, gsc }) {
  // 抓取单个项目的 GSC 月数据入库 url_metrics（GA4 是累计的，单独存在 ga4_metrics）。
  // range: { startDate, endDate, periodDays }
  async function fetchProjectGsc(project, range) {
    const { startDate, endDate, periodDays } = range;
    const { gscAccountId } = resolveAccounts(project);
    if (!gscAccountId || !project.gsc_site) {
      return { fetched: 0, matched: 0, startDate, endDate, periodDays, warnings: [], gsc: 'skip' };
    }
    const urls = await db.listUrls(project.id);
    if (!urls.length) {
      return { fetched: 0, matched: 0, startDate, endDate, periodDays, warnings: [], gsc: 'skip' };
    }

    const warnings = [];
    const lag = lagWarning(range);
    if (lag) warnings.push(lag);

    let index = null, authError = false;
    try {
      const r = await gsc.gscQuery(gscAccountId, project.gsc_site, startDate, endDate, urls.map((u) => u.url));
      index = r.index;
      if (r.truncated) warnings.push('GSC 返回结果已达上限，部分页面可能未覆盖');
    } catch (e) {
      warnings.push(`GSC: ${e.message}`);
      authError = isAuthError(e);
    }
    if (authError) throw new Error(warnings.join('；'));
    if (!index) throw new Error(warnings.join('；') || 'GSC 抓取失败');

    const rows = urls.map((u) => {
      const g = indexGet(index, u.url);
      return {
        url_id: u.id, project_id: project.id, period_days: periodDays,
        start_date: startDate, end_date: endDate,
        gsc_clicks: g?.clicks ?? 0, gsc_impressions: g?.impressions ?? 0,
        gsc_ctr: g?.ctr ?? 0, gsc_position: g?.position ?? 0,
        ga_sessions: null, ga_users: null, ga_pageviews: null, ga_key_events: null,
      };
    });
    await db.saveMetrics(rows);

    const matched = rows.filter((r) => r.gsc_clicks || r.gsc_impressions).length;
    if (!matched && urls.length) warnings.push('所有 URL 都没匹配到 GSC 数据，请检查 URL 是否与站内页面路径一致');
    return { fetched: rows.length, matched, startDate, endDate, periodDays, warnings, gsc: 'ok' };
  }

  // 抓取并保存一个 GSC 全量快照（16 个月窗口，page+query 双维度）。
  // 快照含两层：URL 级汇总（从 page+query 聚合出来） + URL-query 明细。
  // 自动滚动保留最近 3 个快照。
  async function fetchGscSnapshot(project, maxRows = 25000) {
    const { gscAccountId } = resolveAccounts(project);
    if (!gscAccountId || !project.gsc_site) {
      throw new Error('该项目尚未绑定 GSC 账号/站点，无法生成快照');
    }
    const urls = await db.listUrls(project.id);
    if (!urls.length) {
      return { snapshot: null, urlCount: 0, queryCount: 0, warnings: ['该项目还没有登记 URL，无法生成快照'] };
    }

    const warnings = [];
    // GSC 数据最多回溯 16 个月（约 488 天）
    const endDate = fmtDate(addDays(parseDay(today()), -DATA_LAG_DAYS));
    const startDate = fmtDate(addDays(parseDay(endDate), -488));

    let result = null, authError = false;
    try {
      result = await gsc.gscPageQuery(gscAccountId, project.gsc_site, startDate, endDate, urls.map((u) => u.url), maxRows);
      if (result.truncated) warnings.push(`快照 page+query 数据已达上限（${maxRows} 条），部分长尾词可能未覆盖`);
    } catch (e) {
      warnings.push(`GSC 快照: ${e.message}`);
      authError = isAuthError(e);
    }
    if (authError) throw new Error(warnings.join('；'));
    if (!result) throw new Error(warnings.join('；') || 'GSC 快照抓取失败');

    // 建立 URL 映射：规范化后的 GSC page → url_id + url
    const urlMap = new Map();
    for (const u of urls) {
      const key = normPath(u.url);
      if (!urlMap.has(key)) urlMap.set(key, u);
    }

    // 聚合 URL 级汇总 + 收集 URL-query 明细
    const urlAgg = new Map(); // url_id -> {clicks, impressions, ctrWeight, positionWeight}
    const queryRows = [];

    for (const row of result.rows) {
      const key = normPath(row.page);
      const u = urlMap.get(key);
      if (!u) continue; // 未登记的 URL 跳过

      // URL-query 明细
      queryRows.push({
        url_id: u.id,
        query: row.query,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      });

      // URL 级聚合
      if (!urlAgg.has(u.id)) {
        urlAgg.set(u.id, { url_id: u.id, url: u.url, clicks: 0, impressions: 0, ctr: 0, posSum: 0, impSum: 0 });
      }
      const agg = urlAgg.get(u.id);
      agg.clicks += row.clicks;
      agg.impressions += row.impressions;
      // CTR 和 position 按曝光量加权
      agg.impSum += row.impressions;
      agg.posSum += row.impressions * row.position;
    }

    // 计算聚合后的 ctr 和 position
    const urlRows = [];
    for (const agg of urlAgg.values()) {
      urlRows.push({
        url_id: agg.url_id,
        url: agg.url,
        clicks: agg.clicks,
        impressions: agg.impressions,
        ctr: agg.impressions ? agg.clicks / agg.impressions : 0,
        position: agg.impSum ? agg.posSum / agg.impSum : 0,
      });
    }

    const snapshotDate = fmtDate(parseDay(today()));
    const saved = await db.saveGscSnapshot({
      project_id: project.id,
      snapshot_date: snapshotDate,
      start_date: startDate,
      end_date: endDate,
      urls: urlRows,
      queries: queryRows,
    });

    return {
      snapshotId: saved.id,
      snapshotDate,
      startDate, endDate,
      urlCount: urlRows.length,
      queryCount: queryRows.length,
      warnings,
      pruned: saved.pruned,
    };
  }

  return { fetchProjectGsc, fetchGscSnapshot };
}

module.exports = { createGscFetchers };
