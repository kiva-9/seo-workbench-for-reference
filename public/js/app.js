// app.js —— 应用入口：hash 路由 + 侧边栏交互
import './ui.js'; // 触发 ui 工具挂载到全局
import { API } from './api.js';
import {renderAiModelSettings} from './pages/ai-model-settings.js';
import {renderAiInsights} from './pages/ai-insights.js';
import { renderTaskManagement, renderTaskManagementLoading, isTaskManagementRoute } from './pages/task-management.js';
import { renderProjects } from './pages/projects.js';
import {renderProjectCandidates} from './pages/project-candidates.js';
import { renderProjectHome } from './pages/projecthome.js';
import { renderArticleMonitor, confirmDiscardDrafts, monitorLocation } from './pages/article-monitor.js';
import { renderLinks } from './pages/links.js';
import { renderAccounts } from './pages/accounts.js';
import { renderSettings } from './pages/settings.js';
import { renderMcp } from './pages/mcp.js';
import { renderBackgroundTasks } from './pages/background-tasks.js';
import { renderPageLoading, renderPageError } from './components/page-loading.js';
import { initThemeControls } from './components/theme-controls.js';
import { initCurrentAccount, renderCurrentAccount } from './components/current-account.js';

const routes = {
  'background-tasks': { title: '后台任务', render: renderBackgroundTasks },
  'ai-settings': {title:'AI 功能配置',render:renderAiModelSettings},
  'ai-model-settings': {title:'AI 功能配置',render:renderAiModelSettings},
  'ai-insights': { title: 'AI 见解', render: renderAiInsights },
  'task-management': { title: '任务管理', render: renderTaskManagement },
  dashboard: { title: '任务管理', render: renderTaskManagement },
  projects: { title: '项目管理', render: renderProjects },
  'project-candidates':{title:'项目候选',render:renderProjectCandidates},
  project: { title: '项目文章管理', render: renderProjectHome },
  'article-monitor': { title: '文章监控', render: renderArticleMonitor },
  board: { title: '任务管理', render: renderTaskManagement },
  calendar: { title: '任务管理', render: renderTaskManagement },
  docs: { title: '链接库', render: renderLinks },
  accounts: { title: '谷歌账号', render: renderAccounts },
  mcp: { title: 'MCP', render: renderMcp },
  settings: { title: '设置', render: renderSettings },
};

// 旧入口跳转（任务14）：数据抓取/绩效看板/外文数据已合并进文章监控，旧 hash 重定向
const LEGACY_REDIRECT = ['analytics', 'history', 'external'];

