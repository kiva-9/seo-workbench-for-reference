// article-monitor.js —— 站内文章与站外平台监控
// 口径：先限制可访问项目 → 过滤 → 稳定排序 → 分页；summary 全量非当页。
// 达标规则在服务端（src/lib/attainment.js），前端只展示与筛选。
// 便捷编辑（文案师/发布日期）走草稿：按 项目+文章 保存，明确批量保存；
// 保存失败时保留草稿，方便重试。
import { API } from '../api.js';
import { beginPageRender, capturePageContext } from '../page-lifecycle.js';
import { loadingRows, loadingStats } from '../components/page-loading.js';
import { bindRowMenus, bindSearchInput, nextMonitorSort, monitorSortFromLocation, externalSortFromLocation, EXTERNAL_SORT_OPTIONS } from '../components/monitor-controls.js';
import { monthlyOverviewRows } from '../components/monitor-details.js';
import { buildWorkspaceHash } from './project-article-workspace-route.js';
import { createProjectSync, projectSyncButton } from '../components/project-sync.js';

let viewEl = null;
let listRequest = 0;
let extRequest = 0;
let draftConfirmation = null;
let projectSync = null;
const state = {
  filters: { projectId: '', status: '', copywriterUserId: '', attainment: '', sync: '', q: '', sort: 'created_at', dir: 'asc', missingPublishedAt: false, unassigned: false },
  page: 1,
  pageSize: 50,
  total: 0,
  summary: null,
  projects: [],
  optionsReady: false,
  rosters: new Map(),
  showTitles: localStorage.getItem('amShowTitles') === '1', // 显示标题 = 本机显示偏好
  rows: [],
  expanded: new Set(),
  detailCache: new Map(),
  detailRevisions: new Map(),
  detailLoads: new Map(),
  drafts: new Map(),   // articleId -> { projectId, ...实际变化的字段 }
  savingDrafts: null,
  loading: false,
  syncing: new Set(),
  titling: new Set(),
  tab: 'internal',
  ext: { sort: 'project_name', dir: 'asc', q: '', domain: '', status: '', sync: '', missingPublishedAt: false, unassigned: false, copywriterUserId: '', projectId: '', page: 1, pageSize: 50, total: 0, rows: [], summary: null, expanded: new Set(), detailCache: new Map() },
};

function setupProjectSync(isCurrent) {
  projectSync?.stop();
  const sync = createProjectSync({ api: API, visible: () => !document.hidden, change: () => { if (isCurrent()) renderProjectSync(); },
    timer: setTimeout, cancelTimer: clearTimeout, complete: async (pid, job) => {
      if (!isCurrent() || state.tab !== 'internal' || state.filters.projectId !== pid) return;
      if (job.status === 'succeeded') toast('项目同步已完成', 'ok');
      else if (job.status === 'partial') toast('部分同步未完成，已保留成功结果和剩余范围，请在后台任务中核查原因');
      else toast('项目同步失败，可在后台任务中查看原因并重新提交', 'err');
      invalidateDetails();
      if (!state.drafts.size) await loadList(); else renderTable();
    } });
  projectSync = sync;
  window.addEventListener('seo-route-change', () => sync.stop(), { once: true });
}

export async function renderArticleMonitor(el) {
  const isCurrent = beginPageRender(el);
  setupProjectSync(isCurrent);
  listRequest++; extRequest++;
  viewEl = el;
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  state.tab = q.get('tab') === 'external' ? 'external' : 'internal';
  const readFilters = (prefix = '') => ({
    projectId: q.get(prefix + 'project') || '', status: q.get(prefix + 'status') || '',
    copywriterUserId: q.get(prefix + 'writer') || '', attainment: q.get(prefix + 'attainment') || '',
    sync: q.get(prefix + 'sync') || '', q: q.get(prefix + 'q') || '',
    missingPublishedAt: q.get(prefix + 'missing') === '1', unassigned: q.get(prefix + 'unassigned') === '1',
  });
  state.filters = { ...readFilters(), ...monitorSortFromLocation(q.get('sort'), q.get('dir')) };
  state.ext = { ...state.ext, ...readFilters('ext_'), domain: q.get('ext_domain') || '',
    ...externalSortFromLocation(q.get('ext_sort')),
    page: Math.max(1, Number(q.get('ext_page')) || 1), pageSize: pageSize(q.get('ext_size')),
    expanded: new Set(), detailCache: new Map(), rows: [], summary: null };
  state.expanded = new Set();
  state.detailCache = new Map();
  state.detailRevisions = new Map();
  state.detailLoads = new Map();
  state.drafts = new Map();
  state.savingDrafts = null;
  state.syncing = new Set(); state.titling = new Set();
  state.page = Math.max(1, Number(q.get('page')) || 1);
  state.pageSize = pageSize(q.get('size'));
  state.rosters = new Map();
  state.projects = []; state.rows = []; state.summary = null; state.total = 0;
  state.optionsReady = false;
  renderShell(el);
  // 名单与指标互不依赖，同时请求，慢名单不阻挡文章和统计展示。
  await Promise.all([loadCopywriterOptions(isCurrent), state.tab === 'external' ? loadExtMonitor() : loadList(), projectSync.restore(state.filters.projectId)]);
}

function pageSize(value) { return [25, 50, 100].includes(Number(value)) ? Number(value) : 50; }

// 名单 id 用于指派，账号 user_id 用于跨项目筛选，二者不能混用。
async function loadCopywriterOptions(isCurrent = () => viewEl?.isConnected) {
  if (state.optionsReady) return;
  const element = viewEl;
  try {
    const data = await API.articleMonitorOptions();
    if (!isCurrent() || element !== viewEl) return;
    state.projects = data.projects;
    state.rosters = new Map(data.projects.map(p => [String(p.id), []]));
    for (const c of data.copywriters) state.rosters.get(String(c.project_id))?.push(c);
    state.optionsReady = true;
    let changed = false;
    for (const filters of [state.filters, state.ext]) {
      const before = [filters.projectId, filters.copywriterUserId].join(':');
      if (filters.projectId && !state.projects.some(p => String(p.id) === filters.projectId)) filters.projectId = '';
      const rosters = filters.projectId ? [state.rosters.get(filters.projectId) || []] : [...state.rosters.values()];
      if (filters.copywriterUserId && !rosters.flat().some(c => String(c.user_id) === filters.copywriterUserId)) filters.copywriterUserId = '';
      changed ||= before !== [filters.projectId, filters.copywriterUserId].join(':');
    }
    refreshMonitorOptions();
    // 只补齐名单单元格，避免覆盖已输入的发布日期、草稿和展开明细。
    for (const row of state.rows) {
      const tr = element.querySelector(`#am-table tr[data-id="${row.id}"]`);
      if (!tr) continue;
      tr.querySelector('.am-project-name').textContent = state.projects.find(p => Number(p.id) === Number(row.project_id))?.name || '#' + row.project_id;
      tr.querySelector('.am-writer-cell').innerHTML = writerCell(row);
    }
    // 已有行的其它事件保持不动，只绑定新补入的选择器。
    element.querySelectorAll('.am-cw').forEach(sel => {
      sel.onchange = () => setDraft(Number(sel.dataset.id), { copywriter_id: sel.value ? Number(sel.value) : null });
    });
    element.querySelector('#am-options-status').hidden = true;
    if (changed) await (state.tab === 'external' ? loadExtMonitor() : loadList());
  } catch (e) {
    logMonitorError('读取筛选选项', e);
    if (!isCurrent() || element !== viewEl) return;
    const status = element.querySelector('#am-options-status');
    status.hidden = false;
    status.innerHTML = `筛选选项暂不可用。 <button class="btn btn-sm" id="am-options-retry">重试</button>`;
    status.querySelector('button').onclick = () => loadCopywriterOptions(isCurrent);
  }
}

