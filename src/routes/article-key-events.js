// article-key-events.js —— 项目关键事件配置接口（文章监控的判定项来源）
//
// 关键事件选择存储在 projects.key_event_names：
//   - GET 返回 selected / options（GA4 元数据实时发现）/ stale（已选但 GA4 已不存在）/
//     scope（保存会波及的站内/站外启用文章数）；
//   - PUT 校验：数组、去重、≤50 个、单个 ≤120 字符、无控制字符；
//   - 保存即按新事件集失效两侧指标（推进配置修订 + 标 dirty），但不重抓——
//     下次手动刷新时按新事件集取数，旧数据保留标 stale。
// 站外文章共用同一份清单：改事件会同时影响两类文章的口径。

const express = require('express');
const { wrap, parseId, badId } = require('../lib/http');
const { parseKeyEventNames } = require('../google/project-config');
const { saveProjectConfiguration } = require('../services/project-configuration');

const MAX_EVENTS = 50;
const MAX_NAME_LEN = 120;

// 规范化 + 校验
function normalizeKeyEventNames(raw) {
  if (raw === undefined || raw === null) return { names: [] };
  if (!Array.isArray(raw)) throw new Error('eventNames 必须是数组');
  const out = [];
  for (const item of raw) {
    const name = String(item ?? '').trim();
    if (!name) continue;
    if (name.length > MAX_NAME_LEN) throw new Error(`关键事件名不能超过 ${MAX_NAME_LEN} 个字符`);
    // 控制字符会破坏配置可读性与下游匹配
    if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('关键事件名不能包含控制字符');
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > MAX_EVENTS) throw new Error(`一次最多选择 ${MAX_EVENTS} 个关键事件`);
  return { names: out };
}

module.exports = function articleKeyEventsRoutes({ db, google, assertProjectAccess }) {
  const router = express.Router();

  // GET：当前选择 + GA4 候选 + stale + 影响范围
  router.get('/api/projects/:id/article-key-events', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const project = await db.getProject(id);
    if (!project) return res.status(404).json({ error: '项目不存在' });
    const selected = parseKeyEventNames(project.key_event_names);
    // 影响范围：保存会波及的启用文章数（站内/站外共用同一份清单）
    const scope = { internal: 0, external: 0 };
    try { scope.internal = Number((await db.db.prepare("SELECT COUNT(*) AS n FROM project_articles WHERE project_id = ? AND status = 'active'").get(id)).n); } catch { /* 旧库缺表 */ }
    try { scope.external = Number((await db.db.prepare("SELECT COUNT(*) AS n FROM project_external_articles WHERE project_id = ? AND status = 'active'").get(id)).n); } catch { /* 旧库缺表 */ }

    // GA4 候选事件：未配置 GA4 时 options 为空、stale 全列（不让陈旧选择假装有效）
    let options = [];
    let optionsError = null;
    if (project.ga4_account_id && project.ga4_property_id) {
      try {
        options = await google.ga4ListEvents(project.ga4_account_id, project.ga4_property_id);
      } catch (e) { optionsError = e.message; }
    }
    res.json({
      selected,
      options,
      stale: selected.filter((name) => !options.includes(name)),
      optionsError,
      scope,
      limits: { max: MAX_EVENTS, nameMaxLength: MAX_NAME_LEN },
    });
  }));

  // PUT：保存选择（集合比较：顺序不同不算变化）
  router.put('/api/projects/:id/article-key-events', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    const project = await db.getProject(id);
    if (!project) return res.status(404).json({ error: '项目不存在' });
    let names;
    try { ({ names } = normalizeKeyEventNames(req.body?.eventNames)); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
    const before = parseKeyEventNames(project.key_event_names);
    if (sameSet(before, names)) {
      return res.json({ ok: true, selected: names, changed: false, scope: null });
    }
    await saveProjectConfiguration(db, project, { key_event_names: names }, { user_id: req.user.id, current_role: req.user.role });

    const scope = {
      internal: Number((await db.db.prepare("SELECT COUNT(*) AS n FROM project_articles WHERE project_id = ? AND status = 'active'").get(id)).n),
      external: Number((await db.db.prepare("SELECT COUNT(*) AS n FROM project_external_articles WHERE project_id = ? AND status = 'active'").get(id)).n),
    };
    res.json({ ok: true, selected: names, changed: true, scope });
  }));

  return router;
};
