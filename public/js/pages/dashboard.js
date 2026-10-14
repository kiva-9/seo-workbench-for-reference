// dashboard.js —— 总览页：KPI + 待办 + 最近项目
import { API } from '../api.js';
import { loadingRows, loadingStats } from '../components/page-loading.js';
import { beginPageRender } from '../page-lifecycle.js';
import {projectHostname} from '../components/project-domain.js';

export async function renderDashboard(el) {
  const isCurrent = beginPageRender(el);
  el.innerHTML = `<header class="page-head"><div><h2>总览</h2><p class="page-desc">项目与任务的当前状态，按到期日排出最该动手的事。</p></div></header>
    <div class="stat-grid">${loadingStats(['进行中项目', '未完成任务', '7 天内到期', '已逾期'])}</div>
    <div class="card dash-section"><div class="section-head"><h3>近期动态</h3><span class="section-note">任务按到期日排序</span></div>
    <div class="dash-split"><div class="dash-col"><div class="dash-col-title">近期任务</div>${loadingRows(['任务', '到期日'])}</div><div class="dash-col"><div class="dash-col-title">项目列表</div>${loadingRows(['项目', '状态'])}</div></div></div>`;
  const [projects, tasks] = await Promise.all([API.projects(), API.tasks()]);
  if (!isCurrent()) return;
  const active = projects.filter((p) => p.status === 'active');
  const openTasks = tasks.filter((t) => t.status !== 'done');
  const overdue = openTasks.filter((t) => t.due_date && t.due_date < todayStr());
  const dueSoon = openTasks.filter((t) => t.due_date && t.due_date >= todayStr() && t.due_date <= daysFromToday(7));

  el.innerHTML = `
    <div class="page-head">
      <div><h2>总览</h2><p class="page-desc">项目与任务的当前状态，按到期日排出最该动手的事。</p></div>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="label">进行中项目</div><div class="value">${active.length}</div><div class="sub">共 ${projects.length} 个</div></div>
      <div class="stat"><div class="label">未完成任务</div><div class="value">${openTasks.length}</div><div class="sub">待办（含已逾期）</div></div>
      <div class="stat"><div class="label">7 天内到期</div><div class="value is-warning">${dueSoon.length}</div><div class="sub">需要动手了</div></div>
      <div class="stat"><div class="label">已逾期</div><div class="value is-danger">${overdue.length}</div><div class="sub">该处理了</div></div>
    </div>

    <div class="card dash-section">
      <div class="section-head">
        <h3>近期动态</h3>
        <span class="section-note">任务按到期日排序</span>
      </div>
      <div class="dash-split">
        <div class="dash-col">
          <div class="dash-col-title">近期任务</div>
          ${openTasks.length ? `<div class="dash-list">${openTasks.slice(0, 8).map((t) => taskRow(t, projects)).join('')}</div>` : '<div class="empty">暂无任务，<a href="#/task-management?view=board">到看板视图新建任务</a></div>'}
        </div>
        <div class="dash-col">
          <div class="dash-col-title">项目列表</div>
          ${projects.length ? `<div class="dash-list">${projects.slice(0, 8).map((p) => projectRow(p)).join('')}</div>` : '<div class="empty">还没有项目，去「项目管理」创建</div>'}
        </div>
      </div>
    </div>`;
}

function taskRow(t, projects) {
  const proj = projects.find((p) => p.id === t.project_id);
  const [stLabel, stClass] = STATUS_MAP[t.status] || ['', ''];
  const overdue = t.due_date && t.due_date < todayStr() && t.status !== 'done';
  return `<div class="item">
    <span class="tag ${stClass}">${stLabel}</span>
    <div class="mid"><div class="t">${esc(t.title)}</div><div class="s">${proj ? esc(proj.name) : '未关联项目'} · ${t.priority === 'high' ? '高优先级' : '普通'}</div></div>
    ${t.due_date ? `<span class="tag ${overdue ? 'tag-red' : 'tag-gray'}">${overdue ? '已逾期 ' : ''}${esc(t.due_date)}</span>` : ''}
  </div>`;
}

function projectRow(p) {
  const [stLabel, stClass] = PROJECT_STATUS[p.status] || ['', ''];
  return `<div class="item" style="cursor:pointer" onclick="location.hash='#/project?id=${p.id}'">
    <div class="mid"><div class="t">${esc(p.name)}</div><div class="s">${esc(projectHostname(p.website) || '未设置项目域名')}</div></div>
    <span class="tag ${stClass}">${stLabel}</span>
  </div>`;
}
