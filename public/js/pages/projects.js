// projects.js —— 项目管理：卡片列表 + 新建/编辑/详情弹窗
// GSC 与 GA4 分别绑定各自的谷歌账号（部门里两边可能不在同一个账号下）
import { API } from '../api.js';
import { beginPageRender, capturePageContext } from '../page-lifecycle.js';
import { createCombo } from '../components/combo.js';
import { loadProjectFormData } from '../components/project-form-data.js';
import {openResourceMatches} from '../components/resource-picker.js';
import {projectHostname} from '../components/project-domain.js';

let allProjects = [];
let allAccounts = [];
let allUsers = [];
let combos = [];
let formRequest = 0;
const isAdmin = () => window.currentUser?.role === 'admin';
const userEmail = (id) => allUsers.find((u) => u.id === id)?.email || '';

// 项目实际生效的账号：优先分开绑定的，回落到老库里的单一 account_id
function gscAccountOf(p) { return p.gsc_account_id ?? p.account_id ?? null; }
function ga4AccountOf(p) { return p.ga4_account_id ?? p.account_id ?? null; }
function accountEmail(id) {
  const a = allAccounts.find((x) => x.id === Number(id));
  if (!a) return '';
  // 有备注时显示「备注 · 邮箱」，方便在选账号时一眼认出
  return a.note ? `${a.note} · ${a.email}` : a.email;
}

// 解析项目保存的关键事件名：JSON 数组字符串、数组、或逗号分隔字符串
function parseKeyEvents(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s || '').trim()).filter(Boolean);
  if (!raw) return [];
  try { const a = JSON.parse(raw); if (Array.isArray(a)) return a.map((s) => String(s || '').trim()).filter(Boolean); } catch { /* 非 JSON */ }
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

export async function renderProjects(el) {
  const isCurrent = beginPageRender(el);
  const [projects, accounts, users] = await Promise.all([
    API.projects(), API.accounts(), isAdmin() ? API.listUsers() : Promise.resolve([]),
  ]);
  if (!isCurrent()) return;
  allProjects = projects;
  allAccounts = accounts;
  allUsers = users;

  el.innerHTML = `
    <div class="page-head">
      <div><h2>项目管理<span class="muted">${projects.length} 个项目</span></h2>
        <p class="page-desc">GSC 与 GA4 可分别绑定不同谷歌账号，互不影响。</p></div>
      <div class="page-actions">
        <button class="btn" onclick="location.hash='#/project-candidates'">项目候选 / 认领</button>
        <button class="btn" onclick="location.hash='#/accounts'">谷歌账号</button>
        <button class="btn btn-primary" id="proj-new">+ 新建项目</button>
      </div>
    </div>
    ${projects.length
      ? `<div class="project-grid${projects.length === 1 ? ' is-single' : ''}">${projects.map(projectCard).join('')}</div>`
      : `<div class="card"><div class="empty"><div class="big">📁</div>还没有项目，点右上角「新建项目」开始<br><span class="muted">GSC 和 GA4 可以分别绑定不同的谷歌账号</span></div></div>`}`;

  $('#proj-new').onclick = () => openProjectForm();

  // 事件委托：编辑/删除/进项目主页
  el.onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    const card = e.target.closest('.pcard');
    if (!btn && card) { location.hash = `#/project?id=${card.dataset.id}`; return; }
    if (!btn) return;
    const current = capturePageContext(el);
    const id = btn.dataset.id;
    if (btn.dataset.act === 'edit') openProjectForm(id);
    if (btn.dataset.act === 'resources') openResourceMatches(id,()=>{ if (isCurrent() && current()) return renderProjects(el); });
    if (btn.dataset.act === 'transfer') openTransferModal(id, el);
    if (btn.dataset.act === 'del') confirmDialog('删除项目', '将同时删除该项目下的任务、链接、URL 和数据记录，且不可恢复。确定删除？', async () => {
      try {
        await API.deleteProject(id);
        toast('已删除', 'ok');
        if (isCurrent() && current()) await renderProjects(el);
      } catch (err) { toast(err.message, 'err'); }
    });
  };
}

