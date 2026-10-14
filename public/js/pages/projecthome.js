// 项目文章工作区：站内文章、站外文章、文案师与监控配置。
import { API } from '../api.js';
import { capturePageContext } from '../page-lifecycle.js';
import { loadingRows } from '../components/page-loading.js';
import { bindRowMenus } from '../components/monitor-controls.js';
import { openProjectForm } from './projects.js';
import { parseWorkspaceHash, buildWorkspaceHash, sanitizeReturnLocation, findArticlePage } from './project-article-workspace-route.js';

let projectId = null;
let home = null; // { project, articleCount, tasks, linkCount, externalCount, isAdmin }
let state = { q: '', status: '', page: 1, pageSize: 50, total: 0, tab: 'internal', selected: new Set() };
let viewEl = null;
let copywriters = []; // 文案师名单（在册 + revoked 历史项）
let candidates = []; // 候选账号 = 全部已有账号（on_roster 标在册）
let settingsLoading = false;
let keyEvents = null; // GA4 关键事件（{selected, stale, options, scope}，null = 还没加载/不可用）
let workspace = { section: 'internal', articleId: null, returnLocation: null };
let projects = [];
let projectsReady = false;
let projectError = null;
let renderVersion = 0;
let internalLoadVersion = 0;
let externalLoadVersion = 0;

function workspaceContext() {
  const element = viewEl;
  const version = renderVersion;
  const pid = projectId;
  const current = capturePageContext(element);
  return { element, projectId: pid, isCurrent: () => current() && version === renderVersion && pid === projectId };
}

export async function renderProjectHome(el) {
  const version = ++renderVersion;
  viewEl = el;
  workspace = parseWorkspaceHash(location.hash);
  projectId = workspace.projectId ? String(workspace.projectId) : null;
  state = { q: '', status: '', page: 1, pageSize: 50, total: 0, tab: workspace.section, selected: new Set(), selectedAll: false };
  Object.assign(extState, { q: '', status: '', page: 1, total: 0, rows: [], selected: new Set() });
  home = null; projects = []; copywriters = []; candidates = []; keyEvents = null;
  projectsReady = false; projectError = null;
  settingsLoading = state.tab === 'settings';
  const pid = projectId;
  const current = () => version === renderVersion && el.isConnected && pid === projectId;
  render(el, true);
  const projectList = API.projects().then(data => {
    if (!current()) return;
    projects = data; projectsReady = true; updateProjectSelector(); renderProjectStatus();
  }).catch(e => {
    if (!current()) return;
    projectError = e; renderProjectStatus();
  });
  if (!pid) { await projectList; if (current()) render(el); return; }
  // 请求立即发出，先捕获拒绝，避免上下文读取失败时留下未处理的预取异常。
  const firstList = !workspace.articleId && state.tab !== 'settings'
    ? (state.tab === 'external' ? API.externalArticles(pid, new URLSearchParams({ page: '1', page_size: String(extState.pageSize) })) : API.projectArticles(pid, new URLSearchParams({ page: '1', page_size: String(state.pageSize) })))
      .then(data => ({ data }), error => ({ error })) : null;
  try {
    const [h, cw] = await Promise.all([API.projectHome(pid), API.projectCopywriters(pid)]);
    if (!current()) return;
    home = h; copywriters = cw;
    if (workspace.articleId && state.tab !== 'settings') {
      const external = state.tab === 'external';
      const page = await findArticlePage({
        articleId: workspace.articleId, pageSize: state.pageSize,
        fetchIds: external ? null : async () => (await API.projectArticles(pid, new URLSearchParams({ ids_only: '1' }))).ids,
        fetchPage: async (number, size) => API.externalArticles(pid, new URLSearchParams({ page: String(number), page_size: String(size) })),
      });
      if (!current()) return;
      if (page) (external ? extState : state).page = page;
      else { workspace.articleId = null; toast('该文章已不存在，或不属于当前项目。', 'err', 4500); }
    }
    render(el, false, firstList);
    if (state.tab === 'settings') await loadSettingsExtras(current);
    await projectList;
  } catch (e) {
    if (!current()) return;
    const body = el.querySelector('#ph-tab-body');
    body.innerHTML = `<div class="card"><div class="empty" role="alert">项目读取失败：${esc(e.message)}<p><button class="btn" id="ph-context-retry">重试</button></p></div></div>`;
    body.querySelector('button').onclick = () => renderProjectHome(el);
  }
}

function renderProjectStatus() {
  const status = viewEl?.querySelector('#ph-project-status');
  if (!status) return;
  status.hidden = !projectError;
  status.innerHTML = projectError ? `项目列表读取失败：${esc(projectError.message)} <button class="btn btn-sm">重试</button>` : '';
  if (projectError) status.querySelector('button').onclick = () => renderProjectHome(viewEl);
}

