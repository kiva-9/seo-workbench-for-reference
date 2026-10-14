// project-copywriters.js —— 项目文案师名单与文章指派（任务05，2026-09-28 修订）
//
// 产品模型：项目只有一个角色——文案师。名单即成员、成员即访问权限（与 owner 同等的
// 业务权限，admin 专属操作除外）；没有「协作者」这个第二身份（协作者表已废弃，
// 访问校验和列表可见性都认名单，见 src/db/queries/projects.js）。
//
// 权限矩阵（全部经 assertProjectAccess：owner / 在册文案师 / admin 放行，其余 403）：
//   读取名单/候选/引用计数      三者皆可
//   启用名单项（= 入册授权）     三者皆可
//   移除名单项（= 收回权限）     三者皆可
//   单篇/批量指派               三者皆可
// 安全边界：
//   - 候选 = 全部已有登录账号；启用即入册（授权）；不建号、不改角色、不改邮箱；
//   - 只从名单在册项指派；revoked 的历史项只读（保留署名，不接新指派）；
//   - 批量指派先证明文章与名单同属本项目，不过整批零写；
//   - 移除只动名单行，绝不碰 users；有历史引用的行保留并标「已移出项目」。

const express = require('express');
const { wrap, parseId, badId } = require('../lib/http');

module.exports = function projectCopywriterRoutes({ db, assertProjectAccess }) {
  const router = express.Router();

  // 名单（含账号邮箱、引用计数、是否仍将是项目成员）
  router.get('/api/projects/:id/copywriters', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    res.json(await db.listProjectCopywriters(id));
  }));

  // 候选账号：本项目 owner + 协作者，最小字段（业务下拉禁止调 /api/users）
  router.get('/api/projects/:id/copywriter-candidates', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    res.json(await db.listCopywriterCandidates(id));
  }));

  // 启用名单项：user_id 必须是当前 owner/协作者（不建号、不授权、不改角色）
  router.post('/api/projects/:id/copywriters', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const userId = parseId(req.body?.user_id);
    if (!id || !userId) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    // 入册即授权：任何已有登录账号都可以成为文案师（与 owner 同等项目权限）。
    // 账号不存在才拒绝——不代建号、不改角色。
    if (!(await db.getUser(userId))) {
      return res.status(400).json({ error: '账号不存在：文案师必须从已有登录账号选择，新账号需先完成首次登录' });
    }
    const entry = await db.enableCopywriter(id, userId, db.now());
    // 返回带引用计数/在册状态的完整行（前端名单卡片直接用）
    const rows = await db.listProjectCopywriters(id);
    const row = rows.find((r) => Number(r.id) === entry.id);
    res.status(entry.created ? 201 : 200).json({ ...row, created: entry.created, reactivated: entry.reactivated });
  }));

  // 移除名单项：同原子单元查引用；有引用拒绝。绝不删 users 账号。
  router.delete('/api/projects/:id/copywriters/:copywriterId', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const cid = parseId(req.params.copywriterId);
    if (!id || !cid) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const item = await db.findProjectCopywriter(id, cid);
    if (!item) return res.status(404).json({ error: '名单项不存在或不属于该项目' });
    // 移除 = 收回权限（名单即权限）。有文章引用的行保留作历史署名（列表标「已移出
    // 项目」），新指派被在册闸门挡住；无引用则整行删除。
    const out = await db.removeCopywriter(id, cid, db.now());
    res.json({
      ok: true,
      revoked: out.revoked,
      history_kept: out.references > 0 && !out.removed,
      references: out.references,
    });
  }));

  // copywriter_id：null/空串 = 明确清空；数字 = 指派；其它值 400（不能把 'abc' 当成清空）
  function parseCopywriterId(raw) {
    if (raw === null || raw === '' || raw === undefined) return null;
    const n = parseId(raw);
    if (n === null) return undefined;
    return n;
  }

  // 单篇指派（明确设置/清空）：文章与名单都必须属于路由项目
  router.put('/api/projects/:id/articles/:articleId/copywriter', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const articleId = parseId(req.params.articleId);
    if (!id || !articleId) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const copywriterId = parseCopywriterId(req.body?.copywriter_id);
    if (copywriterId === undefined) return res.status(400).json({ error: 'copywriter_id 参数不正确' });
    const out = await db.assignArticlesCopywriter(id, [articleId], copywriterId, 'overwrite', db.now());
    if (!out.ok) return res.status(400).json({ error: out.reason || '指派失败' });
    if (!out.updated) return res.status(404).json({ error: '文章不存在或不属于该项目' });
    res.json({ ok: true, article_id: articleId, copywriter_id: copywriterId });
  }));

  // 批量指派：fill_empty（默认，只填空置）/ overwrite（覆盖）；null = 明确清空。
  // 预检不过整批零写；提交按业务单元分批，返回真实成功/失败/未处理集合。
  router.post('/api/projects/:id/copywriter-assignments', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const mode = req.body?.mode === 'overwrite' ? 'overwrite' : 'fill_empty';
    const rawIds = req.body?.article_ids;
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    if (!Array.isArray(rawIds) || !rawIds.length) {
      return res.status(400).json({ error: 'article_ids 必须是非空数组' });
    }
    const copywriterId = parseCopywriterId(req.body?.copywriter_id);
    if (copywriterId === undefined) return res.status(400).json({ error: 'copywriter_id 参数不正确' });

    // 预检模式：只返回真正受影响的 ID 与数量，一条都不写（确认后带同样的体重试）
    if (req.body?.preview === true) {
      const check = await db.checkAssignment(id, rawIds, copywriterId);
      if (!check.ok) return res.status(400).json({ error: check.reason, rejected: check.rejected || [] });
      // 逐篇算「本次会被改动」的集合：fill_empty 只算空置，overwrite 算全部（同值也算改动一次）
      const rows = await db.db.prepare(
        'SELECT id, copywriter_id FROM project_articles WHERE project_id = @pid'
      ).all({ pid: id });
      const target = new Map(rows.map((r) => [Number(r.id), r.copywriter_id]));
      const affected = check.articleIds.filter((aid) =>
        mode === 'overwrite' ? true : (target.get(aid) ?? null) !== (copywriterId ?? null));
      return res.json({ ok: true, preview: true, mode, affected_ids: affected, affected_count: affected.length });
    }

    const out = await db.assignArticlesCopywriter(id, rawIds, copywriterId, mode, db.now());
    // 预检失败（越权/无效目标/名单不符）= 一条都没写 → 400 整批拒绝；
    // 分块部分失败有真实提交边界信息 → 200 带 succeeded/failed/unprocessed
    const preFailed = !out.ok && !out.failed.length && !out.succeeded.length;
    if (preFailed) return res.status(400).json({ error: out.reason || '指派失败' });
    res.json({
      ok: out.ok, updated: out.updated, mode,
      succeeded: out.succeeded || [], failed: out.failed || [], unprocessed: out.unprocessed || [],
      ...(out.rejected?.length ? { rejected: out.rejected, reason: out.reason } : {}),
    });
  }));

  return router;
};
