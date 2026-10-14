// article-monitor.js —— 站内监控看板接口（任务09）
// 列表先限制可访问项目，再过滤/稳定排序/分页；summary 基于全部命中集合。
// 展开才查月度/历史/基线（GET :articleId/monthly）。XLSX 导出资任务13。
// 便捷编辑（文案师/发布日期）复用任务06 的管理接口，本文件不重复实现写路径。

const express = require('express');
const { wrap, parseId, badId } = require('../lib/http');
const { isValidMonth } = require('../lib/business-dates');

// 达标筛选值
const ATTAINMENTS = ['attained', 'not-attained', 'observation', 'pending', 'syncing', 'data-issue', 'pending-key-events'];
const SYNCS = ['dirty', 'error', 'ok'];
const PAGE_SIZES = [25, 50, 100];

module.exports = function articleMonitorRoutes({ db, assertProjectAccess }) {
  const router = express.Router();

  router.get('/api/article-monitor/options', wrap(async (req, res) => {
    res.json(await db.listMonitorOptions({ userId: req.user.id, isAdmin: req.user.role === 'admin' }));
  }));

  // 列表 + summary。today 可注入（测试钉死业务日；生产不传 = 当天）
  router.get('/api/article-monitor', wrap(async (req, res) => {
    const q = req.query || {};
    if (q.project_id && !parseId(q.project_id)) return badId(res);
    if (q.attainment && !ATTAINMENTS.includes(q.attainment)) {
      return res.status(400).json({ error: 'attainment 参数不正确' });
    }
    if (q.sync && !SYNCS.includes(q.sync)) return res.status(400).json({ error: 'sync 参数不正确' });
    const pageSize = Number(q.page_size) || 50;
    if (!PAGE_SIZES.includes(pageSize)) return res.status(400).json({ error: 'page_size 只能是 25/50/100' });
    const out = await db.listMonitor(
      { userId: req.user.id, isAdmin: req.user.role === 'admin' },
      {
        project_id: q.project_id ? Number(q.project_id) : null,
        status: q.status || '',
        copywriter_user_id: q.copywriter_user_id ? Number(q.copywriter_user_id) : null,
        missing_published_at: q.missing_published_at === '1',
        unassigned: q.unassigned === '1',
        attainment: q.attainment || '',
        sync: q.sync || '',
        query: q.query || '',
        sort: q.sort || '',
        dir: q.dir || '',
        page: q.page || 1,
        page_size: pageSize,
        today: q.today && /^\d{4}-\d{2}-\d{2}$/.test(q.today) ? q.today : undefined,
      }
    );
    res.json(out);
  }));

  // 展开：月度明细 + 曾用地址（先过项目访问校验）
  router.get('/api/article-monitor/:articleId/monthly', wrap(async (req, res) => {
    const aid = parseId(req.params.articleId);
    if (!aid) return badId(res);
    const article = await db.getArticle(aid);
    if (!article) return res.status(404).json({ error: '文章不存在' });
    if (!(await assertProjectAccess(req, res, article.project_id))) return;
    const today = req.query.today && /^\d{4}-\d{2}-\d{2}$/.test(req.query.today) ? req.query.today : undefined;
    const detail = await db.getArticleMonthlyDetail(aid, { today });
    res.json({ article, ...detail });
  }));

  // ============ 外链平台（任务12） ============

  // 平台列表 + summary：文章筛选 → 命中平台集合 → 排序分页。
  // 文案师筛选下平台数字仍是平台整体数据（rows 带 matched/registered/activeArticleCount）。
  router.get('/api/article-monitor/external', wrap(async (req, res) => {
    const q = req.query || {};
    const pageSize = Number(q.page_size) || 50;
    if (![25, 50, 100].includes(pageSize)) return res.status(400).json({ error: 'page_size 只能是 25/50/100' });
    const out = await db.listPlatforms(
      { userId: req.user.id, isAdmin: req.user.role === 'admin' },
      {
        project_id: q.project_id ? Number(q.project_id) : null,
        status: q.status || '',
        copywriter_user_id: q.copywriter_user_id ? Number(q.copywriter_user_id) : null,
        missing_published_at: q.missing_published_at === '1',
        unassigned: q.unassigned === '1',
        domain: q.domain || '',
        sync: q.sync || '',
        q: q.query || q.q || '',
        sort: q.sort || '',
        dir: q.dir || '',
        page: q.page || 1,
        page_size: pageSize,
        today: q.today && /^\d{4}-\d{2}-\d{2}$/.test(q.today) ? q.today : undefined,
      }
    );
    res.json(out);
  }));

  // 展开：平台下文章参考明细（窗口/share/冻结段/活跃段），再次验证权限
  router.get('/api/article-monitor/external/:projectId/:domain/articles', wrap(async (req, res) => {
    const pid = parseId(req.params.projectId);
    const domain = String(req.params.domain || '').trim().toLowerCase();
    if (!pid || !domain) return res.status(400).json({ error: '参数不正确' });
    if (!(await assertProjectAccess(req, res, pid))) return;
    const detail = await db.platformArticles(pid, domain);
    if (!detail) return res.status(404).json({ error: '平台不存在' });
    res.json(detail);
  }));

  return router;
};
