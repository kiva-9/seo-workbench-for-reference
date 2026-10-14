// article-title-fetch.js —— 「获取缺失标题」接口（站内/站外共用一套抓取）
//
// 缺失标题在单请求内串行抓取：
//   - POST /api/projects/:id/article-title-fetch  {kind: internal|external}
//     处理该项目该类型全部「启用 + 标题为空 + 非人工」的文章，不受搜索/筛选影响；
//     返回成功/未获取/跳过/剩余统计。超总时限时 remaining>0 且 partial=true，可再次点击继续。
//   - POST /api/projects/:id/articles/:aid/refetch-title              单篇（站内）
//   - POST /api/projects/:id/external-articles/:aid/refetch-title     单篇（站外）
// 静态路径必须注册在 /:aid 动态路由之前（Express 按注册顺序匹配）。

const express = require('express');
const { wrap, parseId, badId } = require('../lib/http');
const { runProjectTitleFetch, refetchArticleTitle } = require('../lib/article-title-service');

const KINDS = ['internal', 'external'];

module.exports = function articleTitleFetchRoutes({ db, assertProjectAccess }) {
  const router = express.Router();

  // 项目级：一次请求内串行抓完（或抓到时限），回报可执行统计
  router.post('/api/projects/:id/article-title-fetch', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const kind = String(req.body?.kind || 'internal');
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'kind 必须是 internal 或 external' });
    const out = await runProjectTitleFetch(db, id, kind);
    if (out.error) return res.status(500).json({ error: out.error });
    res.json(out);
  }));

  // 站内单篇（静态路径先注册）
  router.post('/api/projects/:id/articles/:aid/refetch-title', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '文章不存在' });
    const out = await refetchArticleTitle(db, aid, 'internal');
    if (!out.ok) return res.status((out.busy || out.superseded) ? 409 : 400).json({ error: out.error });
    res.json(out);
  }));

  // 站外单篇
  router.post('/api/projects/:id/external-articles/:aid/refetch-title', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const aid = parseId(req.params.aid);
    if (!id || !aid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const article = await db.getExternalArticle(aid);
    if (!article || article.project_id !== id) return res.status(404).json({ error: '文章不存在' });
    const out = await refetchArticleTitle(db, aid, 'external');
    if (!out.ok) return res.status((out.busy || out.superseded) ? 409 : 400).json({ error: out.error });
    res.json(out);
  }));

  return router;
};