function refreshMonitorOptions() {
  for (const [prefix, filters] of [['am', state.filters], ['am-ext', state.ext]]) {
    const project = $('#' + prefix + '-project');
    project.innerHTML = '<option value="">全部项目</option>' + state.projects.map(p => `<option value="${p.id}" ${String(p.id) === filters.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    project.disabled = !state.optionsReady;
    const writer = $('#' + prefix + '-cw');
    writer.innerHTML = writerOptions(filters.projectId, filters.copywriterUserId);
    writer.disabled = !state.optionsReady;
  }
  $('#am-sync-project').disabled = !state.optionsReady;
  updateContext();
}

function writerOptions(pid, selected) {
  const writers = new Map();
  for (const [projectId, roster] of state.rosters) {
    if (pid && String(pid) !== projectId) continue;
    for (const c of roster) writers.set(String(c.user_id), c);
  }
  return '<option value="">全部文案师</option>' + [...writers.values()].map((c) =>
    `<option value="${c.user_id}" ${String(c.user_id) === String(selected) ? 'selected' : ''}>${esc(c.name || c.email)}</option>`).join('');
}

export function monitorLocation() {
  const params = new URLSearchParams();
  const add = (f, prefix = '') => {
    for (const [key, value] of Object.entries({ project: f.projectId, status: f.status, writer: f.copywriterUserId,
      attainment: f.attainment, sync: f.sync, q: f.q, missing: f.missingPublishedAt ? '1' : '',
      unassigned: f.unassigned ? '1' : '', sort: f.sort, dir: f.dir })) {
      if (value) params.set(prefix + key, value);
    }
  };
  add(state.filters); add(state.ext, 'ext_');
  params.set('tab', state.tab); params.set('page', String(state.page)); params.set('size', String(state.pageSize));
  params.set('ext_page', String(state.ext.page)); params.set('ext_size', String(state.ext.pageSize));
  if (state.ext.domain) params.set('ext_domain', state.ext.domain);
  return '#/article-monitor?' + params.toString();
}

function updateContext() {
  if (!viewEl?.querySelector('.article-monitor-page') || !location.hash.startsWith('#/article-monitor')) return;
  history.replaceState(history.state, '', monitorLocation());
  const link = $('#am-manage');
  if (link) link.href = buildWorkspaceHash({ projectId: state.tab === 'internal' ? state.filters.projectId : state.ext.projectId,
    section: state.tab, returnLocation: monitorLocation() });
}

function renderShell(el) {
  const f = state.filters;
  const x = state.ext;
  const projectOptions = (pid) => '<option value="">全部项目</option>' + state.projects.map((p) =>
    `<option value="${p.id}" ${String(p.id) === String(pid) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const choices = (items, selected) => items.map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
  const field = (label, html, cls = '') => `<label class="am-field ${cls}"><span>${label}</span>${html}</label>`;
  const sizes = (size) => [25, 50, 100].map((n) => `<option value="${n}" ${size === n ? 'selected' : ''}>${n} 条</option>`).join('');
  const check = (id, label, checked) => `<label class="am-check"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>${label}</label>`;
  el.innerHTML = `<section class="article-monitor-page">
    <nav class="am-tabs" role="tablist" aria-label="文章类型">
      <button class="am-tab" role="tab" data-tab="internal">站内文章</button><button class="am-tab" role="tab" data-tab="external">站外外链</button>
    </nav>
    <div class="am-platform-note am-external-only">站外数据按平台来源统计，同一平台多篇共享；文章明细按参考区间分摊，仅供参考。<span id="am-ext-data-status"></span></div>
    <header class="page-head">
      <div><h2 id="am-heading">文章监控</h2>
        <p class="page-desc am-internal-only">按项目持续跟踪站内文章的 GSC 点击、GA4 浏览与页面内关键事件表现。</p>
        <p class="page-desc am-external-only">按项目查看外链平台的来源表现，展开平台可查看文章参考明细。</p>
      </div>
      <div class="page-actions"><span class="am-period am-internal-only">累计含本月临时数据 · 各来源截至日见明细</span>
        <div class="am-external-only">${field('项目', `<select id="am-ext-project">${projectOptions(x.projectId)}</select>`)}</div>
        <a class="btn" id="am-manage">管理文章</a>
        <button class="btn am-internal-only" id="am-export">导出当前筛选</button>
        <button class="btn am-external-only" id="am-ext-export">导出当前筛选</button><button class="btn am-external-only" id="am-ext-reload">刷新列表</button><button class="btn btn-primary am-internal-only" id="am-sync-project" ${f.projectId ? '' : 'hidden'}>同步当前项目</button></div>
    </header>
    <div id="am-options-status" class="muted" role="status" hidden></div>
    <div id="am-project-sync-status" class="muted am-internal-only" role="status" hidden></div>
    <div id="am-summary" class="am-internal-only"><div class="am-summary"><div class="am-summary-group"><h3>转化效果</h3><div class="am-summary-grid">${loadingStats(['筛选文章', '达标率', '总转化率', '已达标'])}</div></div><div class="am-summary-group"><h3>跟进项</h3><div class="am-summary-grid">${loadingStats(['待观察', '待配置关键事件', '待补发布日期', '数据异常'])}</div></div></div></div>
    <div id="am-ext-summary" class="am-external-only"><div class="am-summary-grid">${loadingStats(['匹配平台', '登记文章', '累计用户', '累计关键事件'])}</div></div>
    <div id="am-draftbar" class="am-draftbar" style="display:none"><span id="am-draft-count"></span>
      <button class="btn btn-sm btn-primary" id="am-draft-save">保存修改</button><button class="btn btn-sm" id="am-draft-discard">放弃修改</button></div>
    <section class="am-data-card am-internal-only" aria-label="站内文章数据">
      <div class="am-toolbar">
        <div class="am-toolbar-filters">
          ${field('搜索文章', `<input type="search" id="am-q" placeholder="搜索标题、URL、关键词、项目或文案师…" value="${esc(f.q)}">`, 'am-search')}
          <label class="am-title-toggle">显示标题<input id="am-show-titles" type="checkbox" role="switch" ${state.showTitles ? 'checked' : ''}></label>
          ${field('项目', `<select id="am-project">${projectOptions(f.projectId)}</select>`)}
          ${field('文案师', `<select id="am-cw">${writerOptions(f.projectId, f.copywriterUserId)}</select>`)}
          ${field('达标状态', `<select id="am-attainment">${choices([['', '全部达标状态'], ['attained', '已达标'], ['not-attained', '未达标'], ['pending-key-events', '待配置关键事件'], ['data-issue', '数据异常'], ['syncing', '同步中'], ['observation', '观察期'], ['pending', '待判断']], f.attainment)}</select>`)}
          ${field('同步状态', `<select id="am-sync">${choices([['', '全部'], ['ok', '已同步'], ['dirty', '待刷新'], ['error', '抓取失败']], f.sync)}</select>`, 'am-labeled')}
          <details class="am-more-filters">
            <summary>更多筛选 <span id="am-more-count" class="am-filter-count" hidden></span></summary>
            <div class="am-more-panel">
              <div class="am-more-heading">补充筛选</div>
              ${check('am-missing-date', '缺发布日期', f.missingPublishedAt)}
              ${check('am-unassigned', '未指派', f.unassigned)}
              <label class="am-inline-field">文章状态<select id="am-status">${choices([['', '在册'], ['inactive', '已停用']], f.status)}</select></label>
            </div>
          </details>
        </div>
        <div class="am-toolbar-end">
          ${field('每页', `<select id="am-page-size">${sizes(state.pageSize)}</select>`, 'am-size')}
          <div class="am-top-pager"><span>翻页</span><nav id="am-pager-top" aria-label="站内顶部翻页"></nav></div>
        </div>
      </div>
      <div class="am-active-filters" id="am-active-filters" hidden><span>已启用：</span><span id="am-active-filter-labels"></span><button id="am-clear-extra">清除补充筛选</button></div>
      <div id="am-load-status" class="am-load-status" role="status" hidden></div>
      <div id="am-table">${loadingRows(['文章 URL', '项目', '文案师', '发布日期', '累计点击', '累计浏览'])}</div>
      <footer id="am-pager" class="am-pager"></footer>
    </section>
    <section class="am-data-card am-external-only" aria-label="站外平台数据">
      <div class="am-toolbar am-external-toolbar">
        <div class="am-toolbar-filters">
          ${field('搜索文章 / 平台', `<input type="search" id="am-ext-q" placeholder="搜索 URL、标题、项目、平台或文案师…" value="${esc(x.q)}">`, 'am-search')}
          ${field('文案师', `<select id="am-ext-cw">${writerOptions(x.projectId, x.copywriterUserId)}</select>`)}
          ${field('平台', `<select id="am-ext-domain"><option value="">全部平台</option>${x.domain ? `<option value="${esc(x.domain)}" selected>${esc(x.domain)}</option>` : ''}</select>`)}
          ${field('文章状态', `<select id="am-ext-status">${choices([['', '全部'], ['active', '启用'], ['inactive', '已停用']], x.status)}</select>`)}
          ${field('同步状态', `<select id="am-ext-sync">${choices([['', '全部'], ['ok', '完整'], ['issue', '同步异常'], ['pending', '待同步'], ['unconfigured', '未配置项目']], x.sync)}</select>`)}
          ${field('排序', `<select id="am-ext-sort">${choices(EXTERNAL_SORT_OPTIONS, x.sort)}</select>`)}
          ${check('am-ext-missing-date', '待补日期', x.missingPublishedAt)}
          ${check('am-ext-unassigned', '未指派', x.unassigned)}
        </div>
        <div class="am-toolbar-end">
          ${field('每页', `<select id="am-ext-page-size">${sizes(x.pageSize)}</select>`, 'am-size')}
          <div class="am-top-pager"><span>翻页</span><nav id="am-ext-pager-top" aria-label="站外顶部翻页"></nav></div>
        </div>
      </div>
      <div id="am-ext-scope-note" class="am-scope-note" hidden></div>
      <div id="am-ext-load-status" class="am-load-status" role="status" hidden></div>
      <div id="am-ext-table">${loadingRows(['项目', '平台', '登记文章', '累计用户'])}</div>
      <footer id="am-ext-pager" class="am-pager"></footer>
    </section></section>`;

  const bind = (id, event, fn) => $('#' + id)?.addEventListener(event, fn);
  const onFilter = (fn) => async (e) => {
    const discard = await confirmDiscardDrafts();
    if (!e.target.isConnected) return;
    if (!discard) { renderShell(viewEl); renderSummary(); renderTable(); renderPager(); return; }
    await fn(e);
    if (!e.target.isConnected) return;
    state.page = 1; state.expanded.clear(); await loadList();
  };
  const onExternal = (fn) => async (e) => { if (!e.target.isConnected) return; await fn(e); state.ext.page = 1; await loadExtMonitor(); };
  $$('.am-tab').forEach((button) => { button.onclick = async () => {
    if (state.tab === button.dataset.tab) return;
    if (!(await confirmDiscardDrafts())) return;
    state.tab = button.dataset.tab; applyTab(); updateContext();
    if (state.tab === 'external') await loadExtMonitor(); else { projectSync.restore(state.filters.projectId); await loadList(); }
  }; });
  $('.am-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$('.am-tab');
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[1] : tabs.find(tab => tab !== event.target);
    next?.focus(); next?.click();
  });
  bind('am-project', 'change', onFilter(async (e) => {
    state.filters.projectId = e.target.value; state.filters.copywriterUserId = '';
    renderProjectSync(); projectSync.restore(state.filters.projectId);
    await loadCopywriterOptions();
    if (!e.target.isConnected) return;
    $('#am-cw').innerHTML = writerOptions(state.filters.projectId, '');
    $('#am-sync-project').hidden = !state.filters.projectId;
  }));
  for (const [id, key] of [['cw', 'copywriterUserId'], ['status', 'status'], ['attainment', 'attainment'], ['sync', 'sync']])
    bind('am-' + id, 'change', onFilter((e) => { state.filters[key] = e.target.value; }));
  bindSearchInput($('#am-q'), onFilter((e) => { state.filters.q = e.target.value; }));
  bind('am-missing-date', 'change', onFilter((e) => { state.filters.missingPublishedAt = e.target.checked; }));
  bind('am-unassigned', 'change', onFilter((e) => { state.filters.unassigned = e.target.checked; }));
  bind('am-page-size', 'change', onFilter((e) => { state.pageSize = pageSize(e.target.value); }));
  bind('am-show-titles', 'change', (e) => { state.showTitles = e.target.checked; localStorage.setItem('amShowTitles', state.showTitles ? '1' : '0'); renderTitleDisplay(); });
  bind('am-sync-project', 'click', syncProject); bind('am-export', 'click', exportData);
  bind('am-clear-extra', 'click', onFilter(() => {
    state.filters.missingPublishedAt = false; state.filters.unassigned = false; state.filters.status = '';
    $('#am-missing-date').checked = false; $('#am-unassigned').checked = false; $('#am-status').value = '';
  }));
  bind('am-draft-save', 'click', saveDrafts);
  bind('am-draft-discard', 'click', () => { if (state.savingDrafts) return; state.drafts.clear(); renderDraftBar(); renderTable(); });
  bind('am-ext-project', 'change', onExternal((e) => {
    state.ext.projectId = e.target.value; state.ext.copywriterUserId = '';
    $('#am-ext-cw').innerHTML = writerOptions(state.ext.projectId, '');
  }));
  for (const [id, key] of [['cw', 'copywriterUserId'], ['status', 'status'], ['sync', 'sync']])
    bind('am-ext-' + id, 'change', onExternal((e) => { state.ext[key] = e.target.value; }));
  bindSearchInput($('#am-ext-q'), onExternal((e) => { state.ext.q = e.target.value; }));
  bind('am-ext-domain', 'change', onExternal((e) => { state.ext.domain = e.target.value; }));
  bind('am-ext-sort', 'change', onExternal((e) => { Object.assign(state.ext, externalSortFromLocation(e.target.value)); }));
  bind('am-ext-missing-date', 'change', onExternal((e) => { state.ext.missingPublishedAt = e.target.checked; }));
  bind('am-ext-unassigned', 'change', onExternal((e) => { state.ext.unassigned = e.target.checked; }));
  bind('am-ext-page-size', 'change', onExternal((e) => { state.ext.pageSize = pageSize(e.target.value); }));
  bind('am-ext-reload', 'click', loadExtMonitor);
  bind('am-ext-export', 'click', () => {
    if (!state.ext.total) return toast('当前筛选没有匹配的平台', 'err');
    window.open('/api/article-monitor/external/export.xlsx?' + externalParams(false).toString());
  });
  $('#am-manage').onclick = leaveMonitor;
  refreshMonitorOptions(); applyTab(); updateContext(); renderMoreFiltersStatus();
}

function renderMoreFiltersStatus() {
  const labels = [];
  if (state.filters.missingPublishedAt) labels.push('缺发布日期');
  if (state.filters.unassigned) labels.push('未指派');
  if (state.filters.status === 'inactive') labels.push('已停用');
  const count = $('#am-more-count');
  if (count) { count.textContent = String(labels.length); count.hidden = labels.length === 0; }
  const banner = $('#am-active-filters');
  if (banner) { banner.hidden = labels.length === 0; $('#am-active-filter-labels').textContent = labels.join(' · '); }
  const ext = state.ext;
  const extCount = [ext.missingPublishedAt, ext.unassigned, Boolean(ext.status), Boolean(ext.domain.trim())].filter(Boolean).length;
  const extBadge = $('#am-ext-more-count');
  if (extBadge) { extBadge.textContent = String(extCount); extBadge.hidden = extCount === 0; }
}

async function leaveMonitor(event) {
  if ((!state.drafts.size && !state.savingDrafts) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const destination = event.currentTarget.getAttribute('href');
  if (await confirmDiscardDrafts()) location.hash = destination;
}

function applyTab() {
  $$('.am-tab').forEach((button) => { const on = button.dataset.tab === state.tab; button.classList.toggle('is-active', on); button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1; });
  $$('.am-internal-only').forEach((node) => { node.hidden = state.tab !== 'internal'; });
  $$('.am-external-only').forEach((node) => { node.hidden = state.tab !== 'external'; });
  $('#am-heading').textContent = state.tab === 'internal' ? '文章监控' : '站外外链监控';
  $('#am-manage').textContent = state.tab === 'internal' ? '管理文章' : '登记 / 管理外链';
  $('#am-sync-project').hidden = state.tab !== 'internal' || !state.filters.projectId;
  renderProjectSync();
  renderDraftBar();
}

// 有未保存草稿时确认放弃；没有草稿直接放行
export function confirmDiscardDrafts() {
  if (state.savingDrafts) { toast('正在保存修改，请完成后再切换或放弃', 'err'); return Promise.resolve(false); }
  if (!state.drafts.size) return Promise.resolve(true);
  if (draftConfirmation) return draftConfirmation;
  draftConfirmation = new Promise((resolve) => {
    openModal(`<div class="modal-head"><h3>放弃未保存的修改</h3></div>
      <p>有 ${state.drafts.size} 篇文章的编辑还没保存。放弃并继续吗？</p>
      <div class="form-actions"><button class="btn" id="am-keep-drafts">继续编辑</button>
      <button class="btn btn-danger" id="am-discard-drafts">放弃修改</button></div>`);
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; observer.disconnect(); closeModal(); if (ok) state.drafts.clear(); renderDraftBar(); resolve(ok); };
    const mask = $('#modal-mask');
    const observer = new MutationObserver(() => { if (mask.classList.contains('hidden')) done(false); });
    observer.observe(mask, { attributes: true, attributeFilter: ['class'] });
    $('#am-keep-drafts').onclick = () => done(false);
    $('#am-discard-drafts').onclick = () => done(true);
    mask.onclick = (event) => { if (event.target === mask) done(false); };
  });
  draftConfirmation.finally(() => { draftConfirmation = null; });
  return draftConfirmation;
}

// ============ 数据 ============
async function loadList() {
  const request = ++listRequest;
  const box = $('#am-table');
  if (!box) return;
  state.loading = true;
  const status = $('#am-load-status'); status.hidden = false; status.textContent = '正在读取当前筛选结果…';
  updateContext();
  renderMoreFiltersStatus();
  $('#am-table')?.setAttribute('aria-busy', 'true');
  const f = state.filters;
  const params = new URLSearchParams({ page: String(state.page), page_size: String(state.pageSize) });
  if (f.projectId) params.set('project_id', f.projectId);
  if (f.status) params.set('status', f.status);
  if (f.copywriterUserId) params.set('copywriter_user_id', f.copywriterUserId);
  if (f.missingPublishedAt) params.set('missing_published_at', '1');
  if (f.unassigned) params.set('unassigned', '1');
  if (f.attainment) params.set('attainment', f.attainment);
  if (f.sync) params.set('sync', f.sync);
  if (f.q.trim()) params.set('query', f.q.trim());
  params.set('sort', f.sort);
  params.set('dir', f.dir);
  try {
    const data = await API.articleMonitorList(params);
    if (request !== listRequest || !box.isConnected) return;
    const pages = Math.max(1, Math.ceil(data.total / state.pageSize));
    if (state.page > pages) { state.page = pages; return loadList(); }
    state.rows = data.rows;
    state.total = data.total;
    state.summary = data.summary;
    renderSummary();
    renderTable();
    renderPager();
  } catch (e) {
    logMonitorError('读取文章列表', e);
    if (request === listRequest && box.isConnected) {
      box.innerHTML = `<div class="empty">当前数据暂不可用。<br><button class="btn btn-sm" id="am-retry">重试</button></div>`;
      if (!state.summary) $('#am-summary').innerHTML = '<p class="muted">统计暂不可用，重试列表后更新。</p>';
      $('#am-retry').onclick = loadList;
    }
  } finally {
    if (request === listRequest) { status.hidden = true; state.loading = false; $('#am-table')?.removeAttribute('aria-busy'); }
  }
}

function renderSummary() {
  const s = state.summary;
  if (!s) return;
  const rate = s.rate === null ? '—' : (s.rate * 100).toFixed(1) + '%';
  const conv = s.conversionRate === null ? '—' : (s.conversionRate * 100).toFixed(2) + '%';
  // 四张跟进卡可直接点成筛选（观察期/关键事件/缺日期/数据异常——跟进项最常见的四个待办），
  // 已生效的筛选在卡片上标出来（.is-active），再点一次取消
  const activeOf = (id) => (id === 'missing-date' ? state.filters.missingPublishedAt : state.filters.attainment === id);
  const card = (id, label, value, sub, clickable) => {
    if (!clickable) return `<div class="stat" title="${esc(sub)}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
    const on = activeOf(id);
    return `<div class="stat${on ? ' is-active' : ''}" role="button" tabindex="0" aria-pressed="${on}" data-am-filter="${id}" title="${esc(sub)}；${on ? '点击取消这个筛选' : '点击按此筛选'}"><div class="label">${label}${on ? ' ✓' : ''}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  };
  $('#am-summary').innerHTML = `
    <div class="am-summary am-internal-summary"><div class="am-summary-group"><h3>转化效果</h3><div class="am-summary-grid">
      ${card('', '筛选文章', s.total, '当前筛选范围')}
      ${card('', '达标率', rate, `${s.rateNumerator} / ${s.rateDenominator}（分母=命中−观察期）`)}
      ${card('', '总转化率', conv, `事件 ${s.conversionKeyEvents} / 浏览 ${s.conversionViews}`)}
      ${card('', '已达标', s.attained, `未达标 ${s.notAttained}`)}
      </div></div><div class="am-summary-group"><h3>跟进项</h3><div class="am-summary-grid">
      ${card('observation', '待观察', s.observation, '发布/登记不满 30 天', true)}
      ${card('pending-key-events', '待配置关键事件', s.pendingKeyEvents, 'GA4 已配、事件未选', true)}
      ${card('missing-date', '待补发布日期', s.missingPublishedAt, '影响观察期与达标', true)}
      ${card('data-issue', '数据异常', s.dataIssue, '未达标且数据覆盖不全或抓取失败', true)}
    </div></div></div>`;
  $$('#am-summary [data-am-filter]').forEach((el) => {
    const apply = async () => {
      if (!(await confirmDiscardDrafts())) return;
      const id = el.dataset.amFilter;
      // 再点一次已生效的卡 = 取消该筛选
      const on = activeOf(id);
      if (id === 'missing-date') state.filters.missingPublishedAt = !on;
      else state.filters.attainment = on ? '' : id;
      state.page = 1;
      state.expanded = new Set();
      renderShell(viewEl);
      await loadList();
    };
    el.onclick = apply;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); } };
  });
}

