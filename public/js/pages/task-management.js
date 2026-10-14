import { renderDashboard } from './dashboard.js';
import { renderBoard } from './board.js';
import { renderCalendar } from './calendar.js';
import { renderPageLoading, renderPageError } from '../components/page-loading.js';
import { beginPageRender } from '../page-lifecycle.js';

export const TASK_VIEWS = [
  { id: 'dashboard', label: '总览', render: renderDashboard },
  { id: 'board', label: '看板', render: renderBoard },
  { id: 'calendar', label: '日历', render: renderCalendar },
];
let focusAfterSwitch = null;

export function isTaskManagementRoute(name) {
  return name === 'task-management' || TASK_VIEWS.some(view => view.id === name);
}

export function taskViewFromHash(hash = location.hash) {
  const raw = hash.replace(/^#\//, '');
  const name = raw.split('?')[0].split('/')[0];
  if (TASK_VIEWS.some(view => view.id === name)) return name;
  const requested = new URLSearchParams(raw.split('?')[1] || '').get('view');
  return TASK_VIEWS.some(view => view.id === requested) ? requested : 'dashboard';
}

export function taskViewHash(view, hash = location.hash) {
  const params = new URLSearchParams(hash.split('?')[1] || '');
  params.set('view', TASK_VIEWS.some(item => item.id === view) ? view : 'dashboard');
  return '#/task-management?' + params.toString();
}

export function taskViewForKey(view, key) {
  const index = Math.max(0, TASK_VIEWS.findIndex(item => item.id === view));
  if (key === 'Home') return TASK_VIEWS[0].id;
  if (key === 'End') return TASK_VIEWS.at(-1).id;
  if (key === 'ArrowRight') return TASK_VIEWS[(index + 1) % TASK_VIEWS.length].id;
  if (key === 'ArrowLeft') return TASK_VIEWS[(index + TASK_VIEWS.length - 1) % TASK_VIEWS.length].id;
  return null;
}

export function renderTaskManagementLoading(el) {
  const view = taskViewFromHash();
  el.innerHTML = `<div class="task-management">
    <div class="task-view-tabs" role="tablist" aria-label="任务管理视图">
      ${TASK_VIEWS.map(item => `<button type="button" class="task-view-tab" id="task-tab-${item.id}"
        role="tab" data-task-view="${item.id}" aria-controls="task-view-panel"
        aria-selected="${item.id === view}" tabindex="${item.id === view ? 0 : -1}">${item.label}</button>`).join('')}
    </div>
    <section class="task-view-panel" id="task-view-panel" role="tabpanel" aria-labelledby="task-tab-${view}"
      tabindex="0" aria-busy="true"></section>
  </div>`;
  const panel = el.querySelector('#task-view-panel');
  const tabs = [...el.querySelectorAll('[data-task-view]')];
  const activate = next => {
    if (next === view) return;
    focusAfterSwitch = next;
    location.hash = taskViewHash(next);
  };
  for (const tab of tabs) {
    tab.onclick = () => activate(tab.dataset.taskView);
    tab.onkeydown = event => {
      const next = taskViewForKey(tab.dataset.taskView, event.key);
      if (!next) return;
      event.preventDefault();
      if (next === view) tab.focus({ preventScroll: true });
      else activate(next);
    };
  }
  // hash 切换会替换页面 DOM，焦点随选中的 tab 回到新容器。
  if (focusAfterSwitch === view) {
    tabs.find(tab => tab.dataset.taskView === view)?.focus({ preventScroll: true });
    focusAfterSwitch = null;
  }
  renderPageLoading(panel, view);
  el._taskManagement = { view, panel };
}

export async function renderTaskManagement(el) {
  const isCurrent = beginPageRender(el);
  const view = taskViewFromHash();
  if (el._taskManagement?.view !== view || !el._taskManagement.panel.isConnected) renderTaskManagementLoading(el);
  const { panel } = el._taskManagement;
  renderPageLoading(panel, view);
  panel.setAttribute('aria-busy', 'true');
  try {
    await TASK_VIEWS.find(item => item.id === view).render(panel);
  } catch (error) {
    if (isCurrent() && panel.isConnected) renderPageError(panel, error, () => renderTaskManagement(el));
  } finally {
    if (isCurrent() && panel.isConnected) panel.setAttribute('aria-busy', 'false');
  }
}