let routeRevision = 0;
async function route() {
  const revision = ++routeRevision;
  // 在替换页面前统一保护监控草稿，侧栏、深链和浏览器返回遵循同一规则。
  if (document.body.dataset.page === 'article-monitor' && $('.article-monitor-page')) {
    const returnHash = monitorLocation();
    const canLeave = await confirmDiscardDrafts();
    if (revision !== routeRevision) return;
    if (!canLeave) { history.replaceState(history.state, '', returnHash); return; }
  }
  // 旧页面即将被替换：通知当前页清理资源（图表实例等），避免它们对已分离的 DOM 重绘报错
  window.dispatchEvent(new Event('seo-route-change'));
  const rawHash = location.hash.replace(/^#\//, '');
  const legacyName = rawHash.split('/')[0].split('?')[0];
  if (LEGACY_REDIRECT.includes(legacyName)) {
    const params = new URLSearchParams(rawHash.split('?')[1] || '');
    location.replace(params.get('project') ? '#/article-monitor?project=' + params.get('project') : '#/article-monitor');
    return;
  }
  const hash = rawHash || 'task-management';
  const requestedName = hash.split('/')[0].split('?')[0];
  const name = routes[requestedName] ? requestedName : 'task-management';
  const r = routes[name];
  document.body.dataset.page = name;
  document.body.classList.toggle('article-ui', ['project', 'article-monitor', 'settings', 'mcp', 'ai-insights', 'ai-settings', 'ai-model-settings', 'background-tasks'].includes(name));
  $('#page-title').textContent = r.title;
  const navRoute = isTaskManagementRoute(name) ? 'task-management' : name === 'project' ? 'projects' : name === 'ai-model-settings' ? 'ai-settings' : name;
  $$('.nav-item').forEach((a) => {
    const active = a.dataset.route === navRoute;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#sidebar').classList.remove('open');
  closeModal(); // 换页时关掉可能还开着的弹窗
  const previousView = $('#view');
  const retainCandidates=name==='project-candidates'&&previousView.querySelector('.candidate-toolbar');
  const aiParams=new URLSearchParams(rawHash.split('?')[1]||'');
  const retainAi=name==='ai-insights'&&!aiParams.has('insight')&&previousView._aiView?.pid===(Number(aiParams.get('project'))||null);
  const retain=retainCandidates||retainAi;
  const view = retain?previousView:previousView.cloneNode(false);
  if(!retain){previousView.replaceWith(view);isTaskManagementRoute(name)?renderTaskManagementLoading(view):renderPageLoading(view,name);}
  try {
    await currentUserReady;
    if (revision !== routeRevision || !view.isConnected) return;
    await r.render(view);
  } catch (e) {
    if (revision !== routeRevision || !view.isConnected) return;
    // 没有这层兜底的话，任何接口报错都会让页面永远停在转圈上
    console.error('[页面渲染失败]', e);
    renderPageError(view, e, route);
  }
}

initThemeControls();
initCurrentAccount({ onLogout: () => API.forgetIdentity(), beforeLogout: async () => {
  if (document.body.dataset.page === 'article-monitor' && $('.article-monitor-page')) return confirmDiscardDrafts();
  return true;
} });

window.addEventListener('hashchange', route);
$('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');
$('#sidebar-collapse').onclick = () => {
  const collapsed = document.body.classList.toggle('sidebar-compact');
  const button = $('#sidebar-collapse');
  button.textContent = collapsed ? '›' : '‹';
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', collapsed ? '展开菜单栏' : '折叠菜单栏');
  button.title = collapsed ? '展开菜单栏' : '折叠菜单栏';
};
$$('.nav-item').forEach((a) => {
  a.title = a.textContent.trim();
  // 用户准备进入页面时才预读，多个入口共享进行中的请求。
  a.addEventListener('pointerenter',()=>prefetchRoute(a.dataset.route));
  a.addEventListener('focus',()=>prefetchRoute(a.dataset.route));
});
function prefetchRoute(name) {
  if(!window.currentUser)return;
  const requests=name==='project-candidates'?[API.projectCandidates({status:'pending',q:'',page:1,page_size:30})]:
    isTaskManagementRoute(name)?[API.projects(),API.tasks()]:
    name==='projects'?[API.projects()]:name==='article-monitor'?[API.articleMonitorOptions()]:[];
  Promise.allSettled(requests);
}

// 供任意页面在「增删改后想留在当前页刷新」时调用（替代硬编码 renderBoard/某个具体页的 render）：
// 任务弹窗等共享组件保存后按当前 hash 重新渲染，而不是把它切到某一个固定视图。
window.refreshView = route;

// 当前用户：启动时拉一次，挂到全局给各页面判断 isAdmin 用
// （projects.js 的转让/协作者入口、settings.js 的账号管理都要看这个）。
// 登录身份与退出入口由共享组件维护，设置中修改自己的显示名也能同步更新。
window.currentUser = null;
let identityCheckedAt=0;
async function loadCurrentUser(bootstrap=false) {
  try {
    window.currentUser = await API.me({bootstrap});
    renderCurrentAccount(window.currentUser);
  } catch (e) {
    window.currentUser=null;
    renderCurrentAccount(null, { deleted: e.code === 'ACCOUNT_DELETED', logoutUrl: e.logout_url });
    console.error('[获取当前用户失败]', e);
  }
  document.querySelectorAll('[data-admin-only]').forEach(node=>{node.hidden=window.currentUser?.role!=='admin';});
  identityCheckedAt=Date.now();
}
let currentUserReady=loadCurrentUser(true);
function resumeReads() {
  if(document.visibilityState!=='visible'||Date.now()-identityCheckedAt<30_000)return;
  identityCheckedAt=Date.now();
  API.invalidateReads();
  currentUserReady=loadCurrentUser();
}
window.addEventListener('focus',resumeReads);
document.addEventListener('visibilitychange',resumeReads);

route();