const ATTAIN_LABEL = {
  attained: ['已达标', 'tag-green'], 'not-attained': ['未达标', 'tag-gray'],
  observation: ['观察期', 'tag-blue'], pending: ['待判断', 'tag-amber'],
  'pending-key-events': ['待配置事件', 'tag-amber'], 'data-issue': ['数据异常', 'tag-red'],
  syncing: ['同步中', 'tag-blue'],
};
const SYNC_LABEL = { ok: ['已同步', 'tag-green'], dirty: ['待刷新', 'tag-amber'], error: ['抓取失败', 'tag-red'] };

function renderTable() {
  const box = $('#am-table');
  if (!box) return;
  if (!state.rows.length) {
    box.innerHTML = `<div class="empty">没有匹配的文章。</div>`;
    renderDraftBar();
    return;
  }
  const head = `<thead><tr>
    <th scope="col" class="am-url-col" id="am-url-heading">${state.showTitles ? '文章标题 / URL' : '文章 URL'}</th>
    ${sortHeading('project', '项目', 'am-project-col')}
    <th scope="col" class="am-writer-col">文案师</th>
    ${sortHeading('published_at', '发布日期', 'am-date-col')}
    ${sortHeading('clicks', '累计点击', 'am-number-col')}
    ${sortHeading('views', '累计浏览', 'am-number-col')}
    ${sortHeading('events', '累计关键事件', 'am-number-col')}<th class="am-number-col">转化率</th>
    <th scope="col" class="am-status-col">达标判断</th>
    <th class="am-sync-col">同步</th><th class="am-actions-col"><span class="sr-only">操作</span></th>
  </tr></thead>`;
  box.innerHTML = `<div class="tbl-wrap"><table class="tbl am-main-table am-internal-table">${head}<tbody>${state.rows.map(rowHtml).join('')}</tbody></table></div>`;
  $$('#am-table [data-am-sort]').forEach((button) => { button.onclick = async () => {
    if (!(await confirmDiscardDrafts())) return;
    const sort = button.dataset.amSort;
    Object.assign(state.filters, nextMonitorSort(state.filters, sort)); state.page = 1; state.expanded.clear(); await loadList();
  }; });
  for (const id of state.expanded) loadDetail(id);
  bindRowEvents();
  renderDraftBar();
}