// 转让项目（admin only）：选一个用户，整个项目（含任务/URL/链接）改归他
function openTransferModal(id, hostEl) {
  const current = capturePageContext(hostEl);
  const p = allProjects.find((x) => x.id === Number(id));
  if (!p) return;
  const others = allUsers.filter((u) => u.id !== p.owner_user_id);
  openModal(`
    <div class="modal-head"><h3>转让项目</h3><button class="modal-x" onclick="closeModal()">×</button></div>
    <p style="color:var(--mantine-color-dimmed);margin-bottom:10px">「${esc(p.name)}」当前归属：${esc(userEmail(p.owner_user_id) || '（未认领）')}</p>
    <select id="tr-user" style="width:100%">
      ${others.map((u) => `<option value="${u.id}">${esc(u.email)}${u.role === 'admin' ? '（管理员）' : ''}</option>`).join('')}
    </select>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="tr-ok">转让</button>
    </div>`);
  $('#tr-ok').onclick = () => {
    const newOwnerId = Number($('#tr-user').value);
    if (!newOwnerId) return toast('没有可转让的对象', 'err');
    confirmDialog('确认转让', `确定把「${esc(p.name)}」转让给 ${esc(userEmail(newOwnerId))}？转让后你将看不到这个项目。`, async () => {
      try {
        await API.transferProject(id, newOwnerId);
        toast('已转让', 'ok');
        if (current()) await renderProjects(hostEl);
      } catch (err) { toast(err.message, 'err'); }
    });
  };
}

// 绑定状态标签：分别显示 GSC / GA4 各自用的账号
function bindingTags(p) {
  const gscAcc = gscAccountOf(p), ga4Acc = ga4AccountOf(p);
  const gscOk = gscAcc && p.gsc_site;
  const ga4Ok = ga4Acc && p.ga4_property_id;
  const details = [
    `GSC ${gscOk ? '已绑定' : '未绑定'}${gscOk ? `：${accountEmail(gscAcc)}` : ''}`,
    `GA4 ${ga4Ok ? '已绑定' : '未绑定'}${ga4Ok ? `：${accountEmail(ga4Acc)}` : ''}`,
  ];
  return `<div class="project-connections" title="${esc(details.join('；'))}">
    <span>GSC ${gscOk ? '已绑定' : '未绑定'}</span><span aria-hidden="true">·</span>
    <span>GA4 ${ga4Ok ? '已绑定' : '未绑定'}</span>
  </div>`;
}

