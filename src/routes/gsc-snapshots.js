// gsc-snapshots.js —— GSC 全量快照：查看最新快照、单个 URL 的关键词明细、生成快照（单项目 / 全部项目）

const express = require('express');
const { wrap, parseId, badId, retired } = require('../lib/http');

module.exports = function gscSnapshotRoutes({ db, google, config, assertProjectAccess }) {
  const router = express.Router();

  // 取最新快照的完整数据（URL 列表 + 汇总 + 快照元信息），GA 从累计表读
  router.get('/api/projects/:id/gsc-snapshot/latest', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    const project = await assertProjectAccess(req, res, id);
    if (!project) return;

    const snap = await db.getLatestGscSnapshot(id);
    if (!snap) {
      return res.json({
        snapshot: null,
        hasGsc: Boolean(google.resolveAccounts(project).gscAccountId && project.gsc_site),
        dataLagDays: google.DATA_LAG_DAYS,
        summary: null,
        urls: [],
      });
    }
    const summary = await db.getGscSnapshotSummary(snap.id);
    const opts = { limit: Number(req.query.limit) || 1000, search: req.query.q || '' };
    const urls = await db.getGscSnapshotUrls(snap.id, opts);
    // 同时把 GA 累计指标合并进来（ga4_metrics 是当前累计，和快照 GSC 口径不同但用户需要看）
    const gaMap = new Map();
    try {
      const gaTotals = await db.listGa4Totals(id);
      for (const g of gaTotals) {
        gaMap.set(g.url_id, g);
      }
    } catch { /* ga4_metrics 没数据就空 */ }

    const mergedUrls = urls.map((u) => {
      const g = gaMap.get(u.url_id);
      return {
        url_id: u.url_id,
        url: u.url,
        clicks: u.clicks,
        impressions: u.impressions,
        ctr: u.ctr,
        position: u.position,
        query_count: u.query_count,
        ga_sessions: g?.sessions ?? null,
        ga_users: g?.users ?? null,
        ga_pageviews: g?.pageviews ?? null,
        ga_key_events: g?.key_events ?? null,
        ga_fetched_at: g ? 'yes' : null,
      };
    });

    res.json({
      snapshot: snap,
      hasGsc: Boolean(google.resolveAccounts(project).gscAccountId && project.gsc_site),
      dataLagDays: google.DATA_LAG_DAYS,
      summary,
      urls: mergedUrls,
    });
  }));

  // 某快照中某个 URL 的关键词明细
  router.get('/api/projects/:id/gsc-snapshot/latest/queries/:urlId', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const urlId = parseId(req.params.urlId);
    if (!id || !urlId) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;

    const snap = await db.getLatestGscSnapshot(id);
    if (!snap) return res.json({ rows: [], total: 0 });

    const opts = {
      limit: Number(req.query.limit) || 500,
      orderBy: String(req.query.order_by || 'impressions'),
      search: req.query.q || '',
    };
    const rows = await db.getGscSnapshotQueriesForUrl(snap.id, urlId, opts);
    res.json({ snapshotId: snap.id, urlId, rows });
  }));

  // 旧写接口退役（任务14）：全量快照/关键词下钻已从产品移除，
  // 月度指标统一走 /api/projects/:id/article-sync
  router.post('/api/projects/:id/gsc-snapshot', (req, res) =>
    retired(res, '全量快照已退役，请使用文章监控的月度同步'));
  router.post('/api/gsc-snapshot-all', (req, res) =>
    retired(res, '全量快照已退役，请使用文章监控的月度同步'));

  return router;
};