function renderTitleDisplay() {
  const heading = $('#am-url-heading');
  if (heading) heading.textContent = state.showTitles ? '文章标题 / URL' : '文章 URL';
  for (const row of state.rows) {
    const cell = $(`#am-table tr[data-id="${row.id}"] .am-url-cell`);
    if (!cell) continue;
    const link = cell.querySelector('.am-title-text');
    link.textContent = state.showTitles && row.title ? row.title : row.url;
    const line = cell.querySelector('.am-title-line');
    line.querySelectorAll('.tag').forEach(tag => tag.remove());
    if (state.showTitles) line.insertAdjacentHTML('beforeend', titleBadge(row));
    cell.querySelector('.am-url-secondary').textContent = state.showTitles && row.title ? row.url : (row.published_at ? '发布于 ' + row.published_at : '请补填发布日期');
  }
}

function sortHeading(sort, label, cls) {
  const f = state.filters;
  const active = f.sort === sort;
  const next = nextMonitorSort(f, sort);
  const action = next.sort === 'created_at' ? '恢复原顺序' : `按${label}${next.dir === 'desc' ? '降序' : '升序'}排列`;
  return `<th scope="col" class="${cls}" aria-sort="${active ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">
    <button type="button" class="am-sort" data-am-sort="${sort}" aria-label="${action}" title="${action}（点击表头循环切换排序）">${label}<span aria-hidden="true">${active ? (f.dir === 'asc' ? '↑' : '↓') : '↕'}</span></button></th>`;
}

function titleBadge(r) {
  if (r.title) {
    if (r.title_source === 'manual') return '<span class="tag tag-gray" style="font-size:var(--mantine-font-size-xs)" title="手动维护，抓取不会覆盖">手动</span>';
    if (r.title_source === 'fetched') return '<span class="tag tag-blue" style="font-size:var(--mantine-font-size-xs)" title="从文章页面自动抓取">自动</span>';
    return '';
  }
  if (r.title_fetch_status === 'failed') {
    return `<span class="tag tag-amber" style="font-size:var(--mantine-font-size-xs)" title="尚未取得文章标题">未获取</span>`;
  }
  if (r.title_fetch_status === 'pending') return '<span class="tag tag-amber" style="font-size:var(--mantine-font-size-xs)">待获取</span>';
  return '';
}

