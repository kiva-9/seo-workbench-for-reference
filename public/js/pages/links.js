// links.js —— 链接库
// 替代原文档库：存「链接」而不是文件本身。每条链接可挂在某项目下，或作为个人收藏夹（未关联项目）。
// 支持按项目 / 标签 / 搜索过滤。

import { API } from '../api.js';
import { loadingRows } from '../components/page-loading.js';
import { beginPageRender } from '../page-lifecycle.js';

let projects = [];
let state = { project: 'all', tag: '', q: '' };
let listRequest = 0;
let data = null; // { rows, allTags }


function hashFor(s = state) {
  const q = new URLSearchParams();
  if (s.project && s.project !== 'all') q.set('project', s.project);
  if (s.tag) q.set('tag', s.tag);
  if (s.q) q.set('q', s.q);
  return q.size ? `#/docs?${q}` : '#/docs';
}

const projectName = (id) => {
  if (!id) return '';
  const p = projects.find((x) => x.id === Number(id));
  return p ? p.name : '';
};

export async function renderLinks(el) {
  const isCurrent = beginPageRender(el);
  projects = [];
  data = { rows: [], allTags: [] };

  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  state.project = q.get('project') || 'all';
  state.tag = q.get('tag') || '';
  state.q = q.get('q') || '';

  el.innerHTML = `
    <div class="page-head">
      <div><h2>链接库</h2>
        <p class="page-desc">按项目或标签归类外部资源，收藏的链接可一键带入项目。</p></div>
      <div class="page-actions">
        <button class="btn btn-primary" id="lk-add" disabled>+ 新增链接</button>
      </div>
    </div>
    <div class="filter-bar">
        <select id="lk-project" disabled class="filter-select" aria-label="所属项目">
          <option value="all" ${state.project === 'all' ? 'selected' : ''}>全部项目</option>
          <option value="none" ${state.project === 'none' ? 'selected' : ''}>🔖 个人收藏（未关联）</option>
          <optgroup label="项目">
          ${projects.map((p) => `<option value="${p.id}" ${String(p.id) === state.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </optgroup>
        </select>
        <select id="lk-tag" class="filter-select-sm" aria-label="链接标签">
          <option value="">全部标签</option>
          ${(data.allTags || []).map((t) => `<option value="${esc(t)}" ${state.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
        <input type="search" id="lk-q" aria-label="搜索链接" class="filter-input" placeholder="搜索标题 / 链接 / 备注…" value="${esc(state.q)}">
    </div>
    <p id="lk-status" class="muted" role="status" aria-live="polite"></p>
    <p id="lk-project-status" class="muted" role="status"></p>
    <div id="lk-body">${loadingRows(['标题', '链接', '项目', '标签', '操作'])}</div>`;

  const qInput = $('#lk-q');
  const projectInput = $('#lk-project');
  const tagInput = $('#lk-tag');
  let timer;
  let composing = false;
  const applyFilters = () => {
    clearTimeout(timer);
    if (!isCurrent()) return;
    state = { project: projectInput.disabled ? state.project : projectInput.value, tag: tagInput.value, q: qInput.value };
    // 仅刷新结果区，保留输入焦点、光标与中文输入法，并让刷新/分享恢复筛选。
    history.replaceState(history.state, '', hashFor());
    load();
  };
  projectInput.onchange = applyFilters;
  tagInput.onchange = applyFilters;
  const scheduleSearch = () => {
    clearTimeout(timer);
    if (!composing) timer = setTimeout(applyFilters, 300);
  };
  qInput.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); });
  qInput.addEventListener('compositionend', () => { composing = false; scheduleSearch(); });
  qInput.addEventListener('input', scheduleSearch);
  window.addEventListener('seo-route-change', () => clearTimeout(timer), { once: true });
  $('#lk-add').onclick = () => openLinkModal(null);

  const loadProjects = async () => {
    try {
      const projs = await API.projects();
      if (!isCurrent()) return;
      projects = projs;
      projectInput.querySelector('optgroup').innerHTML = projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
      projectInput.value = state.project;
      projectInput.disabled = false;
      $('#lk-add').disabled = false;
      $('#lk-project-status').textContent = '';
      if (data.rows.length) { $('#lk-body').innerHTML = listHtml(); bindRowActions(); }
    } catch (e) {
      if (!isCurrent()) return;
      const status = $('#lk-project-status');
      status.innerHTML = `项目选项加载失败：${esc(e.message)} <button class="btn btn-sm">重试</button>`;
      status.querySelector('button').onclick = loadProjects;
    }
  };
  await Promise.all([loadProjects(), load()]);
}

async function load() {
  const body = $('#lk-body');
  if (!body) return;
  const request = ++listRequest;
  body.setAttribute('aria-busy', 'true');
  const status = $('#lk-status');
  status.textContent = '正在读取链接…';
  try {
    const params = {};
    if (state.project !== 'all') params.project_id = state.project === 'none' ? 'null' : state.project;
    if (state.tag) params.tag = state.tag;
    if (state.q) params.q = state.q;
    const result = await API.links(params);
    if (request !== listRequest || !body.isConnected) return;
    data = result;
    const tags = [...new Set([...(data.allTags || []), ...(state.tag ? [state.tag] : [])])];
    $('#lk-tag').innerHTML = '<option value="">全部标签</option>' + tags.map((tag) => `<option value="${esc(tag)}" ${state.tag === tag ? 'selected' : ''}>${esc(tag)}</option>`).join('');
    status.textContent = '';
    body.innerHTML = listHtml();
    bindRowActions();
  } catch (e) {
    if (request !== listRequest || !body.isConnected) return;
    status.textContent = '读取失败，可以保留筛选重试。';
    body.innerHTML = `<div class="card"><div class="empty">加载失败：${esc(e.message)}<br><button class="btn" id="lk-retry">重试</button></div></div>`;
    $('#lk-retry').onclick = load;
  } finally {
    if (request === listRequest) body.removeAttribute('aria-busy');
  }
}

