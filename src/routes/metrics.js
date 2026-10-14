// metrics.js —— 抓数与看数：单项目抓取 / 指标、全部项目汇总、按月历史透视、一键抓取全部项目
// 统计窗口由 ?month=YYYY-MM 或 ?start=&end= 指定，默认上个完整自然月（见 lib/dates 的 resolveRange）

const express = require('express');
const { wrap, parseId, badId, retired } = require('../lib/http');
const { resolveRange } = require('../lib/dates');

module.exports = function metricRoutes({ db, google, config, assertProjectAccess }) {
  const router = express.Router();

  // 旧写接口退役（任务14）：抓取统一走 /api/projects/:id/article-sync（站内）
  // 与 /api/projects/:id/fetch-external-daily（外链平台日数据）
  router.post('/api/projects/:id/fetch', (req, res) =>
    retired(res, '请使用 /api/projects/:id/article-sync'));

  router.get('/api/projects/:id/metrics', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    const project = await assertProjectAccess(req, res, id);
    if (!project) return;
    let range;
    try { range = resolveRange(req.query); } catch (e) { return res.status(400).json({ error: e.message }); }

    const lastFetch = await db.lastFetchForRange(id, range.startDate, range.endDate);
    const rows = await db.getMetricsForRange(id, range.startDate, range.endDate);
    const windows = await db.listFetchedWindows(id);
    res.json({
      ...range,
      dataLagDays: google.DATA_LAG_DAYS,
      lagWarning: google.lagWarning(range),
      hasDataSource: google.hasDataSource(project),
      lastFetch,
      // 这一份是不是在数据定稿前抓的（抓早了 = 数字偏低，建议重抓）
      settledDate: google.settledDate(range.endDate),
      staleFetch: google.fetchedTooEarly(lastFetch?.t, range.endDate),
      rows,
      windows,
    });
  }));

  // 全部项目汇总
  router.get('/api/overview', wrap(async (req, res) => {
    let range;
    try { range = resolveRange(req.query); } catch (e) { return res.status(400).json({ error: e.message }); }

    const scope = { ownerUserId: req.user.id, isAdmin: req.user.role === 'admin' };
    const raw = await db.getOverviewForRange(range.startDate, range.endDate, scope);
    const rows = raw.map((r) => ({
      ...r,
      hasDataSource: google.hasDataSource(r),
      // CTR 用 总点击/总曝光 重算，不是各 URL CTR 的平均
      gsc_ctr: r.gsc_impressions ? r.gsc_clicks / r.gsc_impressions : null,
      // 这个项目本期的数据是不是在定稿前抓的
      staleFetch: Boolean(r.fetched_count) && google.fetchedTooEarly(r.fetched_at, range.endDate),
    }));
    const totals = rows.reduce((acc, r) => ({
      projects: acc.projects + 1,
      urls: acc.urls + (r.url_count || 0),
      gsc_clicks: acc.gsc_clicks + (r.gsc_clicks || 0),
      gsc_impressions: acc.gsc_impressions + (r.gsc_impressions || 0),
      ga_sessions: acc.ga_sessions + (r.ga_sessions || 0),
      ga_users: acc.ga_users + (r.ga_users || 0),
      ga_pageviews: acc.ga_pageviews + (r.ga_pageviews || 0),
    }), { projects: 0, urls: 0, gsc_clicks: 0, gsc_impressions: 0, ga_sessions: 0, ga_users: 0, ga_pageviews: 0 });
    totals.gsc_ctr = totals.gsc_impressions ? totals.gsc_clicks / totals.gsc_impressions : null;
    // 全站平均排名按各项目的 URL 数加权
    const weighted = rows.filter((r) => r.gsc_position > 0 && r.fetched_count > 0);
    const weight = weighted.reduce((s, r) => s + r.fetched_count, 0);
    totals.gsc_position = weight
      ? weighted.reduce((s, r) => s + r.gsc_position * r.fetched_count, 0) / weight
      : null;
    totals.staleProjects = rows.filter((r) => r.staleFetch).length;

    const windows = await db.listFetchedWindows(null);
    res.json({
      ...range,
      dataLagDays: google.DATA_LAG_DAYS,
      lagWarning: google.lagWarning(range),
      settledDate: google.settledDate(range.endDate),
      rows,
      totals,
      windows,
    });
  }));

  // 历史数据表（按月透视，仅 GSC）：每行一个 URL，每个自然月一列点击数。
  // GA4 是累计的、不走逐月，所以这里只统计 GSC。
  router.get('/api/history', wrap(async (req, res) => {
    const projectId = req.query.project_id ? parseId(req.query.project_id) : null;
    if (req.query.project_id && !projectId) return badId(res);
    if (projectId && !(await assertProjectAccess(req, res, projectId))) return;

    const flat = await db.getMonthlyHistory(projectId, { ownerUserId: req.user.id, isAdmin: req.user.role === 'admin' });

    // 数据里实际出现过的月份，升序
    const allMonths = [...new Set(flat.filter((r) => r.ym).map((r) => r.ym))].sort();
    const from = /^\d{4}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to = /^\d{4}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
    const months = allMonths.filter((m) => (!from || m >= from) && (!to || m <= to));
    const inRange = new Set(months);

    // 摊平的行按 URL 聚合
    const byUrl = new Map();
    for (const r of flat) {
      let row = byUrl.get(r.url_id);
      if (!row) {
        row = {
          project_id: r.project_id, project_name: r.project_name, project_status: r.project_status,
          url_id: r.url_id, url: r.url,
          total_clicks: 0, total_impressions: 0,
          total_pageviews: r.ga_total_pageviews ?? null, // GA 累计到今天
          total_key_events: r.ga_total_key_events ?? null, // GA 累计到今天
          clicks: {}, monthsWithData: 0,
        };
        byUrl.set(r.url_id, row);
      }
      if (!r.ym || !inRange.has(r.ym)) continue;
      row.clicks[r.ym] = r.gsc_clicks ?? null;
      row.total_clicks += r.gsc_clicks || 0;
      row.total_impressions += r.gsc_impressions || 0;
      row.monthsWithData++;
    }

    // 默认顺序 = 项目管理里维护的 URL 顺序（sort_order），不按点击量重排；
    // byUrl 的插入顺序由 getMonthlyHistory 的 ORDER BY（项目名 + sort_order）决定。
    const rows = [...byUrl.values()];

    const totals = rows.reduce((acc, r) => {
      acc.urls++;
      acc.total_clicks += r.total_clicks;
      acc.total_impressions += r.total_impressions;
      acc.total_pageviews += r.total_pageviews || 0;
      acc.total_key_events += r.total_key_events || 0;
      for (const m of months) {
        acc.clicks[m] = (acc.clicks[m] || 0) + (r.clicks[m] || 0);
      }
      return acc;
    }, { urls: 0, total_clicks: 0, total_impressions: 0, total_pageviews: 0, total_key_events: 0, clicks: {} });

    res.json({ months, allMonths, rows, totals, projectId });
  }));

  // 旧写接口退役（任务14）：跨项目先选项目，不提供全库一键同步
  router.post('/api/fetch-all', (req, res) =>
    retired(res, '请按项目选择后使用 /api/projects/:id/article-sync'));

  return router;
};