function writerCell(r) {
  const draft = state.drafts.get(r.id);
  const cwDraft = draft && Object.hasOwn(draft, 'copywriter_id') ? draft.copywriter_id : r.copywriter_id;
  const cwLabel = r.copywriter_name || r.copywriter_email || (r.copywriter_id ? '已关联账号' : '未指派');
  const options = (state.rosters.get(String(r.project_id)) || []).filter(c => Number(c.is_member)).map(c => ({id: c.id, label: c.name || c.email}));
  const currentMissing = cwDraft && !options.some((c) => String(c.id) === String(cwDraft));
  return state.rosters.has(String(r.project_id))
    ? `<select class="am-cw" data-id="${r.id}" aria-label="文案师"><option value="">未指派</option>${currentMissing ? `<option value="${cwDraft}" selected disabled>${esc(cwLabel)}（已移出）</option>` : ''}${options.map((c) => `<option value="${c.id}" ${String(c.id) === String(cwDraft ?? '') ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`
    : `<span class="am-writer-name" title="${esc(r.copywriter_email || cwLabel)}">${esc(cwLabel)}</span>`;
 }

function rowHtml(r) {
  const open = state.expanded.has(r.id);
  const [aLabel, aClass] = ATTAIN_LABEL[r.attainment.status] || ['—', 'tag-gray'];
  const [sLabel, sClass] = r.job ? ['同步中', 'tag-blue'] : (SYNC_LABEL[r.syncStatus] || ['—', 'tag-gray']);
  const draft = state.drafts.get(r.id);
  const pubDraft = draft && Object.hasOwn(draft, 'published_at') ? draft.published_at : r.published_at;
  const proj = state.projects.find((p) => String(p.id) === String(r.project_id));
  const title = state.showTitles && r.title ? r.title : r.url;
  const writer = writerCell(r);
  const tips = [...(r.attainment.reasons || []), ...(r.attainment.evidence || [])].join('；');
  const mismatch = (r.mismatches || []).map((m) => m.note || m.url).filter(Boolean).join('；');
  const mismatchBadge = mismatch ? `<span class="tag tag-amber" style="font-size:var(--mantine-font-size-xs)" title="GSC 中观察到与登记地址不一致：${esc(mismatch)}">URL 疑似不匹配</span>` : '';
  return `<tr data-id="${r.id}" class="${draft ? 'am-is-draft' : ''}">

    <td class="am-url-cell"><div class="am-title-line"><a class="am-title-text" href="${safeUrl(r.url)}" target="_blank" rel="noopener noreferrer" title="${esc(r.url)}">${esc(title)}</a>${state.showTitles ? titleBadge(r) : ''}</div>
      ${state.showTitles && r.title ? `<div class="am-url-secondary" title="${esc(r.url)}">${esc(r.url)}</div>` : `<div class="am-url-secondary">${r.published_at ? '发布于 ' + esc(r.published_at) : '请补填发布日期'}${!r.title && state.showTitles ? ' · 标题待获取' : ''}</div>`}${mismatchBadge}</td>
    <td class="am-project-name" title="${esc(proj?.name || r.project_name || '#' + r.project_id)}">${esc(proj?.name || r.project_name || '#' + r.project_id)}</td>
    <td class="am-writer-cell">${writer}</td>
    <td><input type="date" class="am-pub" data-id="${r.id}" aria-label="发布日期" value="${esc(pubDraft || '')}"></td>
    <td class="am-number">${fmtNum(r.cumulative.clicks)}</td><td class="am-number">${fmtNum(r.cumulative.views)}</td>
    <td class="am-number">${fmtNum(r.cumulative.events)}</td>
    <td class="am-number">${r.cumulative.ratio === null ? '<span class="muted">—</span>' : (r.cumulative.ratio * 100).toFixed(2) + '%'}</td>
    <td><span class="tag ${aClass}" title="${esc(tips)}">${aLabel}</span></td>
    <td class="am-sync-cell"><span class="tag ${sClass}" title="${esc(r.last_synced_at ? '最近同步：' + r.last_synced_at : '尚未同步')}">${sLabel}</span></td>
    <td><div class="am-row-actions"><button type="button" class="btn btn-sm am-exp am-detail-toggle" data-id="${r.id}" aria-expanded="${open}" aria-label="${open ? '收起' : '展开'}文章明细：${esc(title)}">${open ? '收起' : '明细'}</button>
      <a class="btn btn-sm am-settings-link" href="${buildWorkspaceHash({ projectId: r.project_id, section: 'settings', returnLocation: monitorLocation() })}">设置关键事件</a>
      <details class="am-row-more"><summary aria-label="更多文章操作">···</summary><div>
        <button type="button" class="am-sync" data-id="${r.id}" ${state.syncing.has(r.id) ? 'disabled' : ''}>同步文章数据</button>
        <button type="button" class="am-title" data-id="${r.id}" ${state.titling.has(r.id) ? 'disabled' : ''}>${r.title ? '更新标题' : '获取标题'}</button>
      </div></details></div></td>
  </tr>${open ? `<tr class="am-detail-row" data-detail="${r.id}"><td colspan="11" id="am-detail-${r.id}"><div class="empty"><span class="spinner"></span></div></td></tr>` : ''}`;
}

function bindRowEvents() {
  bindRowMenus($('#am-table'), '.am-row-more', '.tbl-wrap');
  $$('.am-settings-link').forEach(link => link.addEventListener('click', leaveMonitor));
  // 展开/收起（展开才查月度与曾用地址）
  $$('.am-exp').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.id);
      if (state.expanded.has(id)) { state.expanded.delete(id); renderTable(); return; }
      state.expanded.add(id);
      renderTable();
    };
  });
  // 草稿：文案师 / 发布日期
  $$('.am-cw').forEach((sel) => {
    sel.onchange = () => setDraft(Number(sel.dataset.id), { copywriter_id: sel.value ? Number(sel.value) : null });
  });
  $$('.am-pub').forEach((inp) => {
    inp.onchange = () => setDraft(Number(inp.dataset.id), { published_at: inp.value || null });
  });
  // 单篇同步
  $$('.am-sync').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.id);
      if (state.syncing.has(id)) return;
      if (state.drafts.has(id)) return toast('这篇有未保存的编辑，先保存或放弃', 'err');
      const current = capturePageContext(viewEl);
      const syncing = state.syncing;
      const pid = rowProjectId(id);
      syncing.add(id);
      btn.disabled = true;
      try {
        const out = await API.syncArticle(pid, id);
        if (!current()) return;
        if (!['ok', 'succeeded', 'complete'].includes(out.status) || out.failed?.length || out.unprocessed?.length || ['partial', 'failed', 'error'].includes(out.current?.status)) { logMonitorError('同步文章数据未完全完成', out.error || out.reason || out.failed || out.current?.errors); await refreshArticleData([id]); return; }
        const done = out.months.filter((m) => m.gsc === 'complete' || m.ga4 === 'complete').length;
        toast(`同步完成：${done} 个月入库`, 'ok');
        // 只在同步完成且无草稿时刷新当前视图（不设置常驻自动刷新）
        await refreshArticleData([id]);
      } catch (e) { logMonitorError('同步文章数据', e); }
      finally { syncing.delete(id); btn.disabled = false; }
    };
  });
  // 单篇获取/重试标题（手动标题不会被覆盖，服务端会拒绝并说明）
  $$('.am-title').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.id);
      if (state.titling.has(id)) return;
      const current = capturePageContext(viewEl);
      const titling = state.titling;
      const pid = rowProjectId(id);
      titling.add(id);
      btn.disabled = true;
      try {
        const out = await API.refetchArticleTitle(pid, id);
        if (!current()) return;
        toast(out.cached ? '该篇已有标题' : `已获取标题：${out.title}`, 'ok');
        if (!state.drafts.size) await loadList();
      } catch (e) { logMonitorError('获取文章标题', e); }
      finally { titling.delete(id); btn.disabled = false; }
    };
  });
}

function rowProjectId(articleId) {
  const r = state.rows.find((x) => x.id === articleId);
  return r ? r.project_id : null;
}

function setDraft(articleId, patch) {
  if (state.savingDrafts?.ids.has(articleId)) return;
  const row = state.rows.find((x) => x.id === articleId);
  if (!row) return;
  const next = { ...(state.drafts.get(articleId) || { projectId: row.project_id }) };
  for (const [key, value] of Object.entries(patch)) {
    if ((value ?? null) === (row[key] ?? null)) delete next[key];
    else next[key] = value;
  }
  if (Object.keys(next).length === 1) state.drafts.delete(articleId);
  else state.drafts.set(articleId, next);
  renderDraftBar();
}

function renderDraftBar() {
  const bar = $('#am-draftbar');
  if (!bar) return;
  const saving = state.savingDrafts;
  bar.style.display = (state.drafts.size || saving) && state.tab === 'internal' ? 'flex' : 'none';
  $('#am-draft-count').textContent = saving ? `正在保存 ${saving.ids.size} 篇文章…` : `${state.drafts.size} 篇有未保存修改`;
  $('#am-draft-save').disabled = !!saving;
  $('#am-draft-save').textContent = saving ? '保存中…' : '保存修改';
  $('#am-draft-discard').disabled = !!saving;
  $$('.am-cw, .am-pub').forEach((control) => { control.disabled = !!saving?.ids.has(Number(control.dataset.id)); });
}

// 提交快照与当前草稿分开：锁住提交行，失败及随后新建的草稿继续保留。
async function saveDrafts() {
  if (state.savingDrafts || !state.drafts.size) return;
  const drafts = state.drafts;
  const current = capturePageContext(viewEl);
  const entries = [...drafts.entries()];
  const operation = { ids: new Set(entries.map(([id]) => id)) };
  state.savingDrafts = operation;
  renderDraftBar();
  let okCount = 0;
  try {
    for (const [articleId, draft] of entries) {
      try {
        const changes = Object.fromEntries(Object.entries(draft).filter(([key]) => key !== 'projectId'));
        await API.updateArticle(draft.projectId, articleId, changes);
        if (drafts.get(articleId) === draft) drafts.delete(articleId);
        if (current() && state.drafts === drafts) {
          invalidateDetails([articleId]);
          const row = state.rows.find((item) => item.id === articleId);
          if (row) {
            Object.assign(row, changes);
            if (Object.hasOwn(changes, 'copywriter_id')) {
              const writer = (state.rosters.get(String(draft.projectId)) || []).find((item) => item.id === draft.copywriter_id);
              row.copywriter_name = writer?.name || null; row.copywriter_email = writer?.email || null;
            }
          }
        }
        okCount++;
      } catch (error) {
        logMonitorError(`保存文章 ${articleId}`, error);
      }
    }
  } finally {
    // 路由已重新进入时，旧请求不能清理新页面的草稿或触发新页面重载。
    if (current() && state.savingDrafts === operation) {
      state.savingDrafts = null;
      renderDraftBar();
      if (okCount) toast(`已保存 ${okCount} 篇`, 'ok');
      if (state.drafts === drafts && !drafts.size) await loadList();
      else if (okCount) renderTable();
    }
  }
}

// ============ 展开明细 ============
function renderProjectSync() {
  const btn = $('#am-sync-project'), status = $('#am-project-sync-status');
  if (!btn || !projectSync) return;
  const pid = state.filters.projectId;
  btn.hidden = state.tab !== 'internal' || !pid;
  const s = projectSync.state(pid), button = projectSyncButton(s);
  btn.disabled = button.disabled; btn.textContent = button.text;
  if (status) {
    status.hidden = !pid || state.tab !== 'internal' || (!s.message && !s.job);
    const labels = { queued: '已排队，历史月份将自动分批同步', running: '同步中，历史月份自动分批推进', succeeded: '同步成功', partial: '部分完成，请核查原因', failed: '同步失败' };
    status.textContent = s.message || (s.job ? `当前项目任务：${labels[s.job.status] || s.job.status}。` : '');
    if (!status.hidden) {
      const link = document.createElement('a'); link.href = '#/background-tasks?type=article-sync&project=' + encodeURIComponent(pid);
      link.textContent = ' 查看后台任务'; status.append(link);
    }
  }
}

async function syncProject() {
  const pid = state.filters.projectId;
  if (!pid) return toast('先选一个项目', 'err');
  await projectSync.submit(pid);
}

function logMonitorError(operation, error) {
  console.error(`文章监控 ${operation}`, error);
}

function invalidateDetails(articleIds = new Set([...state.detailCache.keys(), ...state.detailLoads.keys(), ...state.expanded])) {
  for (const id of articleIds) {
    state.detailCache.delete(id);
    state.detailRevisions.set(id, (state.detailRevisions.get(id) || 0) + 1);
    state.detailLoads.delete(id);
  }
}

async function refreshArticleData(articleIds) {
  invalidateDetails(articleIds);
  if (!state.drafts.size) await loadList();
  else await Promise.all([...articleIds].filter(id => state.expanded.has(id)).map(loadDetail));
}

async function loadDetail(articleId) {
  const box = $('#am-detail-' + articleId);
  if (!box) return;
  const current = capturePageContext(viewEl);
  const cache = state.detailCache;
  const revisions = state.detailRevisions;
  const loads = state.detailLoads;
  const revision = revisions.get(articleId) || 0;
  let pending = null;
  try {
    if (!cache.has(articleId)) {
      pending = loads.get(articleId);
      if (!pending || pending.revision !== revision) {
        pending = { revision, promise: API.articleMonthly(articleId) };
        loads.set(articleId, pending);
      }
      const data = await pending.promise;
      if (!current() || cache !== state.detailCache || (revisions.get(articleId) || 0) !== revision) return;
      cache.set(articleId, data);
    }
    if (!current() || !box.isConnected || (revisions.get(articleId) || 0) !== revision) return;
    const d = cache.get(articleId);
    const monthlyOverview = monthlyOverviewRows(d, { esc, fmtNum, fmtPct, fmtPos });
    const history = (d.history || []).map((item) => `<li><a href="${safeUrl(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.url)}</a>${item.url_changed_at ? `<time>${esc(String(item.url_changed_at).slice(0, 10))}</time>` : ''}</li>`).join('');
    box.innerHTML = `<div class="am-detail-panel am-internal-detail">
      <div class="am-detail-scroll am-overview-scroll" role="region" aria-label="月度表现概览" tabindex="0"><table class="am-detail-table am-month-overview"><thead><tr><th>月份</th><th>统计范围</th><th>GSC 点击</th><th>曝光</th><th>CTR</th><th>排名</th><th>GA4 浏览</th><th>关键事件</th></tr></thead><tbody>${monthlyOverview || '<tr><td colspan="8">还没有月度数据，可在更多操作中同步这篇文章。</td></tr>'}</tbody></table></div>
      ${d.current ? '<p class="am-detail-footnote">本月临时值已计入累计；各来源截至日分别列示，最近 1–2 天可能回填，跨月后由正式月度值接管。</p>' : ''}
      <section class="am-detail-section"><div class="am-detail-section-head"><h4>曾用地址</h4><span>改址后保留历史</span></div>${history ? `<ul class="am-history-list">${history}</ul>` : '<p class="am-detail-empty">暂无曾用地址。</p>'}</section>
      <a class="am-detail-manage" href="${buildWorkspaceHash({ projectId: rowProjectId(articleId), section: 'internal', articleId, returnLocation: monitorLocation() })}">管理这篇文章</a>
    </div>`;
    box.querySelector('.am-detail-manage')?.addEventListener('click', leaveMonitor);
  } catch (error) {
    logMonitorError('读取文章明细', error);
    if (current() && box.isConnected && (revisions.get(articleId) || 0) === revision) {
      box.innerHTML = '<div class="am-detail-panel"><p class="am-detail-empty">明细暂不可用。</p><button class="btn btn-sm am-detail-retry">重试</button></div>';
      box.querySelector('button').onclick = () => loadDetail(articleId);
    }
  } finally {
    if (pending && loads.get(articleId) === pending) loads.delete(articleId);
  }
}

