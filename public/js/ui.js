// ui.js —— 通用 UI 工具：弹窗、提示、格式化
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function toast(msg, type = '', ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = type || '';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

let modalReturnFocus = null;
let modalRevision = 0;
function openModal(html, wide = false) {
  const mask = $('#modal-mask');
  const box = $('#modal');
  const revision = ++modalRevision;
  if (mask.classList.contains('hidden')) modalReturnFocus = document.activeElement;
  box.className = wide ? 'wide' : '';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.tabIndex = -1;
  box.innerHTML = html;
  const heading = box.querySelector('h3');
  if (heading) { heading.id = 'modal-title'; box.setAttribute('aria-labelledby', heading.id); }
  else box.removeAttribute('aria-labelledby');
  mask.classList.remove('hidden');
  queueMicrotask(() => {
    if (revision !== modalRevision || mask.classList.contains('hidden')) return;
    const focusable = modalFocusable();
    (focusable.find((node) => node.matches('input:not([type=checkbox]):not([type=radio]), textarea, select')) || focusable[0] || box).focus();
  });
  // 点击遮罩关闭
  mask.onclick = (e) => { if (e.target === mask) closeModal(); };
  return {
    isCurrent: () => revision === modalRevision && !mask.classList.contains('hidden'),
    close: () => { if (revision === modalRevision) closeModal(); },
  };
}
function closeModal() {
  modalRevision++;
  $('#modal-mask').classList.add('hidden');
  $('#modal').innerHTML = '';
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  modalReturnFocus = null;
}
function modalFocusable() {
  return $$('#modal a[href], #modal button, #modal input, #modal select, #modal textarea, #modal [tabindex]')
    .filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
}
document.addEventListener('keydown', (event) => {
  if ($('#modal-mask').classList.contains('hidden') || event.defaultPrevented || event.isComposing) return;
  if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
  if (event.key !== 'Tab') return;
  const nodes = modalFocusable();
  const first = nodes[0], last = nodes.at(-1);
  if (!first) { event.preventDefault(); $('#modal').focus(); return; }
  if (!$('#modal').contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
});

function confirmDialog(title, message, onOk) {
  openModal(`
    <div class="modal-head"><h3>${title}</h3></div>
    <p style="color:var(--mantine-color-dimmed);margin-bottom:6px">${message}</p>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" id="cf-ok">确定</button>
    </div>`);
  $('#cf-ok').onclick = () => { closeModal(); onOk(); };
}

// 表单取值工具：读所有带 name 的输入
function readForm(root) {
  const data = {};
  for (const el of $$('[name]', root)) {
    if (el.type === 'checkbox') data[el.name] = el.checked;
    else data[el.name] = el.value;
  }
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 用于 href：只放行 http/https 和站内路径，挡掉 javascript: 之类的伪协议
function safeUrl(s) {
  const raw = String(s ?? '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/') || raw.startsWith('#')) return esc(raw);
  return '';
}

function fmtPct(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  return (Number(v) * 100).toFixed(2) + '%';
}
function fmtNum(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  return Number(v).toLocaleString('zh-CN');
}
// 本地日期 YYYY-MM-DD。不能用 toISOString()——那是 UTC，东八区在 08:00 前会算成前一天，
// 「今天到期」「已逾期」全会错一天。dashboard / board / calendar 原先各写了一份，统一到这里。
const ymd = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = () => ymd();
function daysFromToday(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
}

// 平均排名：数字越小越好，单独格式化
function fmtPos(v) {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) || n <= 0 ? '—' : n.toFixed(1);
}

const STATUS_MAP = {
  todo: ['待办', 'tag-gray'],
  done: ['已完成', 'tag-green'],
};
const PRIO_MAP = {
  high: ['高', 'tag-red'],
  medium: ['中', 'tag-amber'],
  low: ['低', 'tag-gray'],
};
const PROJECT_STATUS = {
  active: ['进行中', 'tag-green'],
  paused: ['已暂停', 'tag-amber'],
  ended: ['已结束', 'tag-gray'],
};
// 把所有工具挂到全局，方便原生脚本风格的页面代码直接调用
Object.assign(globalThis, {
  $, $$, toast, openModal, closeModal, confirmDialog, readForm, esc, safeUrl,
  fmtPct, fmtNum, fmtPos, ymd, todayStr, daysFromToday,
  STATUS_MAP, PRIO_MAP, PROJECT_STATUS,
});