function listHtml() {
  const rows = data.rows || [];
  const total = rows.length;
  const projectFilter = state.project !== 'all' ? `（${state.project === 'none' ? '个人收藏' : projectName(state.project)}）` : '';
  return `
    <div class="card card-flush">
      <div class="card-head"><h3>资源清单</h3><span class="muted">共 ${total} 条${projectFilter}</span></div>
      ${rows.length
        ? `<div class="tbl-wrap"><table class="tbl">
            <thead><tr>
              <th class="col-title">标题</th>
              <th>链接</th>
              <th class="col-w-110">项目</th>
              <th class="col-w-140">标签</th>
              <th class="col-actions">操作</th>
            </tr></thead>
            <tbody>${rows.map(rowHtml).join('')}
            </tbody>
          </table></div>`
        : `<div class="empty">
            <div class="big">🔗</div>
            ${state.q || state.tag || state.project !== 'all' ? '没有匹配的链接。' : '还没有收藏任何链接。<br><span class="muted">点右上角「+ 新增链接」开始。</span>'}
          </div>`}
    </div>`;
}

function rowHtml(r) {
  const href = safeUrl(r.url);
  const linkPart = href
    ? `<a class="link-url" href="${href}" target="_blank" rel="noopener">${esc(r.url)}</a>`
    : `<span class="muted">${esc(r.url)}</span>`;
  return `<tr data-id="${r.id}">
    <td class="cell-title">
      <a class="link-title" href="${href}" target="_blank" rel="noopener">${esc(r.title)}</a>
      ${r.notes ? `<div class="cell-note" title="${esc(r.notes)}">${esc(r.notes)}</div>` : ''}
    </td>
    <td>${linkPart}</td>
    <td>${r.project_id ? `<span class="tag tag-gray">${esc(projectName(r.project_id))}</span>` : '<span class="muted">个人收藏</span>'}</td>
    <td><div class="cell-chips">${(r.tags || []).map((t) => `<span class="tag tag-blue">${esc(t)}</span>`).join('') || '<span class="muted">—</span>'}</div></td>
    <td class="row-actions">
      <button class="btn btn-sm lk-edit" data-id="${r.id}" title="编辑">✎</button>
      <button class="btn btn-sm btn-danger lk-del" data-id="${r.id}" title="删除">🗑</button>
    </td>
  </tr>`;
}

function bindRowActions() {
  $$('.lk-edit').forEach((btn) => {
    btn.onclick = () => {
      const row = data.rows.find((r) => String(r.id) === btn.dataset.id);
      if (row) openLinkModal(row);
    };
  });
  $$('.lk-del').forEach((btn) => {
    btn.onclick = () => {
      const row = data.rows.find((r) => String(r.id) === btn.dataset.id);
      if (!row) return;
      confirmDialog('删除链接', `确定删除「${esc(row.title)}」？此操作不可恢复。`, async () => {
        try {
          await API.deleteLink(row.id);
          toast('已删除', 'ok');
          await load();
        } catch (e) { toast(e.message, 'err'); }
      });
    };
  });
}

// 新增 / 编辑链接
function openLinkModal(row) {
  const isEdit = Boolean(row);
  const r = row || { project_id: '', title: '', url: '', tags: [], notes: '' };
  openModal(`
    <div class="modal-head"><h3>${isEdit ? '编辑链接' : '新增链接'}</h3><button class="modal-x" onclick="closeModal()">×</button></div>
    <form id="lk-form" class="form-grid">
      <label class="field">
        <span>标题 *</span>
        <input type="text" name="title" required placeholder="如：客户官网后台" value="${esc(r.title)}">
      </label>
      <label class="field">
        <span>链接 *</span>
        <input type="text" name="url" required placeholder="https://…" value="${esc(r.url)}">
      </label>
      <label class="field">
        <span>所属项目</span>
        <select name="project_id">
          <option value="">🔖 个人收藏（未关联项目）</option>
          ${projects.map((p) => `<option value="${p.id}" ${String(p.id) === String(r.project_id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span>标签</span>
        <input type="text" name="tags" placeholder="逗号分隔，如：模板, 设计稿" value="${esc((r.tags || []).join(', '))}">
      </label>
      <label class="field" style="grid-column:1/-1">
        <span>备注</span>
        <textarea name="notes" rows="2" placeholder="选填">${esc(r.notes || '')}</textarea>
      </label>
    </form>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="lk-save">保存</button>
    </div>`);

  $('#lk-form').onsubmit = (event) => { event.preventDefault(); $('#lk-save').click(); };
  $('#lk-save').onclick = async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    const form = $('#lk-form');
    const d = readForm(form);
    if (!d.title.trim()) return toast('标题必填', 'err');
    if (!d.url.trim()) return toast('链接必填', 'err');
    const payload = {
      title: d.title.trim(),
      url: d.url.trim(),
      project_id: d.project_id || null,
      tags: (d.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
      notes: d.notes || '',
    };
    button.disabled = true;
    button.textContent = '保存中…';
    try {
      if (isEdit) await API.updateLink(row.id, payload);
      else await API.createLink(payload);
      if (!form.isConnected) return;
      closeModal();
      toast(isEdit ? '已保存' : '已添加', 'ok');
      await load();
    } catch (e) { toast(e.message, 'err'); }
    finally { button.disabled = false; button.textContent = '保存'; }
  };
}