// 数字分页（带省略号）+ 页脚区间；1000 篇 = 20 页时不用连点 19 次
function pageItems(page, pages) {
  const out = [];
  const push = (n) => out.push(n);
  if (pages <= 7) { for (let i = 1; i <= pages; i++) push(i); return out; }
  push(1);
  if (page > 3) push('ellipsis');
  for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) push(i);
  if (page < pages - 2) push('ellipsis');
  push(pages);
  return out;
}

function renderPager() { renderPagination(false); }

function renderPagination(external) {
  const f = external ? state.ext : state;
  const prefix = external ? 'am-ext-pager' : 'am-pager';
  const pages = Math.max(1, Math.ceil(f.total / f.pageSize));
  const unit = external ? '个平台' : '篇';
  const move = async (page) => {
    if (page < 1 || page > pages || page === f.page) return;
    if (external) { state.ext.page = page; await loadExtMonitor(); }
    else await gotoPage(page);
  };
  const arrows = `<button class="btn btn-sm" data-page="${f.page - 1}" aria-label="上一页" ${f.page <= 1 ? 'disabled' : ''}>‹</button>`;
  const next = `<button class="btn btn-sm" data-page="${f.page + 1}" aria-label="下一页" ${f.page >= pages ? 'disabled' : ''}>›</button>`;
  const top = $('#' + prefix + '-top');
  const bottom = $('#' + prefix);
  if (top) top.innerHTML = `${arrows}<span aria-live="polite">${f.page} / ${pages}</span>${next}`;
  if (bottom) bottom.innerHTML = `<span class="am-page-total">共 ${f.total} ${unit}${f.total ? ` · 显示 ${(f.page - 1) * f.pageSize + 1}–${Math.min(f.page * f.pageSize, f.total)}` : ''}</span>
    ${arrows}${pageItems(f.page, pages).map((item) => item === 'ellipsis' ? '<span>…</span>' : `<button class="btn btn-sm ${item === f.page ? 'btn-primary' : ''}" data-page="${item}" ${item === f.page ? 'aria-current="page"' : ''}>${item}</button>`).join('')}${next}`;
  for (const container of [top, bottom]) container?.querySelectorAll('[data-page]').forEach((button) => { button.onclick = () => move(Number(button.dataset.page)); });
  if (!external && $('#am-result-note')) $('#am-result-note').textContent = `共 ${f.total} 篇文章 · 点击列名排序`;
}

