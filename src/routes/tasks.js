// tasks.js —— 任务（可挂项目，也可以不挂）

const express = require('express');
const { wrap, parseId, badId, pick, nullableNumber } = require('../lib/http');
const { validateBusinessFields } = require('../services/mcp-write');

const TASK_FIELDS = ['project_id', 'title', 'description', 'status', 'priority', 'due_date'];
// 任务状态只有「待办/已完成」；已逾期由「到期日 < 今天且未完成」派生，非存储值。
// 传入 doing/review 等旧值会被归一化成 todo（配合 migrations.js 的存量迁移）。
const TASK_STATUS = ['todo', 'done'];
const TASK_PRIORITY = ['high', 'medium', 'low'];

function normalizeTask(data) {
  const out = { ...data };
  if ('project_id' in out) out.project_id = nullableNumber(out.project_id);
  if ('status' in out && !TASK_STATUS.includes(out.status)) out.status = 'todo';
  if ('priority' in out && !TASK_PRIORITY.includes(out.priority)) out.priority = 'medium';
  for (const k of ['title', 'description', 'due_date']) if (k in out) out[k] = String(out[k] ?? '').trim();
  if ('due_date' in out && !out.due_date) out.due_date = null;
  return validateBusinessFields('task', out, { partial: true });
}

module.exports = function taskRoutes({ db, assertProjectAccess }) {
  const router = express.Router();

  // 任务访问校验：project_id 有值时看项目权限（owner/协作者/admin），
  // 没有 project_id（不挂项目的任务）时看 tasks.owner_user_id 本身。
  async function assertTaskAccess(req, res, task) {
    const isAdmin = req.user.role === 'admin';
    if (task.project_id) {
      if (!(await db.canAccessProject(task.project_id, req.user.id, isAdmin))) {
        res.status(403).json({ error: '无权访问该任务' });
        return false;
      }
      return true;
    }
    if (!isAdmin && task.owner_user_id !== req.user.id) {
      res.status(403).json({ error: '无权访问该任务' });
      return false;
    }
    return true;
  }

  router.get('/api/tasks', wrap(async (req, res) => {
    const pid = req.query.project_id ? parseId(req.query.project_id) : null;
    if (pid && !(await assertProjectAccess(req, res, pid))) return;
    res.json(await db.listTasks(pid, { ownerUserId: req.user.id, isAdmin: req.user.role === 'admin' }));
  }));

  router.post('/api/tasks', wrap(async (req, res) => {
    const b = req.body || {};
    if (!String(b.title || '').trim()) return res.status(400).json({ error: '任务标题必填' });
    const projectId = b.project_id ? parseId(b.project_id) : null;
    if (b.project_id && !projectId) return badId(res);
    if (projectId && !(await assertProjectAccess(req, res, projectId))) return;
    let data;
    try { data = normalizeTask({
      project_id: projectId, title: b.title, description: b.description || '',
      status: b.status || 'todo', priority: b.priority || 'medium', due_date: b.due_date || '',
    }); } catch (e) { return res.status(400).json({ error: e.issues?.[0]?.message || e.message }); }
    const id = await db.insert('tasks', { ...data, owner_user_id: req.user.id, created_at: db.now() });
    res.status(201).json(await db.getTask(id));
  }));

  router.put('/api/tasks/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    const existing = await db.getTask(id);
    if (!existing) return res.status(404).json({ error: '任务不存在' });
    if (!(await assertTaskAccess(req, res, existing))) return;
    let data;
    try { data = normalizeTask(pick(req.body || {}, TASK_FIELDS)); }
    catch (e) { return res.status(400).json({ error: e.issues?.[0]?.message || e.message }); }
    if ('title' in data && !data.title) return res.status(400).json({ error: '任务标题必填' });
    if ('project_id' in data && data.project_id && !(await assertProjectAccess(req, res, data.project_id))) return;
    await db.update('tasks', id, data);
    res.json(await db.getTask(id));
  }));

  router.delete('/api/tasks/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    const existing = await db.getTask(id);
    if (!existing) return res.status(404).json({ error: '任务不存在' });
    if (!(await assertTaskAccess(req, res, existing))) return;
    await db.remove('tasks', id);
    res.json({ ok: true });
  }));

  return router;
};
