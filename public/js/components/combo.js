// combo.js —— 可搜索下拉
// 原生 <select> 不能输入筛选，而一个谷歌账号下常有几十上百个 GA4 资源 / GSC 站点，
// 靠滚动找很痛苦。这里用「隐藏 input 存值 + 可见 input 做搜索」的组合，
// 隐藏 input 带 name，所以 readForm() 照常能读到值，表单那边不用改。

import {createResourcePager} from './resource-pager.js';
const OPEN_CLASS = 'open';
let comboId=0;

/**
 * @param host    容器元素，组件会把自己渲染进去
 * @param opts.name         隐藏 input 的 name（表单字段名）
 * @param opts.placeholder  未选中时的占位文案
 * @returns 控制器 { setOptions, setValue, getValue, setLoading, setError, destroy }
 *
 * 选项格式：{ value, label, note? } —— note 显示为第二行小字（比如 GA4 的资源 ID）
 */
export function createCombo(host, { name, placeholder = '搜索…',label=placeholder } = {}) {
  const id=`combo-${++comboId}`;
  host.innerHTML = `
    <div class="combo">
      <input type="hidden" name="${esc(name)}" value="">
      <input class="combo-input" type="text" role="combobox" aria-label="${esc(label)}" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-list" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}">
      <button type="button" class="combo-clear hidden" title="清除" tabindex="-1">×</button>
      <div class="combo-list hidden" role="listbox" id="${id}-list" aria-label="${esc(label)}"></div>
    </div>`;

  const root = host.querySelector('.combo');
  const hidden = root.querySelector('input[type=hidden]');
  const input = root.querySelector('.combo-input');
  const clearBtn = root.querySelector('.combo-clear');
  const list = root.querySelector('.combo-list');

  let options = [];
  let filtered = [];
  let cursor = -1;
  let disabled = false;
  let remote = null;

  const current = () => options.find((o) => o.value === hidden.value) || null;
  const labelOf = (o) => (o ? o.label : '');

  function syncText() {
    input.value = labelOf(current());
    clearBtn.classList.toggle('hidden', !hidden.value || disabled);
  }

  function renderList() {
    input.removeAttribute('aria-activedescendant');
    if (!remote && !filtered.length) {
      list.innerHTML = `<div class="combo-empty">${options.length ? '没有匹配项' : '没有可选项'}</div>`;
      return;
    }
    list.innerHTML = filtered.map((o, i) => `
      <div class="combo-opt${i === cursor ? ' active' : ''}${o.value === hidden.value ? ' selected' : ''}" id="${id}-option-${i}" role="option" aria-selected="${o.value===hidden.value}" data-i="${i}">
        <div class="combo-opt-label">${esc(o.label)}</div>
        ${o.note ? `<div class="combo-opt-note">${esc(o.note)}</div>` : ''}
      </div>`).join('');
    if(remote){
      const s=remote.states.options;
      list.innerHTML+=`<div class="combo-pager"><div class="combo-empty" role="status">${s.loading?'正在搜索…':s.error?`加载失败：${esc(s.error)}`:`共 ${s.total} 项 · 第 ${s.page} 页`}</div>
        <div class="resource-pagination">
          ${s.error?'<button type="button" class="btn btn-sm" data-combo-retry>重试</button>':''}
          <button type="button" class="btn btn-sm" data-combo-page="${s.page-1}" ${s.loading||s.page<=1?'disabled':''}>上一页</button>
          <button type="button" class="btn btn-sm" data-combo-page="${s.page+1}" ${s.loading||s.page*s.page_size>=s.total?'disabled':''}>下一页</button>
        </div></div>`;
    }
    const active = list.querySelector('.combo-opt.active');
    if (active) {input.setAttribute('aria-activedescendant',active.id);active.scrollIntoView({ block: 'nearest' });}
  }

  function filter(q) {
    const s = String(q || '').trim().toLowerCase();
    if(remote){
      if(s!==remote.states.options.q)remote.load('options',{q:s,page:1},250);
      else renderList();
      return;
    }
    filtered = !s ? options.slice() : options.filter((o) =>
      o.label.toLowerCase().includes(s) || String(o.value).toLowerCase().includes(s)
      || String(o.note || '').toLowerCase().includes(s));
    cursor = filtered.findIndex((o) => o.value === hidden.value);
    renderList();
  }

  function open(fromTyping = false) {
    if (disabled) return;
    root.classList.add(OPEN_CLASS);
    input.setAttribute('aria-expanded','true');
    list.classList.remove('hidden');
    if (!fromTyping) input.select();
    filter(fromTyping ? input.value : '');
  }

  function close() {
    root.classList.remove(OPEN_CLASS);
    input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');
    list.classList.add('hidden');
    syncText();
  }

  function pick(i) {
    const o = filtered[i];
    if (!o) return;
    hidden.value = o.value;
    close();
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
  }

  input.onfocus = () => open();
  input.onclick = () => { if (!root.classList.contains(OPEN_CLASS)) open(); };
  input.oninput = () => (root.classList.contains(OPEN_CLASS) ? filter(input.value) : open(true));

  input.onkeydown = (e) => {
    if(remote&&(e.key==='PageDown'||e.key==='PageUp')){
      e.preventDefault();const s=remote.states.options,page=s.page+(e.key==='PageDown'?1:-1);
      if(!s.loading&&page>=1&&page<=Math.ceil(s.total/s.page_size))remote.load('options',{page});
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!root.classList.contains(OPEN_CLASS)) return open();
      if (!filtered.length) return;
      cursor = e.key === 'ArrowDown'
        ? (cursor + 1) % filtered.length
        : (cursor - 1 + filtered.length) % filtered.length;
      renderList();
    } else if (e.key === 'Enter') {
      if (root.classList.contains(OPEN_CLASS)) { e.preventDefault(); pick(cursor >= 0 ? cursor : 0); }
    } else if (e.key === 'Escape') {
      if (root.classList.contains(OPEN_CLASS)) { e.stopPropagation(); close(); }
    } else if (e.key === 'Tab') {
      close();
    }
  };

  list.onmousedown = (e) => {
    const button=e.target.closest('[data-combo-page],[data-combo-retry]');
    if(button&&remote){
      e.preventDefault();
      return;
    }
    const opt = e.target.closest('.combo-opt');
    if (!opt) return;
    e.preventDefault();
    pick(Number(opt.dataset.i));
  };
  list.onclick=e=>{
    const button=e.target.closest('[data-combo-page],[data-combo-retry]');
    if(button&&!button.disabled&&remote)remote.load('options',{page:Number(button.dataset.comboPage)||remote.states.options.requested_page||1});
  };

  clearBtn.onclick = () => {
    hidden.value = '';
    syncText();
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const onDocDown = (e) => { if (!root.contains(e.target)) close(); };
  document.addEventListener('mousedown', onDocDown);

  const api = {
    async setRemoteSource(loadPage, toOptions, keep='', initial=[]) {
      remote=null;
      hidden.value=String(keep||'');
      api.setOptions(initial,keep);
      const pager=createResourcePager({resources:[],pages:{options:{ids:[],page:1,page_size:25,total:0}},
        loadPage:async({q,page,page_size},opts)=>{
          const result=await loadPage({q,page,page_size},opts);
          return {...result,items:toOptions(result.items).map((o,i)=>({...o,value:String(o.value),id:result.items[i].id}))};
        },isActive:()=>remote===pager&&root.isConnected,
        onChange:()=>{
          const chosen=current(),s=pager.states.options;
          options=s.ids.map(id=>pager.byId.get(id));
          if(chosen&&!options.some(o=>o.value===hidden.value))options.unshift(chosen);
          filtered=options.slice();cursor=filtered.findIndex(o=>o.value===hidden.value);
          if(!root.classList.contains(OPEN_CLASS))syncText();
          renderList();
        }});
      remote=pager;
      await pager.load('options');
    },
    setOptions(next, keep = '') {
      options = (next || []).map((o) => ({ value: String(o.value), label: String(o.label), note: o.note || '' }));
      disabled = false;
      input.disabled = false;
      input.placeholder = placeholder;
      if (keep && !options.some((o) => o.value === String(keep))) {
        options.unshift({ value: String(keep), label: String(keep), note: '当前账号下看不到这一项，保存后仍保留' });
      }
      if (keep) hidden.value = String(keep);
      else if (hidden.value && !options.some((o) => o.value === hidden.value)) hidden.value = '';
      syncText();
    },
    setValue(v) { hidden.value = v == null ? '' : String(v); syncText(); },
    getValue() { return hidden.value; },
    setLoading(text = '加载中…') {
      remote=null;
      options = []; hidden.value = ''; disabled = true;
      input.disabled = true; input.value = ''; input.placeholder = text;
      clearBtn.classList.add('hidden');
      close();
    },
    setError(msg) {
      remote=null;
      options = []; hidden.value = ''; disabled = true;
      input.disabled = true; input.value = ''; input.placeholder = msg;
      clearBtn.classList.add('hidden');
      close();
    },
    setEmpty(msg) {
      remote=null;
      options = []; hidden.value = ''; disabled = true;
      input.disabled = true; input.value = ''; input.placeholder = msg;
      clearBtn.classList.add('hidden');
      close();
    },
    destroy() { remote=null;document.removeEventListener('mousedown', onDocDown); },
  };
  return api;
}