// 导出：忙态 + 草稿提示 + 空结果提示（未保存的编辑不进导出，先说明再下）
async function exportData() {
  const btn = $('#am-export');
  const original = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
  try {
    if (state.drafts.size) toast('导出内容为已保存的数据，不包含未保存的修改', 'err', 5000);
    if (!state.total) { toast('当前筛选没有命中文章', 'err'); return; }
    const f = state.filters;
    const params = new URLSearchParams();
    if (f.projectId) params.set('project_id', f.projectId);
    if (f.status) params.set('status', f.status);
    if (f.copywriterUserId) params.set('copywriter_user_id', f.copywriterUserId);
    if (f.missingPublishedAt) params.set('missing_published_at', '1');
    if (f.unassigned) params.set('unassigned', '1');
    if (f.attainment) params.set('attainment', f.attainment);
    if (f.sync) params.set('sync', f.sync);
    if (f.q.trim()) params.set('query', f.q.trim());
    params.set('sort', f.sort);
    params.set('dir', f.dir);
    window.open('/api/article-monitor/export.xlsx?' + params.toString());
    toast(`已开始导出 ${state.total} 篇`, 'ok');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

async function gotoPage(p) {
  if (!(await confirmDiscardDrafts())) return;
  state.page = p;
  state.expanded = new Set();
  await loadList();
}


// 域名里有 . / : 等字符，直接拼 id 会让 CSS 选择器失效——转成安全 key
function extKey(pid, domain) {
  return pid + '-' + String(domain).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// 外链列表按文章条件确定平台集合；平台指标仍代表整个平台。
function externalParams(paginated = true) {
  const f = state.ext;
  const params = new URLSearchParams();
  if (paginated) { params.set('page', String(f.page)); params.set('page_size', String(f.pageSize)); }
  for (const [key, value] of Object.entries({ project_id: f.projectId, copywriter_user_id: f.copywriterUserId,
    query: f.q.trim(), domain: f.domain.trim(), status: f.status, sync: f.sync,
    missing_published_at: f.missingPublishedAt ? '1' : '', unassigned: f.unassigned ? '1' : '', sort: f.sort, dir: f.dir })) {
    if (value) params.set(key, value);
  }
  return params;
}

async function loadExtMonitor() {
  const box = $('#am-ext-table');
  if (!box) return;
  const request = ++extRequest;
  const status = $('#am-ext-load-status'); status.hidden = false; status.textContent = '正在读取当前筛选结果…';
  updateContext();
  renderMoreFiltersStatus();
  box.setAttribute('aria-busy', 'true');
  try {
    const data = await API.externalPlatforms(externalParams());
    if (request !== extRequest || !box.isConnected) return;
    const pages = Math.max(1, Math.ceil(data.total / state.ext.pageSize));
    if (state.ext.page > pages) { state.ext.page = pages; return loadExtMonitor(); }
    state.ext.rows = data.rows; state.ext.total = data.total; state.ext.summary = data.summary;
    const domains = [...new Set([...(data.domains || []), state.ext.domain].filter(Boolean))];
    $('#am-ext-domain').innerHTML = '<option value="">全部平台</option>' + domains.map(domain => `<option value="${esc(domain)}" ${domain === state.ext.domain ? 'selected' : ''}>${esc(domain)}</option>`).join('');
    state.ext.expanded.clear(); state.ext.detailCache.clear(); renderExtMonitor();
  } catch (e) {
    logMonitorError('读取平台列表', e);
    if (request === extRequest && box.isConnected) {
      box.innerHTML = `<div class="empty">当前数据暂不可用。<br><button class="btn btn-sm" id="am-ext-retry">重试</button></div>`;
      if (!state.ext.summary) $('#am-ext-summary').innerHTML = '<p class="muted">统计暂不可用，重试列表后更新。</p>';
      $('#am-ext-retry').onclick = loadExtMonitor;
    }
  } finally { if (request === extRequest) { status.hidden = true; box.removeAttribute('aria-busy'); } }
}

function renderExtMonitor() {
  const box = $('#am-ext-table');
  if (!box) return;
  const s = state.ext.summary;
  const extMetric = (v) => (v === null || v === undefined ? '<span class="muted" title="尚未取得该指标，不代表真实为 0">—</span>' : fmtNum(v));
  // 平台表现与跟进项分组，跟进项直接切换对应筛选。
  const card = (id, label, value, sub, title) =>
    `<div class="stat${id && (id === 'missing-date' ? state.ext.missingPublishedAt : id === 'unassigned' ? state.ext.unassigned : state.ext.sync === id) ? ' is-active' : ''}" ${id ? `role="button" tabindex="0" data-ext-filter="${id}" aria-pressed="${id === 'missing-date' ? state.ext.missingPublishedAt : id === 'unassigned' ? state.ext.unassigned : state.ext.sync === id}" title="${sub}；点击切换此筛选"` : `title="${title || sub}"`}><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const articleScoped = state.ext.missingPublishedAt || state.ext.unassigned || state.ext.copywriterUserId || state.ext.status || state.ext.q.trim();
  const summaryHtml = s ? `
    <div class="am-summary am-external-summary"><div class="am-summary-group"><h3>结果</h3><div class="am-summary-grid">
      ${card('', '命中项目', s.matchedProjectCount ?? '—', '当前筛选范围')}
      ${card('', '命中平台', s.platformCount, `${s.matchedProjectCount ?? '—'} 个项目 · 当前筛选范围`)}
      ${card('', '命中外链', s.matchedArticleCount, `登记 ${s.registeredArticleCount} · 启用 ${s.activeArticleCount}`)}
      ${card('', '每日用户数累计', extMetric(s.users), '命中平台整体数据', '按文章/人员筛选时仍是平台整体数据')}
      ${card('', '关键事件累计', extMetric(s.keyEvents), '未配置事件的项目不计入')}
      </div></div><div class="am-summary-group"><h3>跟进项</h3><div class="am-summary-grid">
      ${card('unconfigured', '未配置项目', s.unconfiguredProjectCount ?? '—', 'GA4 未绑定')}
      ${card('issue', '同步异常平台', s.syncIssuePlatformCount ?? '—', '旧配置/数据不完整')}
      ${card('missing-date', '待补发布日期', s.missingPublishedAtArticleCount ?? '—', '影响参考窗口')}
      ${card('unassigned', '未指派文章', s.unassignedArticleCount ?? '—', '没有文案师')}
    </div></div></div>
    ` : '';
  const head = `<thead><tr>
    <th scope="col" class="am-platform-col">项目 / 平台域名</th>
    <th scope="col" class="am-ext-users-col">每日用户数累计</th>
    <th scope="col" class="am-ext-users-col">关键事件累计</th>
    <th scope="col" class="am-scope-col">文章范围</th>
    <th scope="col" class="am-status-col">同步</th>
    <th class="am-external-actions-col"><span class="sr-only">操作</span></th>
  </tr></thead>`;
  const SYNC_TAG = {
    ok: ['完整', 'tag-green'], issue: ['同步异常', 'tag-amber'], pending: ['待同步', 'tag-gray'], unconfigured: ['未配置', 'tag-gray'],
  };
  const body = state.ext.rows.map((r) => {
    const open = state.ext.expanded.has(r.project_id + '|' + r.domain);
    const [syncLabel, syncClass] = SYNC_TAG[r.syncStatus] || ['—', 'tag-gray'];
    const tags = [`<span class="tag ${syncClass}" title="${r.staleConfig ? '配置有变更未重抓，平台数字可能偏旧' : ''}">${syncLabel}</span>`];
    if (r.staleConfig) tags.push('<span class="tag tag-amber">旧配置</span>');
    if (r.freezeCount) tags.push(`<span class="tag tag-gray">冻结 ${r.freezeCount}</span>`);
    return `<tr data-key="${r.project_id}|${r.domain}">
      <td class="am-url-cell"><strong class="am-project-name">${esc(r.project_name || '#' + r.project_id)}</strong><span class="am-url-secondary" title="${esc(r.domain)}">${esc(r.domain)}</span></td>
      <td class="am-number">${extMetric(r.usersTotal)}</td><td class="am-number">${extMetric(r.eventsTotal)}</td>
      <td class="am-article-scope"><strong>${r.matchedArticleCount}</strong> 命中 <i>/</i> <strong>${r.registeredArticleCount}</strong> 登记 <i>·</i> <strong>${r.activeArticleCount}</strong> 启用</td>
      <td>${tags.join(' ')}<span class="am-url-secondary">截至 ${esc(r.dataThrough || '—')}</span></td>
      <td><button class="btn btn-sm extx-exp am-detail-toggle" data-key="${r.project_id}|${r.domain}" aria-label="${open ? '收起' : '展开'}平台明细" aria-expanded="${open}">${open ? '收起' : '明细'}</button></td>
    </tr>
    ${open ? `<tr class="am-detail-row" data-detail="${r.project_id}|${r.domain}"><td colspan="6" id="extx-detail-${extKey(r.project_id, r.domain)}"><div style="display:flex;justify-content:center;padding:20px 0"><span class="spinner"></span></div></td></tr>` : ''}`;
  }).join('');
  $('#am-ext-summary').innerHTML = summaryHtml;
  $('#am-ext-data-status').textContent = s ? `数据状态：${extDataStatusLabel(s.dataStatus)}${s.dataAsOf ? ' · 截至 ' + s.dataAsOf : ''}` : '';
  const scope = $('#am-ext-scope-note');
  scope.hidden = !articleScoped;
  scope.textContent = '当前已按文章或人员筛选；命中数为筛选文章数，用户与关键事件仍是命中平台整体数据，不代表所选人员带来的流量。';

  $('#am-ext-sort').value = state.ext.sort;
  box.innerHTML = state.ext.rows.length
    ? `<div class="tbl-wrap"><table class="tbl am-main-table am-external-table">${head}<tbody>${body}</tbody></table></div>`
    : '<div class="empty">没有匹配的平台。试试调整项目或筛选条件。</div>';
  renderExtPager();
  $$('#am-ext-summary [data-ext-filter]').forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.extFilter;
      if (id === 'missing-date') { state.ext.missingPublishedAt = !state.ext.missingPublishedAt; const c = $('#am-ext-missing-date'); if (c) c.checked = state.ext.missingPublishedAt; }
      if (id === 'unassigned') { state.ext.unassigned = !state.ext.unassigned; const c = $('#am-ext-unassigned'); if (c) c.checked = state.ext.unassigned; }
      if (id === 'unconfigured' || id === 'issue') { state.ext.sync = state.ext.sync === id ? '' : id; const sel = $('#am-ext-sync'); if (sel) sel.value = state.ext.sync; }
      state.ext.page = 1;
      loadExtMonitor();
    };
    el.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); } };
  });
  for (const key of state.ext.expanded) { const [pid, domain] = key.split('|'); loadExtDetail(Number(pid), domain); }
  $$('.extx-exp').forEach((btn) => {
    btn.onclick = async () => {
      const [pid, domain] = btn.dataset.key.split('|');
      const key = pid + '|' + domain;
      if (state.ext.expanded.has(key)) { state.ext.expanded.delete(key); renderExtMonitor(); return; }
      state.ext.expanded.add(key);
      renderExtMonitor();
    };
  });
}

function extDataStatusLabel(st) {
  return { complete: '完整', partial: '部分数据已知/待同步', unconfigured: '有项目未配置 GA4', empty: '暂无数据' }[st] || '—';
}

function renderExtPager() { renderPagination(true); }

async function loadExtDetail(pid, domain) {
  const box = $('#extx-detail-' + extKey(pid, domain));
  if (!box) return;
  const key = pid + '|' + domain;
  const current = capturePageContext(viewEl);
  const request = extRequest;
  const cache = state.ext.detailCache;
  const valid = () => current() && request === extRequest && cache === state.ext.detailCache;
  try {
    if (!cache.has(key)) {
      const data = await API.externalPlatformDetail(pid, domain);
      if (!valid()) return;
      cache.set(key, data);
    }
    if (!valid() || !box.isConnected) return;
    const d = cache.get(key);
    const dataStatus = (value) => ({ complete: '完整', partial: '不完整', pending: '待同步', error: '抓取失败' }[value] || value || '未知');
    const rows = (d.articles || []).map((article) => {
      const freezes = (article.freezes || []).map((segment) => `<div class="am-segment"><strong>冻结段 v${esc(segment.segmentRevision)}</strong><span>${esc(segment.from)} 至 ${esc(segment.to)}</span><span>用户 ${segment.usersValue == null ? '未知' : fmtNum(segment.usersValue)} · ${esc(dataStatus(segment.usersStatus))}</span></div>`).join('');
      const active = article.activeSegment;
      const activeHtml = active ? `<div class="am-segment"><strong>活跃段</strong><span>${esc(active.start || '—')} 起</span><span>用户 ${active.users?.value == null ? '未知' : fmtNum(active.users.value)}${active.users && !active.users.complete ? ' · 不完整' : ''}</span></div>` : '<p class="am-detail-note">已停用，无活跃段。</p>';
      const windowHtml = article.window ? `<span>${esc(article.window.start)} 至 ${article.window.end ? esc(article.window.end) : '今'}</span><strong class="am-window-share">份额 ${(article.window.share * 100).toFixed(0)}%</strong>` : '<span class="am-detail-note">窗口待定<br>请补填发布日期</span>';
      return `<tr><td><a class="am-ext-article-title" href="${safeUrl(article.url)}" target="_blank" rel="noopener noreferrer">${esc(article.title || article.url)}</a>${article.title ? `<span class="am-ext-article-url">${esc(article.url)}</span>` : ''}<div class="am-detail-badges">${titleBadge(article)}</div></td>
        <td>${esc(article.copywriter_name || article.copywriter_email || '未指派')}</td><td ${article.published_at ? '' : 'title="请补填发布日期"'}>${esc(article.published_at || '请补填发布日期')}</td>
        <td><span class="tag tag-gray">${article.status === 'active' ? '启用' : '已停用'}</span></td><td>${windowHtml}</td>
        <td><details class="am-segment-details"><summary>${article.freezes?.length ? `冻结 ${article.freezes.length} 段` : '参考区间'}</summary><div class="am-segments">${freezes}${activeHtml}</div></details></td>
        <td class="am-detail-num"><strong>${fmtNum(article.referenceUsers)}</strong>${article.referenceComplete ? '' : '<div class="am-detail-note">不完整</div>'}</td>
        <td><div class="am-detail-actions"><button class="btn btn-sm extx-title" data-id="${article.id}">${article.title ? '更新标题' : '获取标题'}</button>
          <a class="btn btn-sm" href="${buildWorkspaceHash({ projectId: pid, section: 'external', articleId: article.id, returnLocation: monitorLocation() })}">管理文章</a></div></td></tr>`;
    }).join('');
    box.innerHTML = `<div class="am-detail-panel am-external-detail">
      ${d.platform.staleConfig ? '<p class="am-detail-note">配置已变更，当前平台数字可能偏旧，需重新同步。</p>' : ''}
        <div class="am-detail-scroll am-external-detail-scroll" role="region" aria-label="平台内文章参考明细" tabindex="0"><table class="am-detail-table am-external-detail-table">
          <colgroup><col style="width:25%"><col style="width:8%"><col style="width:10%"><col style="width:8%"><col style="width:13%"><col style="width:19%"><col style="width:8%"><col style="width:9%"></colgroup>
          <thead><tr><th>文章</th><th>文案师</th><th>发布日期</th><th>状态</th><th>窗口 / 份额</th><th>冻结与活跃段</th><th class="am-detail-num">参考合计</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="am-detail-empty">这个平台下暂无文章。</td></tr>'}</tbody></table></div>
        <p class="am-detail-footnote">“每日用户数累计”会跨日重复计算同一来源访客。文章参考合计与平台总数的统计范围不同，迁移、空档及冻结时点都会影响结果。</p>
      </div>`;
    box.querySelectorAll('.extx-title').forEach((button) => { button.onclick = async () => {
      button.disabled = true;
      try {
        const result = await API.refetchExternalTitle(pid, Number(button.dataset.id));
        if (!valid()) return;
        toast(result.cached ? '该篇已有标题' : `已获取标题：${result.title}`, 'ok');
        cache.delete(key); await loadExtDetail(pid, domain);
      } catch (error) { logMonitorError('获取站外文章标题', error); button.disabled = false; }
    }; });
  } catch (error) {
    logMonitorError('读取平台明细', error);
    if (valid() && box.isConnected) box.innerHTML = '<div class="am-detail-panel"><p class="am-detail-empty">平台明细暂不可用。</p></div>';
  }
}
