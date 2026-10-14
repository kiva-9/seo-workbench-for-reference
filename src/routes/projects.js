// projects.js —— 项目：增删改查、转让、协作者、项目主页

const express = require('express');
const { wrap, parseId, badId, pick, nullableNumber } = require('../lib/http');
const { requireAdmin } = require('../middleware/current-user');
const { buildProjectConfiguration } = require('../services/project-configuration');
const { validateBusinessFields } = require('../services/mcp-write');
const {createConfiguredProject}=require('../services/project-create');
const {refreshProjectCandidates}=require('../services/resource-catalog');

const PROJECT_FIELDS = ['name', 'website', 'status', 'gsc_account_id', 'ga4_account_id', 'gsc_site', 'ga4_property_id', 'notes',
  'key_event_names'];
const PROJECT_STATUS = ['active', 'paused', 'ended'];

// 规范化项目字段：数字列空串转 null，状态兜底，并同步维护旧的 account_id 列
function normalizeProject(data) {
  const out = { ...data };
  if ('gsc_account_id' in out) out.gsc_account_id = nullableNumber(out.gsc_account_id);
  if ('ga4_account_id' in out) out.ga4_account_id = nullableNumber(out.ga4_account_id);
  if ('status' in out && !PROJECT_STATUS.includes(out.status)) out.status = 'active';
  // 关键事件名：前端存的是 JSON 数组字符串，也可能是数组本身或逗号分隔字符串。
  // 先尝试解析 JSON，解析失败才按逗号切分，避免把引号一起拆进去。
  if ('key_event_names' in out) {
    let arr;
    if (Array.isArray(out.key_event_names)) {
      arr = out.key_event_names;
    } else {
      const s = String(out.key_event_names ?? '');
      try { const parsed = JSON.parse(s); arr = Array.isArray(parsed) ? parsed : null; }
      catch { arr = null; }
      if (!arr) arr = s.split(',').map((x) => x.trim()).filter(Boolean);
    }
    out.key_event_names = JSON.stringify([...new Set(arr.map((x) => String(x).trim()).filter(Boolean))]);
  }
  for (const k of ['name', 'website', 'gsc_site', 'ga4_property_id', 'notes']) {
    if (k in out) out[k] = String(out[k] ?? '').trim();
  }
  // 兼容仍在读单一 account_id 的老数据/老备份
  if ('gsc_account_id' in out || 'ga4_account_id' in out) {
    out.account_id = out.gsc_account_id ?? out.ga4_account_id ?? null;
  }
  const basic = {};
  for (const field of ['name','website','status','notes']) {
    if (!(field in out)) continue;
    basic[field] = out[field];
  }
  Object.assign(out, validateBusinessFields('project', basic, { partial: true }));
  return out;
}

module.exports = function projectRoutes({ db, assertProjectAccess }) {
  const router = express.Router();

  router.get('/api/projects', wrap(async (req, res) => {
    res.json(await db.listProjects({ ownerUserId: req.user.id, isAdmin: req.user.role === 'admin' }));
  }));

  router.post('/api/projects', wrap(async (req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: '项目名称必填' });
    let data;
    try { data = normalizeProject({
      name: b.name, website: b.website || '', status: b.status || 'active',
      gsc_account_id: b.gsc_account_id, ga4_account_id: b.ga4_account_id,
      gsc_site: b.gsc_site || '', ga4_property_id: b.ga4_property_id || '',
      notes: b.notes || '',
    }); } catch (e) { return res.status(400).json({ error: e.issues?.[0]?.message || e.message }); }
    const id = await createConfiguredProject(db,data,req.user);
    await refreshProjectCandidates(db);
    res.status(201).json(await db.getProject(id));
  }));

  router.put('/api/projects/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    let data;
    try { data = normalizeProject(pick(req.body || {}, PROJECT_FIELDS)); }
    catch (e) { return res.status(400).json({ error: e.issues?.[0]?.message || e.message }); }
    const effective = { ...(await db.getProject(id)), ...data };
    if ('name' in data && !data.name) return res.status(400).json({ error: '项目名称必填' });

    const config = {};
    for (const field of ['gsc_account_id','gsc_site','ga4_account_id','ga4_property_id','key_event_names']) {
      if (!(field in data)) continue;
      config[field] = field === 'key_event_names' ? JSON.parse(data[field]) : (data[field] || null);
      delete data[field];
    }
    delete data.account_id;
    if(Object.keys(config).length&&req.body.expected_config_revision!==undefined&&req.body.expected_config_revision!==effective.config_revision)return res.status(409).json({error:'项目来源已变化，请刷新后保存'});
    const statements=[];
    if (Object.keys(config).length) {
      try { const unit=await buildProjectConfiguration(db, await db.getProject(id), config, { user_id: req.user.id, current_role: req.user.role }); statements.push(...unit.statements); }
      catch (e) { return res.status(e.code === 'FORBIDDEN' ? 403 : 400).json({ error: e.message }); }
    }
    const fields=Object.keys(data);
    if(fields.length)statements.push(db.db.prepare(`UPDATE projects SET ${fields.map((field)=>field+'=?').join(',')} WHERE id=?`).bind(...fields.map((field)=>data[field]),id));
    if(statements.length)await db.db.batchAtomic(statements);
    if('website' in data||Object.keys(config).length)await refreshProjectCandidates(db);
    res.json(await db.getProject(id));
  }));

  router.delete('/api/projects/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertProjectAccess(req, res, id))) return;
    await db.deleteProject(id);
    await refreshProjectCandidates(db);
    res.json({ ok: true });
  }));

  // 转让项目（admin only）：整体改 owner，任务/URL/链接跟着项目走，不用逐个改
  router.put('/api/projects/:id/owner', requireAdmin, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await db.exists('projects', id))) return res.status(404).json({ error: '项目不存在' });
    const ownerUserId = parseId(req.body?.owner_user_id);
    if (!ownerUserId) return badId(res);
    if (!(await db.getUser(ownerUserId))) return res.status(404).json({ error: '用户不存在' });
    await db.transferProjectOwner(id, ownerUserId, req.user.id);
    res.json(await db.getProject(id));
  }));

  // 项目主页：项目信息 + 任务/链接/外链概况 + 新模型的文章计数。文章清单本身在
  // 「文章监控 / 项目主页的管理 tab」里按新表分页加载（任务06 起），这里只做汇总。
  router.get('/api/projects/:id/home', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    const project = await assertProjectAccess(req, res, id);
    if (!project) return;

    // 「已逾期」是 到期日 < 今天（本地时区）这个派生状态，跟 dashboard/board 的口径必须一致，
    // 而本地时区判断只在前端好做（服务端没有用户的时区），所以这里只给原始任务列表，
    // 逾期/待办数量交给前端用跟 dashboard 相同的 todayStr() 现算。
    const [tasks, projectLinks, articleCount, externalCount] = await Promise.all([
      db.listTasks(id), db.listLinks(id, {}), db.countArticles(id), db.countExternalArticles(id),
    ]);
    res.json({
      project,
      articleCount,
      tasks,
      linkCount: projectLinks.length,
      externalCount,
      isAdmin: req.user.role === 'admin',
    });
  }));

  return router;
};