function projectCard(p) {
  const [stLabel, stClass] = PROJECT_STATUS[p.status] || ['', ''];
  const site = safeUrl(p.website);
  // admin 能看到所有人的项目，卡片上得标出「这是谁的」，不然分不清
  const ownerTag = isAdmin() && allUsers.length > 1
    ? `<div class="meta-row"><span class="k">负责人</span><span class="v">${esc(userEmail(p.owner_user_id) || '未认领')}</span></div>`
    : '';
  const transferBtn = isAdmin()
    ? `<button data-act="transfer" data-id="${p.id}" title="转让给其他人">⇄</button>`
    : '';
  return `<div class="card pcard" data-id="${p.id}">
    <div class="actions">
      ${transferBtn}
      <button data-act="resources" data-id="${p.id}" title="资源匹配">⛓</button>
      <button data-act="edit" data-id="${p.id}" title="编辑">✎</button>
      <button data-act="del" data-id="${p.id}" title="删除">🗑</button>
    </div>
    <div class="pname">${esc(p.name)} <span class="tag ${stClass}">${stLabel}</span></div>
    <div class="meta">
      <div class="meta-row"><span class="k">项目域名</span><span class="v">${site ? `<a href="${site}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(projectHostname(p.website))}</a>` : '—'}</span></div>
      ${bindingTags(p)}${ownerTag}
    </div>
  </div>`;
}

// 新建/编辑表单
// onSaved：保存成功后的回调，默认回到项目列表；项目主页从这里打开编辑时会传入
// 「留在当前项目主页刷新」的回调，避免保存完被弹回项目列表。
export async function openProjectForm(id, onSaved) {
  const request = ++formRequest;
  const view = $('#view');
  const current = capturePageContext(view);
  const isCurrent = () => request === formRequest && current();
  let formData;
  try {
    formData = await loadProjectFormData(API, id);
  } catch (err) {
    if (isCurrent()) toast(err.message, 'err');
    return;
  }
  if (!isCurrent()) return;
  combos.forEach((c) => c.destroy());
  combos = [];
  const { project, accounts, resourceData } = formData;
  allAccounts = accounts;
  if(project)allAccounts=[...accounts,...resourceData.bound_accounts.filter(a=>!accounts.some(own=>own.id===a.id))];
  const accOptions = (selected) => '<option value="">未绑定</option>' +
    allAccounts.map((a) => `<option value="${a.id}" ${String(selected || '') === String(a.id) ? 'selected' : ''}>${esc(accountEmail(a.id))}</option>`).join('');

  const modal = openModal(`
    <div class="modal-head"><h3>${project ? '编辑项目' : '新建项目'}</h3><button class="modal-x" onclick="closeModal()">×</button></div>
    <form id="proj-form">
      <div class="form-grid">
        <div class="form-row"><label>项目名称 *</label><input name="name" required value="${esc(project?.name || '')}" placeholder="如：Acme 英文站 SEO"></div>
        <div class="form-row"><label>项目域名</label><input name="website" value="${esc(projectHostname(project?.website || ''))}" placeholder="example.com"></div>
        <div class="form-row"><label>状态</label>
          <select name="status">
            ${['active', 'paused', 'ended'].map((s) => `<option value="${s}" ${project?.status === s ? 'selected' : ''}>${PROJECT_STATUS[s][0]}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-title">Search Console 数据源</div>
        <div class="form-grid">
          <div class="form-row"><label>谷歌账号</label><select name="gsc_account_id" id="pf-gsc-acc">${accOptions(gscAccountOf(project || {}))}</select></div>
          <div class="form-row"><label>GSC 站点</label><div id="pf-site"></div></div>
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-title">Analytics (GA4) 数据源</div>
        <div class="form-grid">
          <div class="form-row"><label>谷歌账号</label><select name="ga4_account_id" id="pf-ga4-acc">${accOptions(ga4AccountOf(project || {}))}</select></div>
          <div class="form-row"><label>GA4 媒体资源</label><div id="pf-prop"></div></div>
        </div>
        <div class="hint">两个数据源可以用不同的谷歌账号 —— 比如 GSC 在客户账号下、GA4 在部门账号下。</div>
      </div>

      <div class="form-section">
        <div class="form-section-title">关键事件数（KPI）</div>
        <div class="hint">勾选要计入关键事件数的事件（通常是询盘 / 表单提交），可多选；抓取时按页面统计这些事件数的总和。<span class="muted">需先选好 GA4 账号与媒体资源，也可手动补充事件名。</span></div>
        <div id="pf-keyevents">
          <input type="hidden" name="key_event_names" value="${esc(JSON.stringify(parseKeyEvents(project?.key_event_names)))}">
          <div class="muted">选好 GA4 账号与媒体资源后，这里会列出该资源最近 90 天的事件。</div>
        </div>
      </div>

      ${allAccounts.length ? '' : '<div class="hint">尚未连接任何谷歌账号，<a href="#/accounts" onclick="closeModal()">先到「谷歌账号」页连接</a></div>'}

      <div class="form-row"><label>备注</label><textarea name="notes" rows="2" placeholder="记录项目要点、联系人等">${esc(project?.notes || '')}</textarea></div>
      <div class="form-actions">
        <button type="button" class="btn" onclick="closeModal()">取消</button>
        <button type="submit" class="btn btn-primary" id="pf-save">保存</button>
      </div>
    </form>`, true);

  const gscAccSel = $('#pf-gsc-acc');
  const ga4AccSel = $('#pf-ga4-acc');
  const siteCombo = createCombo($('#pf-site'), { name: 'gsc_site', placeholder: '搜索站点…' });
  const propCombo = createCombo($('#pf-prop'), { name: 'ga4_property_id', placeholder: '搜索资源名或 ID…' });
  combos.push(siteCombo, propCombo);
  const optionRequests=new WeakMap();
  const optionsLoading=new Set();

  const loadOptions = async (combo, accountId, { source, fetcher, toOptions, emptyLabel, keep }) => {
    const revision=(optionRequests.get(combo)||0)+1;optionRequests.set(combo,revision);
    if (!accountId) { optionsLoading.delete(combo);return combo.setEmpty(emptyLabel); }
    optionsLoading.add(combo);
    combo.setLoading();
    try {
      if(project){
        await combo.setRemoteSource((params,opts)=>API.projectResources(project.id,{...params,account_id:accountId,source},opts),toOptions,keep,
          toOptions(resourceData.resources.filter(r=>r.account_id===Number(accountId)&&r.source===source)));
        return;
      }
      const rows=await fetcher(accountId);
      if(!isCurrent()||!gscAccSel.isConnected||revision!==optionRequests.get(combo))return;
      const options=toOptions(rows);
      if(keep&&!options.some(option=>option.value===keep))options.unshift({value:keep,label:keep,note:'已有来源 · 待核验'});
      combo.setOptions(options, keep);
    } catch (e) {
      if(!isCurrent()||!gscAccSel.isConnected||revision!==optionRequests.get(combo))return;
      if(keep){combo.setOptions([{value:keep,label:keep,note:'已有来源 · 目录读取失败'}],keep);return;}
      combo.setError(`拉取失败：${e.message}`);
      toast(e.message, 'err');
    }finally{if(revision===optionRequests.get(combo))optionsLoading.delete(combo);}
  };
  const catalogRows=async(accountId,source)=>
    (await API.accountResources(accountId)).resources.filter(r=>r.source===source&&r.state==='available');

  const loadSites = (accountId, keep = '') => loadOptions(siteCombo, accountId, {
    source:'gsc',
    fetcher:accountId=>catalogRows(accountId,'gsc'),
    toOptions: (list) => list.map((s) => ({ value: s.resource_key, label: s.resource_key, note: s.permission_level })),
    emptyLabel: '先选谷歌账号',
    keep,
  });
  const loadProps = async (accountId, keep = '') => {
    await loadOptions(propCombo, accountId, {
      source:'ga4',
      fetcher:accountId=>catalogRows(accountId,'ga4'),
      toOptions: (list) => list.map((p) => ({
        value: p.resource_key,
        label: p.display_name||p.resource_key,
        note: `${p.resource_key}${p.shared_scope?' · 多网站资源':''}`,
      })),
      emptyLabel: '先选谷歌账号',
      keep,
    });
    // 资源列表加载完成时进入关键事件编辑：有资源则拉事件列表，无资源（未选中/拉取失败）则给出手动补充入口
    if (accountId&&isCurrent()&&ga4AccSel.isConnected&&ga4AccSel.value===String(accountId)) loadKeyEvents(accountId, propCombo.getValue());
  };

  loadSites(gscAccSel.value, project?.gsc_site || '');
  loadProps(ga4AccSel.value, project?.ga4_property_id || '');
  gscAccSel.onchange = () => loadSites(gscAccSel.value);

  // ---------- 关键事件数（KPI）配置 ----------
  const selectedEvents = new Set(parseKeyEvents($('#pf-keyevents input[name=key_event_names]').value));
  let keyEventRequest=0;
  let keAllEvents = [];
  let keSearch = '';

  function syncKeyEvents() {
    const h = $('#pf-keyevents input[name=key_event_names]');
    if (h) h.value = JSON.stringify([...selectedEvents]);
    const count = $('#ke-count');
    if (count) count.textContent = `已选 ${selectedEvents.size} 个`;
  }

  function renderKeyEventList() {
    const list = $('#ke-list');
    if (!list) return;
    const q = keSearch.trim().toLowerCase();
    const visible = keAllEvents.filter((n) => !q || n.toLowerCase().includes(q));
    list.innerHTML = visible.length
      ? visible.map((n) => `
          <label class="ke-row" title="${esc(n)}"><input type="checkbox" value="${esc(n)}" ${selectedEvents.has(n) ? 'checked' : ''}><span>${esc(n)}</span></label>`).join('')
      : `<div class="muted">${keAllEvents.length ? '没有匹配的事件，可手动补充' : '该资源近期没有事件，可手动补充'}</div>`;
  }

  // 手动补充事件名的交互（资源列表拉取失败 / 未选资源时也有入口）
  function attachAddHandler() {
    const addInput = $('#ke-add-input');
    if (!addInput) return;
    const add = () => {
      const v = addInput.value.trim();
      if (!v) return;
      selectedEvents.add(v);
      if (!keAllEvents.includes(v)) keAllEvents.push(v);
      addInput.value = '';
      syncKeyEvents();
      renderKeyEventList();
    };
    $('#ke-add-btn').onclick = add;
    addInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  }

  // 只有手动补充入口的最小编辑器（没选账号 / 资源信息拉取失败时）
  function manualOnlyEditor(extraHint = '') {
    return `
      <input type="hidden" name="key_event_names" value="${esc(JSON.stringify([...selectedEvents]))}">
      ${extraHint}
      <div class="ke-add">
        <input id="ke-add-input" type="text" placeholder="手动补充事件名，回车添加" autocomplete="off">
        <button type="button" class="btn btn-sm" id="ke-add-btn">添加</button>
      </div>
      <div class="ke-foot"><span id="ke-count" class="muted">已选 ${selectedEvents.size} 个</span></div>`;
  }

  async function loadKeyEvents(accId, propId) {
    const revision=++keyEventRequest;
    const box = $('#pf-keyevents');
    if(!box||!isCurrent())return;
    if (!accId) {
      box.innerHTML=manualOnlyEditor('<div class="muted">尚未配置 GA4 来源，可先维护事件名称。</div>');attachAddHandler();syncKeyEvents();
      return;
    }
    if (!propId) {
      // 资源未选中（可能拉取失败）：给出手动补充入口
      box.innerHTML = manualOnlyEditor();
      attachAddHandler();
      syncKeyEvents();
      return;
    }
    box.innerHTML = `<input type="hidden" name="key_event_names" value="${esc(JSON.stringify([...selectedEvents]))}">`
      + '<div class="muted" style="padding:4px 0"><span class="spinner"></span> 加载事件列表…</div>';
    let events;
    try {
      events = await (project?API.projectResourceEvents(project.id,accId,propId):API.accountEvents(accId,propId));
    } catch (e) {
      if(!isCurrent()||!box.isConnected||revision!==keyEventRequest)return;
      keAllEvents = [];
      box.innerHTML = manualOnlyEditor(`<div class="muted" style="color:var(--wb-danger)">拉取事件列表失败：${esc(e.message)}，可手动补充事件名。</div>`);
      attachAddHandler();
      syncKeyEvents();
      return;
    }
    if(!isCurrent()||!box.isConnected||revision!==keyEventRequest)return;
    keAllEvents = events;
    box.innerHTML = `
      <input type="hidden" name="key_event_names" value="${esc(JSON.stringify([...selectedEvents]))}">
      <div class="ke-search"><input id="ke-search-input" type="text" placeholder="搜索事件名…" autocomplete="off"></div>
      <div id="ke-list" class="ke-list"></div>
      <div class="ke-add">
        <input id="ke-add-input" type="text" placeholder="手动补充事件名，回车添加" autocomplete="off">
        <button type="button" class="btn btn-sm" id="ke-add-btn">添加</button>
      </div>
      <div class="ke-foot"><span id="ke-count" class="muted">已选 ${selectedEvents.size} 个</span><span class="muted">共 ${keAllEvents.length} 个事件</span></div>`;
    renderKeyEventList();
    attachAddHandler();
    $('#ke-search-input').oninput = (e) => { keSearch = e.target.value; renderKeyEventList(); };
    $('#ke-list').onchange = (e) => {
      const cb = e.target.closest('input[type=checkbox]');
      if (!cb) return;
      if (cb.checked) selectedEvents.add(cb.value);
      else selectedEvents.delete(cb.value);
      syncKeyEvents();
    };
  }

  ga4AccSel.onchange = () => { loadProps(ga4AccSel.value); };
  $('#pf-prop input[type=hidden]').addEventListener('change', () => loadKeyEvents(ga4AccSel.value, propCombo.getValue()));

  $('#proj-form').onsubmit = async (e) => {
    e.preventDefault();
    if(optionsLoading.size)return toast('来源目录仍在加载，请稍后保存','err');
    const data = readForm(e.target);
    // 域名未改时保留已有网址的协议和路径，避免编辑其他资料改变既有范围。
    if (project && data.website === projectHostname(project.website)) data.website = project.website;
    if (!data.name.trim()) return toast('请填写项目名称', 'err');
    // 选了站点却没选账号（或反过来）抓不到数据，先拦下来
    if (data.gsc_site && !data.gsc_account_id) return toast('选了 GSC 站点，请同时选择对应的谷歌账号', 'err');
    if (data.ga4_property_id && !data.ga4_account_id) return toast('选了 GA4 资源，请同时选择对应的谷歌账号', 'err');

    // 关键事件名是否变化（编辑模式下才需要对比）：
    // 变了的话后端会自动重置该项目的关键事件累计，下次抓取会按新事件名重新统计，
    // 这一步只是给用户一句提示，让他知道为什么下次抓取可能慢一点（要全量重拉）。
    const oldKeyEventSet = new Set(parseKeyEvents(project?.key_event_names));
    const newKeyEventSet = new Set(parseKeyEvents(data.key_event_names));
    const keyEventsChanged = project
      && (oldKeyEventSet.size !== newKeyEventSet.size
          || [...oldKeyEventSet].some((n) => !newKeyEventSet.has(n))
          || [...newKeyEventSet].some((n) => !oldKeyEventSet.has(n)));

    const btn = $('#pf-save', e.target);
    btn.disabled = true;
    try {
      if (project) { await API.updateProject(project.id, {...data,expected_config_revision:project.config_revision}); toast('已保存', 'ok'); }
      else { await API.createProject(data); toast('项目已创建', 'ok'); }
      if (keyEventsChanged) {
        toast('关键事件选择有变化，下次抓取会按新事件名重新累计', '', 5000);
      }
      modal.close();
      if (!isCurrent()) return;
      if (onSaved) await onSaved();
      else await renderProjects(view);
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  };
}

// 供其它模块/行内按钮调用
window.openProjectForm = openProjectForm;