function updateProjectSelector() {
  const select = $('#ph-project');
  if (!select) return;
  select.innerHTML = '<option value="">选择项目…</option>' + projects.map(p => `<option value="${p.id}" ${String(p.id) === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  select.disabled = false;
}

async function loadSettingsExtras(current) {
  const pid = projectId;
  const [cand, ke] = await Promise.allSettled([API.copywriterCandidates(pid), API.articleKeyEvents(pid)]);
  if (!current()) return;
  settingsLoading = false;
  candidates = cand.status === 'fulfilled' ? cand.value : [];
  keyEvents = ke.status === 'fulfilled' ? ke.value : null;
  renderMonitorSettings($('#ph-tab-body'));
  if (cand.status === 'rejected' || ke.status === 'rejected') {
    const note = document.createElement('p'); note.className = 'pw-help'; note.setAttribute('role', 'alert');
    note.innerHTML = '部分配置读取失败，其他区域仍可使用。 <button class="btn btn-sm">重试配置</button>';
    note.querySelector('button').onclick = () => loadSettingsExtras(current);
    $('#ph-tab-body').prepend(note);
  }
}

function render(el, loading = false, firstList = null) {
  const p = home?.project || (loading && projectId ? { id: projectId } : null);
  const tabs = [['internal', '站内文章'], ['external', '站外文章'], ['settings', '文案师与监控']];
  el.innerHTML = `<section class="project-workspace">
    <header class="page-head">
      <div><h2>项目文章管理</h2>
        <p class="page-desc">统一维护站内文章、站外文章、文案师名单与监控设置。</p></div>
      <div class="page-actions">${p ? `<button type="button" class="btn" id="ph-edit" ${loading ? 'disabled' : ''}>编辑项目</button>` : ''}<a class="btn" href="${esc(returnLink())}">← 返回</a></div>
    </header>
    <p id="ph-project-status" class="muted" role="status"></p>
    <div class="pw-project-bar"><label class="pw-project-select"><span>项目</span><select id="ph-project" aria-label="选择项目" ${projectsReady ? '' : 'disabled'}><option value="">${loading ? '正在读取项目…' : '选择项目…'}</option>
      ${(projects.length ? projects : home ? [home.project] : []).map((x) => `<option value="${x.id}" ${String(x.id) === projectId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      ${p ? `<div class="pw-project-meta"><span class="pw-count-chip">站内 <strong id="ph-article-count">${loading ? '—' : home.articleCount ?? 0}</strong> 篇</span><span class="pw-count-chip">站外 <strong id="ph-external-count">${loading ? '—' : home.externalCount ?? 0}</strong> 篇</span>
        <span class="tag ${p.ga4_property_id ? 'tag-green' : 'tag-gray'}" title="GA4 媒体资源">GA4 ${loading ? '读取中' : p.ga4_property_id ? '已绑定' : '未绑定'}</span><span class="tag ${p.gsc_site ? 'tag-green' : 'tag-gray'}" title="Search Console 站点">GSC ${loading ? '读取中' : p.gsc_site ? '已绑定' : '未绑定'}</span></div>
      <nav class="pw-tabs" role="tablist" aria-label="项目文章管理分区">${tabs.map(([key, label]) => `<button class="ph-tab ${state.tab === key ? 'is-active' : ''}" id="ph-tab-${key}" type="button" role="tab" aria-controls="ph-tab-body" aria-selected="${state.tab === key}" data-tab="${key}">${label}</button>`).join('')}</nav>` : ''}
    </div>
    ${p ? '<div id="ph-articles"><div id="ph-tab-body" role="tabpanel"></div></div>' : `<div class="pw-empty"><h3>选择一个项目开始管理文章</h3><p>在上方选择项目，维护文章清单、指派文案师或配置监控。</p>${projects.length ? '' : '<a class="btn" href="#/projects">前往项目管理</a>'}</div>`}
  </section>`;
  renderProjectStatus();
  $('#ph-project').onchange = (e) => { location.hash = buildWorkspaceHash({ projectId: e.target.value, section: state.tab, returnLocation: workspace.returnLocation }); };
  if (!p) return;
  $('#ph-edit').onclick = () => {
    const context = workspaceContext();
    openProjectForm(p.id, async () => {
      const updated = await API.projectHome(context.projectId);
      if (!context.isCurrent()) return;
      home = updated; render(context.element);
    });
  };
  $$('.ph-tab').forEach((b) => { b.onclick = () => { location.hash = buildWorkspaceHash({ projectId, section: b.dataset.tab, returnLocation: workspace.returnLocation }); }; });
  renderTabBody(loading, firstList);
}

// 「返回」只放行站内位置（sanitizeReturnLocation 的过滤），没有来源就退回文章监控
function returnLink() {
  return sanitizeReturnLocation(workspace.returnLocation) || '#/article-monitor';
}

// 页码已由服务端清单解析，这里只负责给已定位文章视觉反馈。
function highlightDeepLinkedArticle() {
  const aid = workspace.articleId;
  if (!aid) return;
  const row = viewEl.querySelector(`[data-article-id="${aid}"]`);
  if (!row) return;
  workspace.articleId = null;
  row.classList.add('pw-targeted');
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => row.classList.remove('pw-targeted'), 3000);
}

// ============ 文案师名单（项目唯一角色：名单即成员、成员即权限） ============
function copywritersCard() {
  const notOnRoster = candidates.filter((c) => !Number(c.on_roster));
  return `<section class="pw-panel pw-roster"><h3>文案师名单</h3>
    <p class="pw-help">站内与站外文章共用这份名单。加入已有账号后，该账号获得项目访问与维护权限。</p>
    ${settingsLoading ? '<p class="pw-help">正在读取可加入的账号…</p>' : notOnRoster.length ? `<div class="pw-roster-add"><select id="ph-cw-add-sel" aria-label="选择已有账号"><option value="">选择已有账号…</option>${notOnRoster.map((c) => `<option value="${c.id}">${esc(c.name ? c.name + '（' + c.email + '）' : c.email)}</option>`).join('')}</select><button class="btn" id="ph-cw-add-btn">加入名单</button></div>` : '<p class="pw-help">所有已有账号均已在名单中。</p>'}
    <div class="pw-roster-list">${copywriters.map((c) => `<div class="pw-roster-row ${Number(c.is_member) ? '' : 'is-revoked'}"><div class="pw-roster-person"><strong>${esc(c.name || c.email)}</strong>${c.name ? `<span>${esc(c.email)}</span>` : ''}<small>站内引用 ${Number(c.article_count) || 0} 篇 · ${Number(c.is_member) ? '在册' : c.account_deleted_at ? '账号已删除，保留历史署名' : '已移出，保留历史署名'}</small></div>${Number(c.is_member) ? `<button class="btn btn-sm ph-cw-del" data-id="${c.id}">移出名单</button>` : c.account_deleted_at ? '' : `<button class="btn btn-sm ph-cw-restore" data-user-id="${c.user_id}">重新加入</button>`}</div>`).join('') || '<div class="pw-empty-mini">还没有文案师，请从已有账号中选择。</div>'}</div>
    <p class="pw-help pw-roster-note">姓名由管理员在账号管理中维护；移出名单不删除历史文章署名。</p>
  </section>`;
}

function bindCopywriterActions() {
  $$('.ph-cw-del').forEach((btn) => {
    btn.onclick = () => {
      const person = copywriters.find((c) => String(c.id) === btn.dataset.id);
      confirmDialog('移出文案师名单', `确认移出「${esc(person?.name || person?.email || '该账号')}」？移出会收回通过文案师身份获得的项目访问与维护权限；项目所有者和管理员仍保留其原有权限。历史文章署名会保留，该账号不再接受新的文章指派。`, async () => {
        try { await API.removeCopywriter(projectId, btn.dataset.id); toast('已移出名单，历史署名保留', 'ok'); await reload(); }
        catch (e) { toast(e.message, 'err'); }
      });
    };
  });
  const enable = async (id, btn) => {
    if (!id) return toast('请先选择已有账号', 'err');
    btn.disabled = true;
    try { await API.enableCopywriter(projectId, id); toast('已加入文案师名单', 'ok'); await reload(); }
    catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  };
  $$('.ph-cw-restore').forEach((btn) => { btn.onclick = () => enable(btn.dataset.userId, btn); });
  const addBtn = $('#ph-cw-add-btn');
  if (addBtn) addBtn.onclick = () => enable($('#ph-cw-add-sel').value, addBtn);
}

function renderMonitorSettings(body) {
  const p = home.project;
  body.innerHTML = `<div class="pw-settings-grid"><div class="pw-settings-left"><section class="pw-panel"><div class="pw-panel-heading"><h3>连接与同步</h3><button class="btn btn-sm" id="ph-bind">配置资源</button></div>
    <div class="pw-resource-status"><span>GA4 媒体资源：${p.ga4_property_id ? '已绑定' : '未绑定'}</span><span>GSC 网站：${p.gsc_site ? '已绑定' : '未绑定'}</span></div>
    <div class="pw-sync-row"><div><strong>站内文章同步</strong><small>${p.gsc_site || p.ga4_property_id ? '按项目已绑定的数据源获取文章月度数据' : '请先在项目中绑定 GSC 或 GA4 资源'}</small></div><button class="btn btn-sm" id="ph-sync-all" ${p.gsc_site || p.ga4_property_id ? '' : 'disabled'}>刷新站内同步</button></div>
    <div class="pw-sync-row"><div><strong>站外来源同步</strong><small>${p.ga4_property_id ? '按 GA4 来源平台获取日度数据' : '请先绑定 GA4 媒体资源'}</small></div><button class="btn btn-sm" id="ext-sync" ${p.ga4_property_id ? '' : 'disabled'}>刷新站外同步</button></div>
    <button class="btn btn-sm pw-backfill-action" id="ph-backfill">首次回填…</button>
    </section>${copywritersCard()}</div>${keyEventsCard()}</div>`;
  bindCopywriterActions();
  $('#ph-bind').onclick = () => openProjectForm(p.id, reload);
  $('#ph-sync-all').onclick = () => runProjectSync();
  $('#ext-sync').onclick = syncExternalData;
  $('#ph-backfill').onclick = openBackfillModal;
  $('#ph-ke-edit').onclick = openKeyEventsModal;
  const save = $('#ph-ke-save-inline');
  if (save) save.onclick = async () => {
    const context = workspaceContext();
    save.disabled = true;
    try {
      const names = $$('#ph-ke-card input[name="event"]:checked', context.element).map((x) => x.value);
      await API.saveArticleKeyEvents(context.projectId, names);
      const updated = await API.articleKeyEvents(context.projectId);
      if (!context.isCurrent()) return;
      keyEvents = updated; toast('关键事件已保存', 'ok'); renderMonitorSettings(body);
    }
    catch (e) { toast(e.message, 'err'); save.disabled = false; }
  };
}

// ============ 关键事件（转化率判据的事件清单；站内/站外监控共用） ============
function keyEventsCard() {
  const ke = keyEvents;
  const options = [...new Set([...(ke?.options || []), ...(ke?.selected || [])])];
  const stale = ke?.stale || [];
  return `<section class="pw-panel pw-key-events" id="ph-ke-card"><div class="pw-panel-heading"><h3>GA4 关键事件</h3>${ke ? '<button class="btn btn-primary btn-sm" id="ph-ke-save-inline">保存关键事件</button>' : ''}</div>
    <p class="pw-help">转化率 = 所选关键事件次数 ÷ 浏览。影响站内 ${ke?.scope?.internal ?? home.articleCount ?? 0} 篇、站外 ${ke?.scope?.external ?? home.externalCount ?? 0} 篇；保存后两类监控按新清单取数。</p>
    <div class="pw-event-list">${options.map((name) => `<label class="pw-event"><input type="checkbox" name="event" value="${esc(name)}" ${(ke.selected || []).includes(name) ? 'checked' : ''}><span><strong>${esc(name)}</strong><small>${stale.includes(name) ? 'GA4 已不存在此事件，当前选择仍会保留' : '统计该事件在页面内的触发次数'}</small></span></label>`).join('') || `<div class="pw-empty-mini">${settingsLoading ? '正在读取关键事件配置…' : ke ? '暂无可选事件，可以手动添加。' : '尚未读取到关键事件配置。'}</div>`}</div>
    ${ke?.optionsError ? `<p class="pw-help">事件列表读取失败：${esc(ke.optionsError)}</p>` : ''}
    <button class="btn btn-sm" id="ph-ke-edit">添加 / 编辑事件…</button>
  </section>`;
}

async function openKeyEventsModal() {
  const context = workspaceContext();
  let ke = keyEvents;
  try { ke = await API.articleKeyEvents(context.projectId); }
  catch (e) { if (context.isCurrent()) toast(e.message, 'err'); return; }
  if (!context.isCurrent()) return;
  keyEvents = ke;
  const options = [...new Set([...(ke.options || []), ...(ke.selected || [])])];
  const modal = openModal(`
    <div class="modal-head"><h3>关键事件</h3><button class="modal-x" onclick="closeModal()">×</button></div>
    <p class="hint" style="margin-bottom:8px">从 GA4 已收到的事件里勾选（也可手动补一个名字）。转化率 = 所选事件次数 ÷ 浏览。</p>
    ${ke.optionsError ? `<div class="muted" style="font-size:var(--mantine-font-size-xs);margin-bottom:6px">GA4 事件列表拉取失败：${esc(ke.optionsError)}（可手动填写）</div>` : ''}
    <form id="ph-ke-form" class="form-grid">
      <div style="grid-column:1/-1;max-height:260px;overflow:auto;border:1px solid var(--mantine-color-default-border);border-radius:6px;padding:8px">
        ${options.map((n) => `<label style="display:flex;gap:6px;align-items:center;padding:2px 0"><input type="checkbox" name="ev" value="${esc(n)}" ${(ke.selected || []).includes(n) ? 'checked' : ''}> ${esc(n)}</label>`).join('') || '<span class="muted">GA4 还没有可列出的事件</span>'}
      </div>
      <label class="field" style="grid-column:1/-1">
        <span>手动补充（回车分隔多个）</span>
        <input type="text" name="manual" placeholder="例如：generate_lead">
      </label>
    </form>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="ph-ke-save">保存</button>
    </div>`);
  const form = $('#ph-ke-form');
  const btn = $('#ph-ke-save');
  btn.onclick = async () => {
    if (!context.isCurrent() || !modal.isCurrent()) return;
    btn.disabled = true;
    try {
      const checked = [...form.querySelectorAll('input[name=ev]:checked')].map((c) => c.value);
      const manual = (form.querySelector('[name=manual]').value || '').split(/[\n,，]/).map((x) => x.trim()).filter(Boolean);
      const names = [...new Set([...checked, ...manual])].slice(0, 50);
      const out = await API.saveArticleKeyEvents(context.projectId, names);
      toast(`已保存 ${out.selected.length} 个关键事件` + (out.changed ? `（影响站内 ${out.scope?.internal ?? 0} 篇 · 站外 ${out.scope?.external ?? 0} 篇，下次刷新按新清单取数）` : ''), 'ok', 5000);
      modal.close();
      if (context.isCurrent()) await reload();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  };
}

// ============ 站外文章清单 ============
const extState = { q: '', status: '', page: 1, pageSize: 50, total: 0, rows: [], selected: new Set() };

async function renderExternalTab(body, loading = false, firstList = null) {
  body.innerHTML = `<section class="pw-panel pw-catalog"><header class="pw-catalog-head"><div><h3>站外登记清单 <span id="ext-count" class="pw-count"></span></h3><p>维护本项目的外链文章；平台汇总数据请前往站外监控查看。</p></div></header>
    <div class="pw-split"><div class="pw-list-main">${listControls('ext', extState)}
    <div id="ext-table">${loadingRows()}</div><div class="pw-pager" id="ext-pager"></div></div>${entryPanel('ext')}</div></section>`;
  if (loading) { body.querySelector('.pw-catalog').inert = true; return; }
  $('#ext-q').addEventListener('input', debounce((e) => { extState.q = e.target.value; extState.page = 1; extState.selected.clear(); loadExternalList(); }, 250));
  $('#ext-status').onchange = () => { extState.status = $('#ext-status').value; extState.page = 1; extState.selected.clear(); loadExternalList(); };
  $('#ext-batch-on').onclick = () => batchExternalStatus('active');
  $('#ext-batch-off').onclick = () => batchExternalStatus('inactive');
  $('#ext-batch-del').onclick = batchExternalDelete;
  $('#ext-select-clear').onclick = () => { extState.selected.clear(); syncSelectionUI('ext'); };
  $('#ext-select-all').onclick = async () => {
    const btn = $('#ext-select-all'); btn.disabled = true;
    try {
      const ids = []; let page = 1; let total = 0;
      do { const out = await API.externalArticles(projectId, new URLSearchParams({ q: extState.q, status: extState.status, page: String(page++), page_size: '100' })); ids.push(...out.rows.map((r) => r.id)); total = out.total; if (!out.rows.length) break; } while (ids.length < total);
      extState.selected = new Set(ids); syncSelectionUI('ext');
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; }
  };
  $('#ext-titles').onclick = async () => {
    const btn = $('#ext-titles'); btn.disabled = true;
    try { const out = await API.fetchMissingTitles(projectId, 'external'); toast(out.reason === 'empty' ? '没有需要获取的标题' : `标题获取完成：成功 ${out.fetched || 0}，未获取 ${out.failed || 0}`, out.failed ? 'err' : 'ok'); await loadExternalList(); }
    catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; }
  };
  bindAssignmentControls('ext'); bindEntryPanel('ext');
  await loadExternalList(firstList);
}

async function loadExternalList(firstList = null) {
  const box = $('#ext-table');
  if (!box) return;
  const version = ++externalLoadVersion;
  const requestProject = projectId;
  const params = new URLSearchParams({ page: String(extState.page), page_size: String(extState.pageSize) });
  if (extState.q.trim()) params.set('q', extState.q.trim());
  if (extState.status) params.set('status', extState.status);
  try {
    const result = firstList ? await firstList : { data: await API.externalArticles(projectId, params) };
    if (result.error) throw result.error;
    const data = result.data;
    if (version !== externalLoadVersion || !box.isConnected || requestProject !== projectId) return;
    extState.rows = data.rows;
    extState.total = data.total;
    if (!data.rows.length && extState.page > 1) { extState.page = Math.max(1, Math.ceil(data.total / extState.pageSize)); return loadExternalList(); }
    if (!extState.q && !extState.status) { home.externalCount = data.total; const count = $('#ph-external-count'); if (count) count.textContent = String(data.total); }
    $('#ext-count').textContent = `共 ${data.total} 条`;
    box.innerHTML = data.rows.length ? externalTable(data.rows) : `<div class="empty">${extState.q || extState.status ? '没有符合当前筛选条件的站外文章。' : '还没有登记站外文章。点击上方「添加 / 导入」录入或批量导入。'}</div>`;
    if (data.rows.length) bindExternalRows();
    renderExtPager();
    syncSelectionUI('ext');
    highlightDeepLinkedArticle();
  } catch (e) {
    if (box.isConnected && version === externalLoadVersion) {
      box.innerHTML = `<div class="empty" role="alert">加载失败：${esc(e.message)}<p><button class="btn" data-list-retry>重试</button></p></div>`;
      box.querySelector('button').onclick = () => loadExternalList();
    }
  }
}

function externalTable(rows) {
  return `<div class="tbl-wrap pw-table-wrap"><table class="tbl pw-table pw-external-table"><thead><tr><th class="pw-check"><input type="checkbox" id="ext-sel-all" aria-label="全选本页"></th><th class="pw-state">状态</th><th class="pw-title">标题 / 外站地址</th><th class="pw-domain">平台</th><th class="pw-date">发布日期</th><th class="pw-writer">文案师</th><th class="pw-actions">操作</th></tr></thead><tbody>${rows.map((r) => `<tr data-id="${r.id}" data-article-id="${r.id}">
    <td><input type="checkbox" class="ext-sel" data-id="${r.id}" aria-label="选择 ${esc(r.title || r.url)}" ${extState.selected.has(r.id) ? 'checked' : ''}></td><td><span class="pw-status ${r.status === 'active' ? 'is-active' : ''}">${r.status === 'active' ? '启用' : '停用'}</span></td>
    <td class="pw-title-cell"><input class="ext-inline-title" data-id="${r.id}" aria-label="文章标题" title="${esc(r.title || r.url)}" value="${esc(r.title || '')}" placeholder="未设置标题"><a class="pw-url" title="${esc(r.url)}" href="${safeUrl(r.url) || '#'}" target="_blank" rel="noopener">${esc(r.url)}</a></td>
    <td class="pw-domain-cell" title="${esc(r.domain)}">${esc(r.domain)}</td><td><input type="date" class="ext-inline-date" data-id="${r.id}" aria-label="发布日期" value="${esc(r.published_at || '')}"></td><td><select class="ext-inline-cw" data-id="${r.id}" aria-label="文案师">${writerOptions(r.copywriter_id)}</select></td>
    <td class="pw-row-actions"><div class="pw-row-action-buttons"><button class="btn btn-sm ext-toggle" data-id="${r.id}">${r.status === 'active' ? '停用' : '启用'}</button><button class="btn btn-sm ext-edit" data-id="${r.id}">编辑</button><button class="btn btn-sm ext-del" data-id="${r.id}">删除</button></div></td></tr>`).join('')}</tbody></table></div>`;
}

function bindExternalRows() {
  bindExternalInlineEdits();
  $$('.ext-sel').forEach((cb) => {
    cb.onchange = () => {
      const id = Number(cb.dataset.id);
      if (cb.checked) extState.selected.add(id); else extState.selected.delete(id);
      syncSelectionUI('ext');
    };
  });
  const all = $('#ext-sel-all');
  if (all) {
    all.onchange = () => {
      $$('.ext-sel').forEach((cb) => {
        cb.checked = all.checked;
        const id = Number(cb.dataset.id);
        if (all.checked) extState.selected.add(id); else extState.selected.delete(id);
      });
      renderExtBatchBar();
    };
  }
  $$('.ext-edit').forEach((btn) => {
    btn.onclick = () => {
      const row = extState.rows.find((r) => String(r.id) === btn.dataset.id);
      if (row) openExternalArticleModal(row);
    };
  });
  $$('.ext-toggle').forEach((btn) => {
    btn.onclick = async () => {
      const row = extState.rows.find((r) => String(r.id) === btn.dataset.id);
      if (!row) return;
      try {
        await API.setExternalArticleStatus(projectId, row.id, row.status === 'active' ? 'inactive' : 'active');
        await loadExternalList();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  $$('.ext-del').forEach((btn) => {
    btn.onclick = async () => {
      const row = extState.rows.find((r) => String(r.id) === btn.dataset.id);
      if (!row) return;
      const text = `确认删除「${esc(row.url)}」？剩余文章的参考窗口将重排；若这是该平台最后一条登记，平台历史日数据将一并删除且无法恢复。`;
      confirmDialog('删除外链', text, async () => {
        try {
          const out = await API.deleteExternalArticle(projectId, row.id);
          toast(out.cleanedPlatform ? '已删除（平台历史数据已清理）' : '已删除', 'ok');
          await loadExternalList();
        } catch (e) { toast(e.message, 'err'); }
      });
    };
  });
}

function renderExtPager() {
  const pager = $('#ext-pager');
  if (!pager) return;
  const pages = Math.max(1, Math.ceil(extState.total / extState.pageSize));
  if (pages <= 1) { pager.innerHTML = ''; return; }
  pager.innerHTML = `
    <span class="muted">第 ${extState.page} / ${pages} 页</span>
    <button class="btn btn-sm" id="ext-prev" ${extState.page <= 1 ? 'disabled' : ''}>上一页</button>
    <button class="btn btn-sm" id="ext-next" ${extState.page >= pages ? 'disabled' : ''}>下一页</button>`;
  const prev = $('#ext-prev'); const next = $('#ext-next');
  if (prev) prev.onclick = () => { if (extState.page > 1) { extState.page--; loadExternalList(); } };
  if (next) next.onclick = () => { if (extState.page < pages) { extState.page++; loadExternalList(); } };
}

function renderExtBatchBar() {
  const bar = $('#ext-batch-bar'); if (!bar) return;
  const n = extState.selected.size;
  $('#ext-batch-actions').hidden = !n;
  $('#ext-batch-count').textContent = n ? `已选 ${n} 篇` : '未选择文章';
  ['ext-batch-on', 'ext-batch-off', 'ext-batch-del', 'ext-select-clear', 'ext-fill', 'ext-overwrite'].forEach((id) => { const btn = $('#' + id); if (btn) btn.disabled = !n; });
}

function bindExternalInlineEdits() {
  for (const [selector, field] of [['.ext-inline-title', 'title'], ['.ext-inline-date', 'published_at'], ['.ext-inline-cw', 'copywriter_id']]) {
    $$(selector).forEach((input) => bindInlineField(input, field, true));
  }
}

// 单字段保存只更新自身，不重绘清单，避免覆盖其他行正在输入的草稿。
function bindInlineField(input, field, external = false) {
  const articleId = Number(input.dataset.id);
  const ownerProjectId = projectId;
  const normalize = (value) => field === 'copywriter_id' ? (value ? Number(value) : null) : String(value || '').trim();
  let savedValue = normalize(input.value);
  let saving = false;
  let retryButton = null;
  const clearError = () => {
    input.removeAttribute('aria-invalid');
    retryButton?.remove();
    retryButton = null;
  };
  const save = async () => {
    const next = normalize(input.value);
    if (saving) return;
    if (next === savedValue) { clearError(); return; }
    saving = true;
    input.disabled = true;
    input.setAttribute('aria-busy', 'true');
    if (retryButton) retryButton.disabled = true;
    try {
      const patch = { [field]: next };
      const row = external
        ? await API.updateExternalArticle(ownerProjectId, articleId, patch)
        : await API.updateArticle(ownerProjectId, articleId, patch);
      savedValue = normalize(row?.[field] ?? next);
      input.value = savedValue ?? '';
      clearError();
      if (external && projectId === ownerProjectId) {
        const cached = extState.rows.find((item) => Number(item.id) === articleId);
        if (cached) {
          cached[field] = savedValue;
          if (field === 'copywriter_id') cached.copywriter_name = savedValue ? cwName(savedValue) : null;
        }
      }
      if (field === 'title') {
        input.title = `${input.value || '未设置标题'}（回车保存）`;
        const badge = input.parentElement?.querySelector('.tag');
        if (!external && row) {
          const nextBadge = titleStatusBadge(row);
          if (badge) badge.outerHTML = nextBadge;
          else if (nextBadge) input.insertAdjacentHTML('afterend', nextBadge);
        }
      }
      if (input.isConnected) toast('已保存', 'ok', 1500);
    } catch (e) {
      // 保留用户输入和上次保存值，让重试提交同一草稿，Esc 则恢复已保存值。
      if (input.isConnected) {
        input.setAttribute('aria-invalid', 'true');
        if (!retryButton) {
          retryButton = document.createElement('button');
          retryButton.type = 'button';
          retryButton.className = 'pw-inline-retry';
          retryButton.textContent = '保存失败，重试';
          retryButton.onclick = save;
          input.insertAdjacentElement('afterend', retryButton);
        }
        retryButton.title = e.message;
        retryButton.disabled = false;
        toast(`保存失败：${e.message}。输入已保留，可点击重试。`, 'err', 5000);
      }
    } finally {
      saving = false;
      input.disabled = false;
      input.removeAttribute('aria-busy');
    }
  };
  input.addEventListener(field === 'title' ? 'blur' : 'change', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = savedValue ?? ''; clearError(); input.blur(); }
    else if (field === 'title' && e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });
}

function openExternalArticleModal(row) {
  const isEdit = Boolean(row);
  const r = row || { url: '', title: '', anchor_text: '', published_at: '', notes: '', copywriter_id: null, domain_source: 'auto' };
  const cwOptions = writerOptions(r.copywriter_id);
  openModal(`
    <div class="modal-head"><h3>${isEdit ? '编辑外链' : '添加外链'}</h3><button class="modal-x" onclick="closeModal()">×</button></div>
    <form id="ext-form" class="form-grid">
      ${isEdit ? `<label class="field" style="grid-column:1/-1">
        <span>URL（修改后如域名变化将按新平台重新开段）</span>
        <input type="text" name="url" value="${esc(r.url)}">
      </label>` : `<label class="field" style="grid-column:1/-1">
        <span>URL *</span>
        <input type="text" name="url" required placeholder="https://example.com/page">
      </label>`}
      <label class="field">
        <span>标题</span>
        <input type="text" name="title" placeholder="选填" value="${esc(r.title || '')}">
      </label>
      <label class="field">
        <span>文案师</span>
        <select name="copywriter_id" style="width:100%">
          ${cwOptions}
        </select>
      </label>
      <label class="field">
        <span>锚文本</span>
        <input type="text" name="anchor_text" placeholder="选填" value="${esc(r.anchor_text || '')}">
      </label>
      <label class="field">
        <span>发布日期</span>
        <input type="date" name="published_at" value="${esc(r.published_at || '')}">
      </label>
      <label class="field" style="grid-column:1/-1">
        <span>备注</span>
        <textarea name="notes" rows="2" placeholder="选填">${esc(r.notes || '')}</textarea>
      </label>
      ${isEdit && r.domain_source === 'manual' ? '<div class="muted" style="grid-column:1/-1;font-size:var(--mantine-font-size-xs)">该外链使用手工来源域名，改 URL 不会自动改域名；如需从当前 URL 重新推导，请用「重新推导域名」。</div>' : ''}
      ${isEdit ? `<div class="muted" style="grid-column:1/-1;font-size:var(--mantine-font-size-xs)">修改发布日期或平台域名会改变该外链的参考区间；停用会把已过区间冻结，历史数字保留。</div>` : ''}
    </form>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      ${isEdit ? '<button class="btn" id="ext-rederive" title="用当前 URL 的主机名覆盖手工/自动来源域名">重新推导域名</button>' : ''}
      <button class="btn btn-primary" id="ext-save">保存</button>
    </div>`);
  if (isEdit) {
    $('#ext-rederive').onclick = async () => {
      const url = String($('#ext-form [name="url"]').value || '').trim();
      let host = '';
      try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); } catch { /* 非法 URL */ }
      if (!host) return toast('当前 URL 解析不出域名', 'err');
      const btn = $('#ext-rederive');
      btn.disabled = true;
      try {
        // 连着 URL 一起存：只改域名不改地址会留下「地址还是老平台、域名却是新平台」的行
        if (url !== r.url) await API.changeExternalArticleUrl(projectId, r.id, url);
        await API.setExternalArticleDomain(projectId, r.id, host);
        toast('域名已重新推导；参考区间已按新平台重算', 'ok', 4000);
        closeModal();
        await loadExternalList();
      } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
    };
  }
  $('#ext-save').onclick = async () => {
    const d = readForm($('#ext-form'));
    d.copywriter_id = $('#ext-form [name=copywriter_id]').value;
    const btn = $('#ext-save');
    btn.disabled = true;
    try {
      const payload = articleMeta(d, true);
      if (isEdit) {
        if (Number(payload.copywriter_id || 0) === Number(r.copywriter_id || 0)) delete payload.copywriter_id;
        const url = (d.url || '').trim();
        if (url && url !== r.url) await API.changeExternalArticleUrl(projectId, r.id, url);
        await API.updateExternalArticle(projectId, r.id, payload);
        toast('已保存', 'ok');
      } else {
        const url = (d.url || '').trim();
        if (!url) { toast('请输入 URL', 'err'); btn.disabled = false; return; }
        if (!/^https?:\/\//i.test(url)) { toast('外链必须是 http(s):// 绝对地址', 'err'); btn.disabled = false; return; }
        await API.createExternalArticle(projectId, { url, ...payload });
        toast('已添加', 'ok');
      }
      closeModal();
      await loadExternalList();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  };
}

async function batchExternalStatus(status) {
  const ids = [...extState.selected];
  if (!ids.length) return;
  try {
    const out = await API.batchExternalStatus(projectId, ids, status);
    toast(`已完成 ${out.succeeded.length} 条` + (out.failed.length ? `，失败 ${out.failed.length} 条` : ''), out.failed.length ? 'err' : 'ok', 4000);
    extState.selected.clear();
    await loadExternalList();
  } catch (e) { toast(e.message, 'err'); }
}

async function batchExternalDelete() {
  const ids = [...extState.selected];
  if (!ids.length) return;
  const note = '剩余文章的参考窗口将重排；若包含某个平台的最后一条登记，该平台的历史日数据会一并删除且无法恢复。';
  confirmDialog('批量删除外链', `将永久删除选中的 ${ids.length} 条外链及其冻结记录。${note}确定？`, async () => {
    try {
      const out = await API.batchDeleteExternalArticles(projectId, ids);
      const cleaned = out.cleanedDomains?.length ? `，${out.cleanedDomains.length} 个平台的历史数据已清理` : '';
      toast(`已删除 ${out.succeeded.length} 条${cleaned}` + (out.failed.length ? `，失败 ${out.failed.length} 条` : ''), out.failed.length ? 'err' : 'ok', 4000);
      extState.selected.clear();
      await loadExternalList();
    } catch (e) { toast(e.message, 'err'); }
  });
}

async function syncExternalData() {
  const btn = $('#ext-sync');
  if (btn) btn.disabled = true;
  try {
    const out = await API.syncExternalDaily(projectId, {});
    if (out.status === 'error') { toast(`同步失败：${out.error || '未知错误'}`, 'err', 6000); return; }
    const done = out.months.filter((m) => m.users === 'complete' || m.events === 'complete').length;
    toast(`外链同步完成：${done} 个月入库`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
  finally { if (btn) btn.disabled = false; }
}

function executableImportCount(summary, allowRestore = true) {
  return (summary?.new || 0) + (summary?.update || 0) + (allowRestore ? summary?.restored || 0 : 0);
}

function openExternalImportModal() {
  const context = workspaceContext();
  let preview = null;
  let previewRequest = 0;
  const modal = openModal(`
    <div class="modal-head"><h3>批量导入外链</h3><button class="modal-x" onclick="closeModal()">×</button></div>
    <p class="hint" style="margin-bottom:8px">每行一条，支持制表符或逗号分隔。表头可含：URL/标题/锚文本/备注/发布日期/文案师（账号邮箱）/来源域名。外链必须是 http(s):// 绝对地址；来源域名留空则从 URL 自动提取。也可以点「下载模板」按模板填好后上传。</p>
    <textarea id="ext-bulk" rows="8" style="font-family:var(--mantine-font-family-monospace,monospace);font-size:var(--mantine-font-size-sm)" placeholder="url&#9;title&#9;anchor_text&#10;https://a.example.com/1&#9;标题&#9;锚文本"></textarea>
    <label class="chk" style="margin:6px 0"><input type="checkbox" id="ext-restore"> 同时恢复匹配到的已停用外链（默认跳过，不悄悄拉回已停掉的平台）</label>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn" id="ext-template-btn">下载模板</button>
      <button class="btn" id="ext-upload-btn">上传 CSV / TXT / XLSX</button>
      <button class="btn" id="ext-preview-btn">预检</button>
      <button class="btn btn-primary" id="ext-import-ok" disabled>确认导入</button>
    </div>
    <input type="file" id="ext-import-file" accept=".csv,.txt,.xlsx" hidden>
    <div id="ext-preview" style="margin-top:10px"></div>`);
  const restore = $('#ext-restore');
  const confirm = $('#ext-import-ok');
  const current = () => context.isCurrent() && modal.isCurrent();
  const applyPreview = (data) => {
    preview = data;
    renderExtImportPreview(data);
    confirm.disabled = !executableImportCount(data.summary, restore.checked);
  };
  restore.onchange = () => { if (preview && current()) applyPreview(preview); };
  $('#ext-template-btn').onclick = () => downloadTemplate(API.externalArticleTemplateUrl(context.projectId));
  $('#ext-upload-btn').onclick = () => $('#ext-import-file').click();
  $('#ext-import-file').onchange = (event) => handleImportFile(event.target, {
    onText: (text) => {
      if (!current()) return;
      $('#ext-bulk').value = text;
      $('#ext-preview-btn').click();
    },
    onXlsx: async (base64) => {
      if (!current()) return;
      const btn = $('#ext-preview-btn');
      const request = ++previewRequest;
      btn.disabled = true;
      try {
        const data = await API.externalImportPreviewXlsx(context.projectId, base64, restore.checked);
        if (current() && request === previewRequest) applyPreview(data);
      } finally { btn.disabled = false; }
    },
  });
  $('#ext-preview-btn').onclick = async () => {
    if (!current()) return;
    const text = $('#ext-bulk').value;
    if (!text.trim()) return toast('请先粘贴内容', 'err');
    const btn = $('#ext-preview-btn');
    const request = ++previewRequest;
    btn.disabled = true;
    try {
      const data = await API.externalImportPreview(context.projectId, text, restore.checked);
      if (current() && request === previewRequest) applyPreview(data);
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
  };
  $('#ext-import-ok').onclick = async () => {
    if (!current() || !executableImportCount(preview?.summary, restore.checked)) return;
    const btn = confirm;
    btn.disabled = true;
    try {
      const out = await API.externalImportConfirm(context.projectId, preview.items, restore.checked);
      const segs = [`成功 ${out.succeeded.length}`];
      if (out.skipped?.length) segs.push(`跳过 ${out.skipped.length}（未勾选恢复）`);
      if (out.failed.length) segs.push(`失败 ${out.failed.length}`);
      if (out.conflicts?.length) segs.push(`冲突 ${out.conflicts.length}（请重新预检）`);
      toast(`导入完成：${segs.join('，')}`, out.failed.length || out.conflicts?.length ? 'err' : 'ok', 5000);
      if (out.conflicts?.length) { btn.disabled = false; return; }
      modal.close();
      if (context.isCurrent()) await loadExternalList();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  };
}

function renderExtImportPreview(data) {
  const box = $('#ext-preview');
  if (!box) return;
  const { items, summary } = data;
  const badge = (a) => ({
    new: '<span class="tag tag-green">新增</span>',
    update: '<span class="tag tag-blue">更新</span>',
    restored: '<span class="tag tag-amber">恢复</span>',
    duplicate: '<span class="tag tag-gray">重复</span>',
    invalid: '<span class="tag tag-red">无效</span>',
  }[a] || a);
  const rows = items.map((it) => `<tr>
    <td>${it.lineNo}</td>
    <td style="max-width:220px;word-break:break-all">${esc(it.url || '(空)')}</td>
    <td>${badge(it.action)}</td>
    <td>${it.copywriterIssue ? `<span style="color:var(--mantine-color-danger-filled)">${esc(it.copywriterIssue)}</span>` : (it.copywriter ? (it.copywriter.copywriter_id ? esc(extCwName(it.copywriter.user_id) || it.copywriter.user_id) : '<span class="tag tag-amber">启用项目文案师</span>') : '<span class="muted">—</span>')}</td>
    <td class="muted">${esc(it.reason || '')}</td>
  </tr>`).join('');
  box.innerHTML = `
    <div class="muted" style="font-size:var(--mantine-font-size-xs);margin-bottom:6px">新增 ${summary.new} · 更新 ${summary.update} · 恢复 ${summary.restored || 0} · 重复 ${summary.duplicate} · 无效 ${summary.invalid}${summary.enableCopywriter ? ` · 待启用文案师 ${summary.enableCopywriter}` : ''}</div>
    ${summary.restored && !$('#ext-restore').checked ? '<div style="color:var(--mantine-color-warning-filled);font-size:var(--mantine-font-size-xs);margin-bottom:6px">有 ' + summary.restored + ' 条匹配到已停用外链；不勾选「同时恢复」将在导入时跳过。</div>' : ''}
    <div class="tbl-wrap" style="max-height:240px;overflow:auto"><table class="tbl">
      <thead><tr><th>行</th><th>URL</th><th>动作</th><th>文案师</th><th>说明</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">没有可导入的行</td></tr>'}</tbody>
    </table></div>`;
}

function extCwName(userId) {
  const c = copywriters.find((x) => Number(x.user_id) === Number(userId));
  return c ? (c.name || c.email) : null;
}

function writerOptions(selected = null, placeholder = '未指派') {
  const historical = copywriters.find((c) => Number(c.id) === Number(selected) && !Number(c.is_member));
  return `<option value="">${placeholder}</option>${historical ? `<option value="${historical.id}" selected disabled>${esc(historical.name || historical.email)}（已移出）</option>` : ''}${copywriters.filter((c) => Number(c.is_member)).map((c) => `<option value="${c.id}" ${Number(c.id) === Number(selected) ? 'selected' : ''}>${esc(c.name || c.email)}</option>`).join('')}`;
}

function listControls(prefix, filters) {
  const kind = prefix === 'ext' ? '站外' : '站内';
  return `<div class="pw-controls" role="region" aria-label="${kind}文章工具区">
    <div class="pw-toolbar">
      <div class="pw-filters"><input type="search" id="${prefix}-q" aria-label="筛选${kind}文章" placeholder="筛选标题 / URL / ${prefix === 'ext' ? '锚文本' : '关键词'}…" value="${esc(filters.q)}">
        <select id="${prefix}-status" aria-label="${kind}文章状态"><option value="">全部状态</option><option value="active" ${filters.status === 'active' ? 'selected' : ''}>启用</option><option value="inactive" ${filters.status === 'inactive' ? 'selected' : ''}>已停用</option></select>
      </div>
      <div class="pw-list-actions" role="group" aria-label="${kind}文章列表操作"><button class="btn" id="${prefix}-titles">获取缺失标题</button><button type="button" class="btn pw-entry-jump" id="${prefix}-entry-jump" aria-controls="${prefix}-entry-panel">添加 / 导入</button></div>
    </div>
    ${batchBar(prefix)}
  </div>`;
}

function assignmentControls(prefix) {
  return `<div class="pw-assignment" role="group" aria-label="批量指派文案师"><label for="${prefix}-writer">文案师</label><select id="${prefix}-writer" aria-label="批量指派文案师">${writerOptions(null, '选择文案师…')}</select><button class="btn btn-sm" id="${prefix}-fill" disabled title="只填充所选文章中尚未设置文案师的文章">填充未设置</button><button class="btn btn-sm" id="${prefix}-overwrite" disabled title="覆盖全部所选文章的归属；留空可清空归属">覆盖所选…</button></div>`;
}

function batchBar(prefix) {
  const external = prefix === 'ext';
  return `<div class="pw-batch-bar" id="${prefix}-batch-bar">
    <div class="pw-selection-row"><span id="${prefix}-batch-count" role="status" aria-live="polite">未选择文章</span><div class="pw-batch-buttons" role="group" aria-label="选择文章"><button class="btn btn-sm" id="${external ? 'ext-select-all' : 'ph-sel-all-matched'}">全选当前筛选结果</button><button class="btn btn-sm" id="${external ? 'ext-select-clear' : 'ph-sel-clear'}" disabled>清除选择</button></div></div>
    <div class="pw-batch-actions" id="${prefix}-batch-actions" role="group" aria-label="所选文章的批量操作" hidden>
      ${assignmentControls(prefix)}
      <div class="pw-batch-buttons pw-status-actions" role="group" aria-label="修改文章状态"><button class="btn btn-sm" id="${prefix}-batch-on" disabled>批量启用</button><button class="btn btn-sm" id="${prefix}-batch-off" disabled>批量停用</button><button class="btn btn-sm btn-danger" id="${prefix}-batch-del" disabled>批量删除</button></div>
    </div></div>`;
}

function bindAssignmentControls(prefix) {
  const run = async (mode) => {
    const current = prefix === 'ph' ? state : extState;
    const ids = [...current.selected]; if (!ids.length) return;
    const raw = $('#' + prefix + '-writer').value;
    if (!raw && mode === 'fill_empty') return toast('请先选择文案师', 'err');
    const writer = raw ? Number(raw) : null;
    const save = async () => {
      try {
        const out = prefix === 'ph' ? await API.assignCopywriters(projectId, ids, writer, mode) : await API.batchExternalAssign(projectId, ids, writer, mode);
        toast(`已更新 ${out.updated ?? out.succeeded?.length ?? 0} 篇文章归属`, out.failed?.length || out.rejected?.length ? 'err' : 'ok');
        current.selected.clear(); prefix === 'ph' ? await loadArticles() : await loadExternalList();
      } catch (e) { toast(e.message, 'err'); }
    };
    if (mode === 'overwrite') confirmDialog('覆盖所选文章的文案师', `将${writer ? '修改' : '清空'}全部 ${ids.length} 篇所选文章的文案师归属，已有归属也会被覆盖。确认继续？`, save);
    else await save();
  };
  $('#' + prefix + '-fill').onclick = () => run('fill_empty');
  $('#' + prefix + '-overwrite').onclick = () => run('overwrite');
}

function entryPanel(prefix) {
  const external = prefix === 'ext';
  return `<aside class="pw-entry" id="${prefix}-entry-panel" aria-label="添加与导入文章"><section class="pw-entry-main"><h4>添加单篇${external ? '站外文章' : '站内文章'}</h4><p class="pw-entry-hint">只填 URL 即可添加，其他信息可选填。</p><form class="pw-entry-form" id="${prefix}-entry-form">
      <label class="pw-entry-field pw-entry-span"><span>URL *</span><input name="url" type="text" required placeholder="${external ? 'https://example.com/page' : 'https://example.com/page 或 /page'}"></label>
      <label class="pw-entry-field"><span>标题</span><input name="title" type="text" placeholder="可选填"></label>
      <label class="pw-entry-field"><span>文案师</span><select name="copywriter_id">${writerOptions()}</select></label>
      <label class="pw-entry-field"><span>${external ? '锚文本' : '关键词'}</span><input name="${external ? 'anchor_text' : 'keyword'}" type="text" placeholder="${external ? '可选填' : '用于搜索'}"></label>
      <label class="pw-entry-field"><span>发布日期</span><input name="published_at" type="date"></label>
      ${external ? '<label class="pw-entry-field pw-entry-span"><span>备注</span><textarea name="notes" rows="2" placeholder="可选填"></textarea></label>' : ''}
      <div class="pw-entry-submit pw-entry-span"><button class="btn btn-primary" type="submit">添加${external ? '站外' : '站内'}文章</button></div>
    </form></section>
    <section class="pw-import-panel"><h4>批量导入${external ? '站外文章' : '站内文章'}</h4><textarea id="${prefix}-quick-bulk" rows="6" aria-label="批量导入文章内容" placeholder="从 Excel 复制粘贴 URL、标题、发布日期、文案师等列（含表头）；也可每行只粘贴一个 URL"></textarea><p>支持 CSV、TXT 和 XLSX。文案师请填写已有账号邮箱；导入前会展示预检结果，确认后保存。</p><div class="pw-import-actions"><button class="btn btn-primary btn-sm" id="${prefix}-quick-preview">导入粘贴内容</button><button class="btn btn-sm" id="${prefix}-quick-upload">上传文件</button><button class="btn btn-sm" id="${prefix}-quick-template">下载模板</button></div></section></aside>`;
}

function articleMeta(data, external) {
  return {
    title: (data.title || '').trim(),
    [external ? 'anchor_text' : 'keyword']: (data[external ? 'anchor_text' : 'keyword'] || '').trim(),
    published_at: (data.published_at || '').trim(),
    notes: (data.notes || '').trim(),
    copywriter_id: data.copywriter_id ? Number(data.copywriter_id) : null,
  };
}

function assertInternalArticleCreated(result) {
  if (result?.created === 1 && !result.invalid?.length && !result.failed?.length && !result.unprocessed?.length) return;
  const issue = [...(result?.invalid || []), ...(result?.failed || [])].find((item) => item?.reason);
  throw new Error(issue?.reason || (result?.unprocessed?.length ? '文章尚未处理，请重试' : '文章未添加，请检查 URL 和文案师'));
}

function bindEntryPanel(prefix) {
  const external = prefix === 'ext';
  const modal = external ? openExternalImportModal : openImportModal;
  $('#' + prefix + '-entry-jump').onclick = () => {
    const panel = $('#' + prefix + '-entry-panel');
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    panel.querySelector('input[name=url]').focus({ preventScroll: true });
  };
  $('#' + prefix + '-entry-form').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = form.querySelector('button[type=submit]');
    const data = readForm(form);
    const url = (data.url || '').trim();
    if (!url) return toast('请输入 URL', 'err');
    if (external && !/^https?:\/\//i.test(url)) return toast('外链必须是 http(s):// 绝对地址', 'err');
    btn.disabled = true;
    try {
      const payload = { url, ...articleMeta(data, external) };
      if (external) await API.createExternalArticle(projectId, payload);
      else assertInternalArticleCreated(await API.createArticle(projectId, payload));
      const countKey = external ? 'externalCount' : 'articleCount';
      const count = $('#' + (external ? 'ph-external-count' : 'ph-article-count'));
      home[countKey] = Number(home[countKey] || 0) + 1;
      if (count) count.textContent = String(home[countKey]);
      form.reset();
      toast('文章已添加', 'ok');
      if (external) await loadExternalList();
      else await loadArticles();
      form.querySelector('input[name=url]').focus();
    }
    catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; }
  };
  $('#' + prefix + '-quick-preview').onclick = () => {
    const text = $('#' + prefix + '-quick-bulk').value;
    if (!text.trim()) return toast('请先粘贴文章内容', 'err');
    modal(); $('#' + prefix + '-bulk').value = text; $('#' + prefix + '-preview-btn').click();
  };
  $('#' + prefix + '-quick-upload').onclick = () => { modal(); $('#' + prefix + '-import-file').click(); };
  $('#' + prefix + '-quick-template').onclick = () => downloadTemplate(external ? API.externalArticleTemplateUrl(projectId) : API.articleImportTemplateUrl(projectId));
}

function syncSelectionUI(prefix) {
  const current = prefix === 'ph' ? state : extState;
  $$('.' + prefix + '-sel').forEach((cb) => { cb.checked = current.selected.has(Number(cb.dataset.id)); });
  const all = $('#' + prefix + '-sel-all');
  const checked = $$('.' + prefix + '-sel:checked').length;
  const count = $$('.' + prefix + '-sel').length;
  if (all) { all.checked = !!count && count === checked; all.indeterminate = checked > 0 && checked < count; }
  if (prefix === 'ph') bindBatchBar(); else renderExtBatchBar();
}

function renderTabBody(loading = false, firstList = null) {
  const body = $('#ph-tab-body'); if (!body) return;
  body.setAttribute('aria-labelledby', `ph-tab-${state.tab}`);
  if (state.tab === 'settings') { if (loading) body.innerHTML = `<section class="pw-panel"><h3>文案师与监控</h3>${loadingRows(['连接与同步', '文案师名单', '关键事件'])}</section>`; else renderMonitorSettings(body); return; }
  if (state.tab === 'external') { renderExternalTab(body, loading, firstList); return; }
  body.innerHTML = `<section class="pw-panel pw-catalog"><header class="pw-catalog-head"><div><h3>站内文章清单 <span class="pw-count" id="ph-count"></span></h3><p>此处文章进入站内文章监控，可维护标题、发布日期和文案师。</p></div></header>
    <div class="pw-split"><div class="pw-list-main">${listControls('ph', state)}
    <div id="ph-table">${loadingRows()}</div><div class="pw-pager" id="ph-pager"></div></div>${entryPanel('ph')}</div></section>`;
  if (loading) { body.querySelector('.pw-catalog').inert = true; return; }
  $('#ph-q').addEventListener('input', debounce((e) => { state.q = e.target.value; state.page = 1; state.selected.clear(); state.selectedAll = false; loadArticles(); }, 250));
  $('#ph-status').onchange = (e) => { state.status = e.target.value; state.page = 1; state.selected.clear(); state.selectedAll = false; loadArticles(); };
  $('#ph-titles').onclick = runTitleFetch;
  $('#ph-batch-on').onclick = () => batchStatus('active'); $('#ph-batch-off').onclick = () => batchStatus('inactive'); $('#ph-batch-del').onclick = batchDelete;
  bindAssignmentControls('ph'); bindEntryPanel('ph'); loadArticles(firstList);
}

// 服务端分页/搜索：1000 篇不进 DOM
async function loadArticles(firstList = null) {
  const table = $('#ph-table');
  if (!table) return;
  const version = ++internalLoadVersion;
  const requestProject = projectId;
  const params = new URLSearchParams({ page: String(state.page), page_size: String(state.pageSize) });
  if (state.q.trim()) params.set('q', state.q.trim());
  if (state.status) params.set('status', state.status);
  let data;
  try {
    const result = firstList ? await firstList : { data: await API.projectArticles(projectId, params) };
    if (result.error) throw result.error;
    data = result.data;
  } catch (e) {
    if (table.isConnected && version === internalLoadVersion) {
      table.innerHTML = `<div class="empty" role="alert">加载失败：${esc(e.message)}<p><button class="btn" data-list-retry>重试</button></p></div>`;
      table.querySelector('button').onclick = () => loadArticles();
    }
    return;
  }
  if (version !== internalLoadVersion || !table.isConnected || requestProject !== projectId) return;
  state.total = data.total;
  if (!data.rows.length && state.page > 1) { state.page = Math.max(1, Math.ceil(data.total / state.pageSize)); return loadArticles(); }
  if (!state.q && !state.status) { home.articleCount = data.total; const count = $('#ph-article-count'); if (count) count.textContent = String(data.total); }
  $('#ph-count').textContent = `共 ${data.total} 篇`;

  table.innerHTML = data.rows.length ? articleTable(data.rows) : `
    <div class="empty">
      ${state.q || state.status ? '没有符合当前筛选条件的站内文章。' : '还没有登记站内文章。<br><span class="muted">使用添加 / 导入区录入单篇文章或批量导入。</span>'}
    </div>`;

  if (data.rows.length) bindArticleRowActions();
  renderPager(data);
  syncSelectionUI('ph');
  highlightDeepLinkedArticle();
}

function renderPager(data) {
  const pager = $('#ph-pager');
  if (!pager) return;
  const pages = Math.max(1, Math.ceil(data.total / state.pageSize));
  if (pages <= 1) { pager.innerHTML = ''; return; }
  pager.innerHTML = `
    <span class="muted">第 ${data.page} / ${pages} 页</span>
    <button class="btn btn-sm" id="ph-prev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button>
    <button class="btn btn-sm" id="ph-next" ${data.page >= pages ? 'disabled' : ''}>下一页</button>`;
  const prev = $('#ph-prev'); const next = $('#ph-next');
  if (prev) prev.onclick = () => { if (state.page > 1) { state.page--; loadArticles(); } };
  if (next) next.onclick = () => { if (state.page < pages) { state.page++; loadArticles(); } };
}

function articleTable(rows) {
  return `<div class="tbl-wrap pw-table-wrap"><table class="tbl pw-table"><thead><tr><th class="pw-check"><input type="checkbox" id="ph-sel-all" aria-label="全选本页"></th>${canInlineEdit() ? '<th class="pw-drag"></th>' : ''}<th class="pw-state">状态</th><th class="pw-title">标题 / URL</th><th class="pw-date">发布日期</th><th class="pw-writer">文案师</th><th class="pw-actions">操作</th></tr></thead><tbody>${rows.map(articleRow).join('')}</tbody></table></div>`;
}

// 入参是文章上的 copywriter_id（名单行 id），不是 user_id
function cwName(copywriterId) {
  const c = copywriters.find((x) => Number(x.id) === Number(copywriterId));
  return c ? (c.name || c.email) : null;
}

// 导入预览的文案师列拿到的是账号 user_id（解析阶段按邮箱匹配账号），
// 这里必须按 user_id 反查名单行——按 copywriter_id 查会把名单行 id 当账号 id，
// 两个 id 不一致时就显示成别人的名字。
function cwNameByUser(userId) {
  const c = copywriters.find((x) => Number(x.user_id) === Number(userId));
  return c ? (c.name || c.email) : null;
}

// 行内可编辑：只在「全部状态 + 无搜索」时允许（有筛选/搜索时
// 行的可见集合会变，拖拽与行内编辑的「当前列表」语义不成立）
function canInlineEdit() {
  return !state.q.trim() && !state.status;
}

function articleRow(r) {
  const href = safeUrl(r.url); const inline = canInlineEdit();
  const history = (r.url_history || []).length ? `<span class="pw-history" title="曾用地址：${esc(r.url_history.join('、'))}">历史 ${r.url_history.length}</span>` : '';
  return `<tr data-id="${r.id}" data-article-id="${r.id}" ${inline ? 'draggable="true"' : ''}>
    <td><input type="checkbox" class="ph-sel" data-id="${r.id}" aria-label="选择 ${esc(r.title || r.url)}" ${state.selected.has(r.id) ? 'checked' : ''}></td>${inline ? '<td class="ph-drag" title="拖动排序">⠿</td>' : ''}
    <td><span class="pw-status ${r.status === 'active' ? 'is-active' : ''}">${r.status === 'active' ? '启用' : '停用'}</span></td>
    <td class="pw-title-cell"><div class="pw-title-line">${inline ? `<input class="ph-inline-title" data-id="${r.id}" value="${esc(r.title || '')}" placeholder="未设置标题" aria-label="文章标题" title="${esc(r.title || r.url)}（回车保存）">` : `<strong class="pw-title-text" title="${esc(r.title || r.url)}">${esc(r.title || '未设置标题')}</strong>`}${titleStatusBadge(r)}</div><div class="pw-url-line">${href ? `<a class="pw-url" href="${href}" target="_blank" rel="noopener" title="${esc(r.url)}">${esc(r.url)}</a>` : `<span class="pw-url" title="${esc(r.url)}">${esc(r.url)}</span>`}${history}</div></td>
    <td>${inline ? `<input type="date" class="ph-inline-date" data-id="${r.id}" value="${esc(r.published_at || '')}" aria-label="发布日期">` : esc(r.published_at || '—')}</td>
    <td>${inline ? `<select class="ph-inline-cw" data-id="${r.id}" aria-label="文案师">${writerOptions(r.copywriter_id)}</select>` : esc(cwName(r.copywriter_id) || '未指派')}</td>
    <td class="pw-row-actions"><div class="pw-row-action-buttons"><button class="btn btn-sm ph-toggle" data-id="${r.id}">${r.status === 'active' ? '停用' : '启用'}</button><button class="btn btn-sm ph-url" data-id="${r.id}" title="登记 301 后的新地址，保留历史指标">301 改址</button><button class="btn btn-sm ph-del" data-id="${r.id}">删除</button><details class="pw-more"><summary aria-label="更多操作">···</summary><div><button class="ph-edit" data-id="${r.id}">编辑全部信息</button><button class="ph-title-fetch" data-id="${r.id}">重新获取标题</button><button class="ph-sync" data-id="${r.id}">同步文章数据</button></div></details></div></td>
  </tr>`;
}

// 行内编辑：标题（Enter 存 / Esc 还原）、发布日期（change 存）、文案师（change 存）
function bindInlineEdits() {
  for (const [selector, field] of [['.ph-inline-title', 'title'], ['.ph-inline-date', 'published_at'], ['.ph-inline-cw', 'copywriter_id']]) {
    $$(selector).forEach((input) => bindInlineField(input, field));
  }
}

// 拖拽排序（HTML5 DnD）：只有全部状态 + 无搜索时可拖；PUT /articles/order
function bindDragSort() {
  const table = $('#ph-table table');
  if (!table) return;
  let dragId = null;
  $$('#ph-table tbody tr').forEach((tr) => {
    tr.addEventListener('dragstart', (e) => { dragId = Number(tr.dataset.id); e.dataTransfer.effectAllowed = 'move'; });
    tr.addEventListener('dragover', (e) => { e.preventDefault(); tr.style.opacity = '0.5'; });
    tr.addEventListener('dragleave', () => { tr.style.opacity = ''; });
    tr.addEventListener('drop', async (e) => {
      e.preventDefault();
      tr.style.opacity = '';
      const targetId = Number(tr.dataset.id);
      if (!dragId || dragId === targetId) return;
      const ids = $$('#ph-table tbody tr').map((x) => Number(x.dataset.id));
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) return;
      ids.splice(to, 0, ...ids.splice(from, 1));
      try {
        const out = await API.reorderArticles(projectId, ids);
        toast(`排序已更新（${out.updated} 篇）`, 'ok', 2000);
        await loadArticles();
      } catch (e2) { toast(`排序失败：${e2.message}`, 'err'); }
    });
  });
}

let pageRows = [];
function bindArticleRowActions() {
  bindRowMenus($('#ph-table'), '.pw-more', '.pw-table-wrap');
  pageRows = $$('#ph-table tbody tr').map((tr) => Number(tr.dataset.id));
  $$('.ph-edit').forEach((btn) => {
    btn.onclick = async () => {
      const row = await API.article(projectId, btn.dataset.id);
      if (row) openArticleModal(row);
    };
  });
  $$('.ph-title-fetch').forEach((btn) => {
    btn.onclick = () => refetchRowTitle(Number(btn.dataset.id));
  });
  bindInlineEdits();
  bindDragSort();
  $$('.ph-url').forEach((btn) => {
    btn.onclick = async () => {
      const row = await API.article(projectId, btn.dataset.id);
      if (row) openChangeUrlModal(row);
    };
  });
  $$('.ph-sync').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.id);
      btn.disabled = true;
      try {
        const out = await API.syncArticle(projectId, id);
        if (out.status === 'error') { toast(`同步失败：${out.error || '未知错误'}`, 'err', 6000); btn.disabled = false; return; }
        const bad = out.months.filter((m) => m.gsc === 'error' || m.ga4 === 'error' || m.gsc === 'truncated' || m.ga4 === 'truncated').length;
        const done = out.months.filter((m) => m.gsc === 'complete' || m.ga4 === 'complete').length;
        toast(`同步完成：${done} 个月有更新` + (bad ? `，${bad} 个月抓取失败` : ''), bad ? 'err' : 'ok', 5000);
        await loadArticles();
      } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
    };
  });
  $$('.ph-toggle').forEach((btn) => {
    btn.onclick = async () => {
      const row = await API.article(projectId, btn.dataset.id);
      if (!row) return;
      try {
        await API.setArticleStatus(projectId, row.id, row.status === 'active' ? 'inactive' : 'active');
        await loadArticles();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  $$('.ph-del').forEach((btn) => {
    btn.onclick = () => {
      const id = Number(btn.dataset.id);
      confirmDialog('删除文章', '将删除该文章及其全部历史数据。确定？', async () => {
        try { await API.deleteArticle(projectId, id); toast('已删除', 'ok'); await reload(); }
        catch (e) { toast(e.message, 'err'); }
      });
    };
  });
  const selAll = $('#ph-sel-all');
  if (selAll) {
    selAll.onchange = () => {
      $$('.ph-sel').forEach((cb) => {
        cb.checked = selAll.checked;
        const id = Number(cb.dataset.id);
        if (selAll.checked) state.selected.add(id); else state.selected.delete(id);
      });
      bindBatchBar();
    };
  }
  $$('.ph-sel').forEach((cb) => {
    cb.onchange = () => {
      const id = Number(cb.dataset.id);
      if (cb.checked) state.selected.add(id); else { state.selected.delete(id); state.selectedAll = false; }
      syncSelectionUI('ph');
    };
  });
}

function bindBatchBar() {
  const bar = $('#ph-batch-bar'); if (!bar) return;
  const n = state.selected.size;
  $('#ph-batch-actions').hidden = !n;
  $('#ph-batch-count').textContent = n ? `已选 ${n} 篇${state.selectedAll ? '（全部结果）' : ''}` : '未选择文章';
  ['ph-batch-on', 'ph-batch-off', 'ph-batch-del', 'ph-sel-clear', 'ph-fill', 'ph-overwrite'].forEach((id) => { const btn = $('#' + id); if (btn) btn.disabled = !n; });
  const all = $('#ph-sel-all-matched');
  all.onclick = async () => {
    all.disabled = true;
    try {
      const params = new URLSearchParams({ ids_only: '1', q: state.q, status: state.status });
      const data = await API.projectArticles(projectId, params); state.selected = new Set(data.ids.map(Number)); state.selectedAll = true; syncSelectionUI('ph');
    } catch (e) { toast(e.message, 'err'); } finally { all.disabled = false; }
  };
  $('#ph-sel-clear').onclick = () => { state.selected.clear(); state.selectedAll = false; syncSelectionUI('ph'); };
}

async function batchStatus(status) {
  const ids = [...state.selected];
  if (!ids.length) return;
  try {
    const out = await API.batchArticleStatus(projectId, ids, status);
    toast(`已完成 ${out.updated ?? out.succeeded?.length ?? 0} 篇` + (out.failed?.length ? `，失败 ${out.failed.length} 篇` : ''), out.failed?.length ? 'err' : 'ok');
    state.selected.clear(); state.selectedAll = false;
    await loadArticles();
  } catch (e) { toast(e.message, 'err'); }
}

async function batchDelete() {
  const ids = [...state.selected];
  if (!ids.length) return;
  confirmDialog('批量删除', `将删除选中的 ${ids.length} 篇文章及其全部历史数据。确定？`, async () => {
    try {
      const out = await API.batchDeleteArticles(projectId, ids);
      toast(`已删除 ${out.deleted ?? out.succeeded?.length ?? 0} 篇` + (out.failed?.length ? `，失败 ${out.failed.length} 篇` : ''), out.failed?.length ? 'err' : 'ok', 4000);
      await reload();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ============ 新增 / 编辑文章 ============
function openArticleModal(row) {
  const isEdit = Boolean(row);
  const r = row || { url: '', title: '', keyword: '', published_at: '', notes: '', copywriter_id: null };
  const notOnRoster = candidates.filter((c) => !Number(c.on_roster));
  const cwOptions = writerOptions(r.copywriter_id);
  openModal(`
    <div class="modal-head"><h3>${isEdit ? '编辑文章' : '添加文章'}</h3><button class="modal-x" onclick="closeModal()">×</button></div>
    <form id="ph-form" class="form-grid">
      ${isEdit ? '' : `<label class="field" style="grid-column:1/-1">
        <span>URL *</span>
        <input type="text" name="url" required placeholder="https://example.com/page 或 /page">
      </label>`}
      <label class="field">
        <span>标题</span>
        <input type="text" name="title" placeholder="留空则界面显示 URL" value="${esc(r.title || '')}">
      </label>
      <label class="field">
        <span>文案师</span>
        <select name="copywriter_id" style="width:100%">
          ${cwOptions}
        </select>
      </label>
      <label class="field">
        <span>关键词</span>
        <input type="text" name="keyword" placeholder="选填" value="${esc(r.keyword || '')}">
      </label>
      <label class="field">
        <span>发布日期</span>
        <input type="date" name="published_at" value="${esc(r.published_at || '')}">
      </label>
      <label class="field" style="grid-column:1/-1">
        <span>备注</span>
        <textarea name="notes" rows="2" placeholder="选填">${esc(r.notes || '')}</textarea>
      </label>
      ${isEdit && notOnRoster.length ? `<div class="muted" style="grid-column:1/-1;font-size:var(--mantine-font-size-xs)">提示：还有 ${notOnRoster.length} 个账号不在文案师名单，加入名单后才可指派。</div>` : ''}
    </form>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="ph-save">保存</button>
    </div>`);

  $('#ph-save').onclick = async () => {
    const d = readForm($('#ph-form'));
    d.copywriter_id = $('#ph-form [name=copywriter_id]').value;
    const meta = articleMeta(d, false);
    const btn = $('#ph-save');
    btn.disabled = true;
    try {
      if (isEdit) {
        if (Number(meta.copywriter_id || 0) === Number(r.copywriter_id || 0)) delete meta.copywriter_id;
        await API.updateArticle(projectId, row.id, meta);
        toast('已保存', 'ok');
      } else {
        const url = (d.url || '').trim();
        if (!url) { toast('请输入 URL', 'err'); btn.disabled = false; return; }
        assertInternalArticleCreated(await API.createArticle(projectId, { url, ...meta }));
        toast('已添加', 'ok');
      }
      closeModal();
      await reload();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  };
}

// ============ 改址（历史保留 + 认领规则在服务端） ============
async function openChangeUrlModal(row) {
  let history = [];
  try { history = await API.articleUrlHistory(projectId, row.id); } catch { /* 历史可选展示 */ }
  openModal(`
    <div class="modal-head"><h3>修改地址</h3><button class="modal-x" onclick="closeModal()">×</button></div>
    <form id="ph-url-form" class="form-grid">
      <label class="field" style="grid-column:1/-1">
        <span>当前地址</span>
        <input type="text" value="${esc(row.url)}" disabled>
      </label>
      <label class="field" style="grid-column:1/-1">
        <span>新地址 *</span>
        <input type="text" name="url" required placeholder="https://example.com/new 或 /new">
      </label>
    </form>
    ${history.length ? `<div class="muted" style="font-size:var(--mantine-font-size-xs);margin-top:8px">曾用地址（保留历史指标，改址不删数据）：${history.map((h) => esc(h.url)).join('、')}</div>` : ''}
    <p class="hint" style="margin-top:8px">改地址会保留旧地址的历史数据；若新地址是别的文章的曾用地址，将归到本篇名下。</p>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="ph-url-save">保存</button>
    </div>`);
  $('#ph-url-save').onclick = async () => {
    const input = $('#ph-url-form').querySelector('[name=url]');
    const next = (input.value || '').trim();
    if (!next) { toast('请输入新地址', 'err'); return; }
    const btn = $('#ph-url-save');
    btn.disabled = true;
    try {
      await API.changeArticleUrl(projectId, row.id, next);
      toast('已改址', 'ok');
      closeModal();
      await reload();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  };
}

// ============ 批量导入：预检（零写）→ 确认 ============
// 上传文件走两条路：CSV/TXT 读成文本回填输入框（用户还能手改，和无上传时完全一致），
// XLSX 直接把字节送预检——服务端只认模板里的「填写区」工作表，读不了会给出明确报错。
const IMPORT_MAX_TEXT_BYTES = 256 * 1024;
const IMPORT_MAX_XLSX_BYTES = 5 * 1024 * 1024;

function fileToText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file, 'utf-8');
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

// input 的 change 处理器：选完文件立即清空 value，否则同一个文件第二次选不触发 change
async function handleImportFile(input, { onText, onXlsx, busy }) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const isXlsx = file.name.toLowerCase().endsWith('.xlsx');
  if (busy && busy()) return;
  if (file.size > (isXlsx ? IMPORT_MAX_XLSX_BYTES : IMPORT_MAX_TEXT_BYTES)) {
    return toast(isXlsx ? '导入文件不能超过 5 MB' : '导入内容不能超过 256 KB', 'err');
  }
  try {
    if (isXlsx) await onXlsx(await fileToBase64(file));
    else await onText(await fileToText(file));
  } catch (e) { toast(e.message, 'err'); }
}

function downloadTemplate(url) {
  window.open(url, '_blank');
}

function openImportModal() {
  const context = workspaceContext();
  let preview = null;
  let previewRequest = 0;
  const modal = openModal(`
    <div class="modal-head"><h3>批量导入文章</h3><button class="modal-x" onclick="closeModal()">×</button></div>
    <p class="hint" style="margin-bottom:8px">每行一条，支持制表符（Excel 粘贴）或逗号分隔。表头可含：URL/标题/关键词/备注/发布日期/文案师（账号邮箱）。文案师只能填已有账号邮箱。也可以点「下载模板」按模板填好后上传（XLSX 会自动读「填写区」工作表）。</p>
    <textarea id="ph-bulk" rows="8" style="font-family:var(--mantine-font-family-monospace,monospace);font-size:var(--mantine-font-size-sm)" placeholder="url&#9;title&#9;published_at&#9;copywriter&#10;/a&#9;标题A&#9;2026-08-01&#9;writer@example.com"></textarea>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn" id="ph-template-btn">下载模板</button>
      <button class="btn" id="ph-upload-btn">上传 CSV / TXT / XLSX</button>
      <button class="btn" id="ph-preview-btn">预检</button>
      <button class="btn btn-primary" id="ph-import-ok" disabled>确认导入</button>
    </div>
    <input type="file" id="ph-import-file" accept=".csv,.txt,.xlsx" hidden>
    <div id="ph-preview" style="margin-top:10px"></div>`);
  const confirm = $('#ph-import-ok');
  const current = () => context.isCurrent() && modal.isCurrent();
  const applyPreview = (data) => {
    preview = data;
    renderImportPreview(data);
    confirm.disabled = !executableImportCount(data.summary);
  };
  $('#ph-template-btn').onclick = () => downloadTemplate(API.articleImportTemplateUrl(context.projectId));
  $('#ph-upload-btn').onclick = () => $('#ph-import-file').click();
  $('#ph-import-file').onchange = (event) => handleImportFile(event.target, {
    onText: (text) => {
      if (!current()) return;
      $('#ph-bulk').value = text;
      $('#ph-preview-btn').click();
    },
    onXlsx: async (base64) => {
      if (!current()) return;
      const btn = $('#ph-preview-btn');
      const request = ++previewRequest;
      btn.disabled = true;
      try {
        const data = await API.importArticlesPreviewXlsx(context.projectId, base64);
        if (current() && request === previewRequest) applyPreview(data);
      } finally { btn.disabled = false; }
    },
  });
  $('#ph-preview-btn').onclick = async () => {
    if (!current()) return;
    const text = $('#ph-bulk').value;
    if (!text.trim()) return toast('请先粘贴内容', 'err');
    const btn = $('#ph-preview-btn');
    const request = ++previewRequest;
    btn.disabled = true;
    try {
      const data = await API.importArticlesPreview(context.projectId, text);
      if (current() && request === previewRequest) applyPreview(data);
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
  };
  $('#ph-import-ok').onclick = async () => {
    if (!current() || !executableImportCount(preview?.summary)) return;
    const btn = confirm;
    btn.disabled = true;
    try {
      const out = await API.importArticlesConfirm(context.projectId, preview.items);
      const parts = [`成功 ${out.succeeded.length}`];
      if (out.failed.length) parts.push(`失败 ${out.failed.length}`);
      if (out.conflicts?.length) parts.push(`冲突 ${out.conflicts.length}（请重新预检）`);
      toast(`导入完成：${parts.join('，')}`, out.failed.length || out.conflicts?.length ? 'err' : 'ok', 5000);
      if (out.conflicts?.length) { btn.disabled = false; return; }
      modal.close();
      if (context.isCurrent()) await reload();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  };
}

function renderImportPreview(data) {
  const box = $('#ph-preview');
  if (!box) return;
  const { items, summary } = data;
  const badge = (a) => ({
    new: '<span class="tag tag-green">新增</span>',
    update: '<span class="tag tag-blue">更新</span>',
    restored: '<span class="tag tag-amber">恢复</span>',
    duplicate: '<span class="tag tag-gray">重复</span>',
    invalid: '<span class="tag tag-red">无效</span>',
  }[a] || a);
  const rows = items.map((it) => `<tr>
    <td>${it.lineNo}</td>
    <td style="max-width:220px;word-break:break-all">${esc(it.url || '(空)')}</td>
    <td>${badge(it.action)}</td>
    <td>${it.copywriterIssue ? `<span style="color:var(--mantine-color-danger-filled)">${esc(it.copywriterIssue)}</span>` : (it.copywriter ? (it.copywriter.copywriter_id ? esc(cwNameByUser(it.copywriter.user_id) || it.copywriter.user_id) : '<span class="tag tag-amber">启用项目文案师</span>') : '<span class="muted">—</span>')}</td>
    <td class="muted">${esc(it.reason || '')}</td>
  </tr>`).join('');
  box.innerHTML = `
    <div class="muted" style="font-size:var(--mantine-font-size-xs);margin-bottom:6px">新增 ${summary.new} · 更新 ${summary.update} · 恢复 ${summary.restored || 0} · 重复 ${summary.duplicate} · 无效 ${summary.invalid}${summary.enableCopywriter ? ` · 待启用文案师 ${summary.enableCopywriter}` : ''}</div>
    <div class="tbl-wrap" style="max-height:260px;overflow:auto"><table class="tbl">
      <thead><tr><th>行</th><th>URL</th><th>动作</th><th>文案师</th><th>说明</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">没有可导入的行</td></tr>'}</tbody>
    </table></div>`;
}

// ============ 获取缺失标题（项目级：处理全部启用且标题为空的文章） ============
async function runTitleFetch() {
  const btn = $('#ph-titles');
  if (!btn) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在获取…';
  try {
    const out = await API.fetchMissingTitles(projectId, 'internal');
    if (out.reason === 'empty') { toast('没有需要获取的标题（启用且标题为空）', 'ok'); return; }
    const parts = [];
    if (out.fetched) parts.push(`成功 ${out.fetched}`);
    if (out.failed) parts.push(`未获取 ${out.failed}`);
    if (out.busy) parts.push(`跳过 ${out.busy}`);
    if (out.remaining) parts.push(`剩余 ${out.remaining}（再点一次继续）`);
    const firstError = out.errors?.[0];
    toast(`标题获取完成：${parts.join('，') || '无变化'}` + (firstError ? `（例：${firstError.error}）` : ''), out.failed ? 'err' : 'ok', 6000);
    await loadArticles();
  } catch (e) {
    toast(e.message, 'err', 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// 单篇获取/重试标题（行内按钮）
async function refetchRowTitle(articleId) {
  const btn = document.querySelector(`.ph-title-fetch[data-id="${articleId}"]`);
  if (btn) btn.disabled = true;
  try {
    const out = await API.refetchArticleTitle(projectId, articleId);
    toast(out.cached ? '该篇已有标题' : `已获取标题：${out.title}`, 'ok');
    await loadArticles();
  } catch (e) {
    toast(`获取失败：${e.message}`, 'err', 5000);
    await loadArticles();
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 标题状态徽标：抓取中/未获取（带原因）/手动维护
function titleStatusBadge(r) {
  if (r.title) {
    if (r.title_source === 'manual') return '<span class="tag tag-gray" title="手动维护，抓取不会覆盖">手动</span>';
    if (r.title_source === 'fetched') return '<span class="tag tag-blue" title="从文章页面自动抓取">自动</span>';
    return '';
  }
  if (r.title_fetch_status === 'failed') {
    return `<span class="tag tag-amber" title="${esc(r.title_fetch_error || '抓取失败')}">未获取</span>`;
  }
  if (r.title_fetch_status === 'pending') return '<span class="tag tag-amber">待获取</span>';
  return '';
}

// ============ 同步：项目刷新 + 首次回填（计划 → 确认） ============
// 入队即返回、轮询任务到终态：大项目不再让按钮干等（与文章监控看板同一条任务链）
async function runProjectSync(opts = {}, context = workspaceContext()) {
  const btn = $('#ph-sync-all');
  const original = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '已排队…'; }
  try {
    const out = await API.startSyncJob(context.projectId, opts);
    const job = out.jobId ? await pollSyncJob(out.jobId, (st) => {
      if (btn) btn.textContent = st === 'running' ? '同步中…' : '已排队…';
    }) : null;
    if (!job) { toast('同步任务已在进行中', 'ok'); return; }
    const m = job.metrics || {};
    const cur = m.current;
    const curText = cur && cur.gscEndDate
      ? `；本月临时 GSC 截至 ${cur.gscEndDate}${cur.ga4EndDate ? `、GA4 截至 ${cur.ga4EndDate}` : ''}`
      : '';
    if (job.status === 'failed') toast(`同步失败：${(job.errors || [])[0] || '未知原因'}`, 'err', 6000);
    else if (job.status === 'partial') toast(m.remainingMonths?.length
      ? `本次进度已保存，仍有 ${m.remainingMonths.length} 个历史月份待同步，再次刷新将继续${curText}`
      : `部分完成：${m.months ?? 0} 个月处理，部分文章或来源未完成${curText}`, 'err', 6000);
    else toast(`同步完成：${m.months ?? 0} 个月入库，数据截至 ${m.dataThrough || '—'}${curText}`, 'ok', 6000);
    if (context.isCurrent()) await loadArticles();
  } catch (e) {
    // 忙（该项目正在刷新中）等业务状态原样露出
    toast(e.message, 'err', 6000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

// 轮询同步任务到终态；onStatus 可选（按钮文案）。返回终态 job 或 null（复用中/找不到）。
async function pollSyncJob(jobId, onStatus) {
  let transient = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    let job;
    try { job = (await API.syncJob(jobId)).job; transient = 0; }
    catch { if (++transient >= 3) toast('暂时无法获取同步进度，将自动重试', 'err', 4000); continue; }
    if (onStatus) onStatus(job.status);
    if (['succeeded', 'partial', 'failed'].includes(job.status)) return job;
  }
}

async function openBackfillModal() {
  const context = workspaceContext();
  let plan = null;
  try { plan = await API.articleSyncPlan(context.projectId); }
  catch (e) { if (context.isCurrent()) toast(e.message, 'err'); return; }
  if (!context.isCurrent()) return;
  const modal = openModal(`
    <div class="modal-head"><h3>首次回填</h3><button class="modal-x" onclick="closeModal()">×</button></div>
    <p class="hint" style="margin-bottom:8px">按每篇文章的发布日期获取数据；没有发布日期的文章不取数。历史数据无法返回时保持未知。</p>
    <div class="form-row"><label>预计请求</label><p>GSC ${plan.requests.gsc} 次 / GA4 ${plan.requests.ga4} 次（${plan.articleCount} 篇，${plan.urlBatches} 个 URL 批次${plan.current?.planned ? '，含本月临时数据的新鲜度探测与抓取' : ''}）</p></div>
    <div class="muted" style="font-size:var(--mantine-font-size-xs);margin-top:6px">数据截至 ${esc(plan.dataThrough || '—')}；GSC 约 16 个月前的月份会标记为来源不可用。</div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="ph-bf-ok">开始回填</button>
    </div>`);
  const btn = $('#ph-bf-ok');
  btn.onclick = async () => {
    if (!context.isCurrent() || !modal.isCurrent()) return;
    btn.disabled = true;
    modal.close();
    await runProjectSync({}, context);
  };
}
// 重新读取项目计数与名单，保留当前工作区分区。
async function reload() {
  const version = renderVersion;
  const element = viewEl;
  const requestProject = projectId;
  const [h, cw, cand, ke] = await Promise.all([
    API.projectHome(projectId),
    API.projectCopywriters(projectId),
    state.tab === 'settings' ? API.copywriterCandidates(projectId) : Promise.resolve(candidates),
    state.tab === 'settings' ? API.articleKeyEvents(projectId).catch(() => keyEvents) : Promise.resolve(keyEvents),
  ]);
  if (!element?.isConnected || version !== renderVersion || requestProject !== projectId) return;
  home = h; copywriters = cw; candidates = cand; keyEvents = ke;
  state.selected.clear(); state.selectedAll = false; extState.selected.clear();
  render(viewEl);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => { if (args[0]?.target?.isConnected) fn(...args); }, ms); };
}
