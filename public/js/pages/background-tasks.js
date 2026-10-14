import { API } from '../api.js';
import { beginPageRender } from '../page-lifecycle.js';
import { loadingRows } from '../components/page-loading.js';

const types = { 'article-sync': '文章监控同步', ai: 'AI 见解 / RSS', operation: '业务后台操作', 'resource-sync': 'Google 资源目录' };
const labels = { queued: '已排队', running: '执行中', succeeded: '成功', partial: '部分完成', failed: '失败', cancel_requested: '正在停止', cancelled: '已取消', uncertain: '结果 / 费用待核查' };
const modules = { internal: '站内文章', performance: '文章表现', news: '行业资讯 / RSS', indexing: '收录检查', sync: '指标同步', titles: '标题抓取', export: '报表导出', import_retry: '导入重试', 'google-catalog': '资源发现' };
const active = status => ['queued','running','cancel_requested'].includes(status);
const fmt = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const duration = value => value == null ? '—' : value < 60 ? `${value} 秒` : `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
const tag = status => `<span class="tag ${status === 'succeeded' ? 'tag-green' : ['failed','uncertain'].includes(status) ? 'tag-red' : active(status) ? 'tag-blue' : 'tag-amber'}">${esc(labels[status] || status)}</span>`;
const progress = task => `${esc(task.progress.phase || '等待记录')}${task.progress.completed == null ? '' : ` · ${task.progress.completed}${task.progress.total == null ? ' 个已处理' : ' / ' + task.progress.total + (task.progress.unit === 'month' ? ' 个月' : ' 个单元')}`}`;
const taskHash = q => '#/background-tasks?' + q;

export async function renderBackgroundTasks(el) {
  const current = beginPageRender(el), q = new URLSearchParams(location.hash.split('?')[1] || '');
  let timer = null, revision = 0, failures = 0, data = null, selected = null, pending = false;
  const stop = () => clearTimeout(timer);
  window.addEventListener('seo-route-change', stop, { once: true });
  const syncLocation = () => history.replaceState(history.state, '', taskHash(q));
  const options = (all, items, value) => `<option value="">${all}</option>` + items.map(([id,name]) => `<option value="${esc(id)}" ${String(id) === value ? 'selected' : ''}>${esc(name)}</option>`).join('');
  el.innerHTML = `<section class="bt-page"><header class="page-head"><div><h2>后台任务</h2><p class="page-desc">查看任务的实际进度、执行结果与需要跟进的步骤。</p></div>
    <div class="page-actions"><label class="bt-follow"><input type="checkbox" id="bt-follow" checked> 跟踪活动任务</label><button class="btn" id="bt-refresh">刷新</button></div></header>
    <div class="card bt-filters" aria-label="后台任务筛选">
      <label>任务类型<select id="bt-type">${options('全部类型', Object.entries(types), q.get('type'))}</select></label>
      <label>项目<select id="bt-project"><option value="">全部项目</option></select></label>
      <label>谷歌账号<select id="bt-account"><option value="">全部账号</option></select></label>
      <label>任务状态<select id="bt-status">${options('全部状态', [['active','活动任务'],...Object.entries(labels)], q.get('status'))}</select></label>
    </div><div class="bt-status" id="bt-status-message" role="status"></div>
    <div id="bt-detail"></div><section class="card bt-list" aria-label="后台任务列表"><div class="bt-list-heading"><h3>任务记录</h3><span id="bt-count" class="muted">正在读取…</span></div>
    <div class="bt-table-scroll" id="bt-table">${loadingRows(['任务 / 模块','项目 / 账号','发起人','状态','执行进度','创建时间 / 耗时','操作'])}</div><div id="bt-pager" class="bt-pager"></div></section>
    <p class="hint bt-coverage">覆盖文章监控同步、AI 见解（RSS 为资讯任务的取源步骤）、业务后台操作与 Google 资源目录同步。等待式标题抓取、部分单篇 / 站外同步与定时维护暂未形成完整任务历史。</p></section>`;
  const $ = s => el.querySelector(s);
  function message(text, error = false) {
    $('#bt-status-message').textContent = text; $('#bt-status-message').classList.toggle('bt-error', error);
  }
  async function loadOptions() {
    try {
      const o = await API.backgroundTaskOptions(); if (!current()) return;
      $('#bt-project').innerHTML = options('全部项目', o.projects.map(p=>[p.id,p.name]), q.get('project'));
      $('#bt-account').innerHTML = options('全部账号', o.accounts.map(a=>[a.id,a.name]), q.get('account'));
    } catch { if (current()) message('筛选选项读取失败，可点击刷新重试。', true); }
  }
  function schedule() {
    stop();
    if (current() && $('#bt-follow').checked && failures < 3 && (data?.items.some(t=>active(t.status)) || active(selected?.status)))
      timer = setTimeout(() => { if (!document.hidden) load(); else schedule(); }, 5000);
  }
  async function detail(type, id, unitPage = 1) {
    const request = ++revision;
    q.set('task_type', type); q.set('task_id', id); q.set('unit_page', String(unitPage)); syncLocation();
    $('#bt-detail').innerHTML = '<div class="card" role="status">正在读取任务详情…</div>';
    try {
      const task = await API.backgroundTask(type, id, unitPage);
      if (!current() || request !== revision) return;
      selected = task; renderDetail(task); schedule();
    } catch {
      if (!current() || request !== revision) return;
      selected = null; $('#bt-detail').innerHTML = '<div class="card bt-error" role="alert">任务详情读取失败或权限已变化。<button class="btn btn-sm" id="bt-detail-retry">重新读取详情</button></div>';
      $('#bt-detail-retry').onclick = () => detail(type,id,unitPage);
    }
  }
  function renderDetail(task) {
    const d = task.details || {};
    let extra = '';
    if (task.type === 'article-sync') extra = `<div class="bt-detail-block"><h4>文章同步结果</h4><p>${d.scope === 'article' ? '单篇文章 #' + d.articleId : '当前项目的文章'} · 引擎结果：${esc(labels[d.engineStatus] || ({ ok:'成功', complete:'成功', busy:'已有同步执行', skipped:'未执行', 'range-exceeded':'范围超限' })[d.engineStatus] || '暂无结果')}</p>
      <p>历史月份已处理 ${d.months ?? '未知'}${d.totalMonths !== null && d.totalMonths !== undefined ? ` / ${d.totalMonths}` : ''} · 已执行批次 ${d.batches ?? '未知'} · 未处理文章范围 ${d.unprocessed ?? '未知'}</p>
      ${d.remainingMonths?.length ? `<p class="${d.autoContinue && ['queued','running'].includes(task.status) ? 'hint' : 'bt-error'}">剩余历史月份：${d.remainingMonths.map(esc).join('、')}。${d.autoContinue && ['queued','running'].includes(task.status) ? '已排队，将自动继续，无需再次提交。' : '未完成范围已保留，请核查失败原因后重新同步。'}</p>` : ''}
      ${d.hint ? '<p>本次范围超限，请返回文章监控，按单篇或较小月份范围同步。</p>' : ''}
      ${d.errors?.length ? `<p>同步反馈：${d.errors.map(esc).join('；')}</p>` : ''}
      ${d.current ? `<p>本月临时数据：${esc(labels[d.current.status] || d.current.status || '未知')} · GSC 截至 ${esc(d.current.gscEndDate || '未知')} · GA4 截至 ${esc(d.current.ga4EndDate || '未知')}</p>` : ''}</div>`;
    if (task.type === 'ai') extra = `<div class="bt-detail-block"><h4>${task.module === 'news' ? '资讯 / RSS 来源步骤' : '分析结果'}</h4>
      <div class="bt-counts">${Object.entries(d.counts || {}).map(([k,v])=>`<span>${esc(({ processed:'已处理',failed:'失败',skipped:'已跳过',selected:'已选入',reports:'报道',events:'事件',duplicates:'重复项',industry_news:'行业资讯',news_observation:'观察资讯' })[k] || k)}：${v}</span>`).join('')}</div>
      ${d.sources?.length ? `<ul class="bt-sources">${d.sources.map(s=>`<li><strong>${esc(s.name)}</strong>${tag(s.status)}<span>${s.cached ? '含已缓存材料' : '无缓存材料'} · 上次成功 ${fmt(s.lastSuccessAt)}</span>${s.errorCode ? `<span class="bt-error">${esc(s.errorCode)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">当前任务尚无逐来源结果。</p>'}
      ${d.warningCodes?.length ? `<p>结果提示：${d.warningCodes.map(esc).join('、')}</p>` : ''}<p class="hint">重试会按当前配置生成新的分析运行，原运行与结果保留。</p></div>`;
    if (task.type === 'operation') extra = `<div class="bt-detail-block"><h4>业务单元进度</h4><p>成功 ${d.counts?.succeeded ?? '未知'} · 失败 ${d.counts?.failed ?? '未知'} · 未处理 ${d.counts?.unprocessed ?? '未知'}</p>
      <p class="hint">停止仅阻止尚未提交的单元，已经提交的结果保留。重试只处理失败和未处理单元，继续沿用原有修订与保留期检查。</p>
      ${d.expired ? '<p>明细已超过保留期。</p>' : `<div class="bt-table-scroll"><table><thead><tr><th>单元</th><th>状态</th><th>尝试次数</th><th>失败代码</th></tr></thead><tbody>${(d.items || []).map(i=>`<tr><td><code>${esc(i.key)}</code></td><td>${esc(labels[i.status] || ({unprocessed:'未处理'})[i.status] || i.status)}</td><td>${i.attempts}</td><td>${esc(i.errorCode || '—')}</td></tr>`).join('')}</tbody></table></div>
      <div class="bt-unit-pager"><button class="btn btn-sm" id="bt-unit-prev" ${d.unitPage <= 1 ? 'disabled' : ''}>上一页单元</button><span>第 ${d.unitPage} 页 · 共 ${d.unitTotal} 个单元</span><button class="btn btn-sm" id="bt-unit-next" ${d.unitPage * d.unitPageSize >= d.unitTotal ? 'disabled' : ''}>下一页单元</button></div>`}</div>`;
    if (task.type === 'resource-sync') extra = `<div class="bt-detail-block"><h4>目录来源步骤</h4>${(d.sources || []).map(s=>`<p>${esc(s.source.toUpperCase())} · 上次成功 ${fmt(s.lastSuccessAt)}${s.failed ? ' · 最近尝试失败，保留上次目录' : ''}</p>`).join('')}${(d.errors || []).map(e=>`<p class="bt-error">${esc(e.source || '来源')}：${esc(e.message)}</p>`).join('')}</div>`;
    $('#bt-detail').innerHTML = `<section class="card bt-detail" aria-label="后台任务详情"><div class="bt-detail-heading"><div><span class="hint">任务详情 · ${esc(modules[task.module] || task.module)}</span><h3>${esc(task.title)} ${tag(task.status)}</h3></div><button class="btn btn-sm" id="bt-detail-close">关闭详情</button></div>
      <div class="bt-detail-facts"><div><span>项目 / 账号</span><strong>${esc(task.projectName || task.accountName || '—')}</strong></div><div><span>发起人</span><strong>${esc(task.actorName || '未记录')}</strong></div><div><span>当前阶段</span><strong>${progress(task)}</strong></div><div><span>耗时</span><strong>${duration(task.durationSeconds)}</strong></div></div>
      <p class="bt-times">创建 ${fmt(task.createdAt)} · 开始 ${fmt(task.startedAt)} · 结束 ${fmt(task.finishedAt)}</p>
      ${task.summary ? `<p class="${['failed','partial','uncertain'].includes(task.status) ? 'bt-error' : ''}">${esc(task.summary)}</p>` : ''}${task.errorCodes.length ? `<p>失败代码：${task.errorCodes.map(esc).join('、')}</p>` : ''}${extra}
      <div class="bt-detail-actions"><a class="btn" href="${esc(task.href)}">返回业务入口</a>${task.canRetry ? `<button class="btn btn-primary" id="bt-retry">${task.type === 'ai' ? '重试分析任务' : '重试失败 / 未处理部分'}</button>` : `<span class="hint">${esc(task.retryUnavailableReason || '')}</span>`}${task.canCancel ? '<button class="btn" id="bt-cancel">停止剩余单元</button>' : ''}</div>
      ${!task.canCancel ? `<p class="hint">${esc(task.cancelUnavailableReason)}</p>` : ''}<p class="bt-task-id">原始任务 ID：<code>${esc(task.type)}:${esc(task.id)}</code></p></section>`;
    $('#bt-detail-close').onclick = () => { revision++; selected = null; ['task_type','task_id','unit_page'].forEach(k=>q.delete(k)); syncLocation(); $('#bt-detail').innerHTML = ''; schedule(); };
    for (const action of ['retry','cancel']) if ($('#bt-' + action)) $('#bt-' + action).onclick = () => act(task,action);
    if ($('#bt-unit-prev')) $('#bt-unit-prev').onclick = () => detail(task.type,task.id,d.unitPage - 1);
    if ($('#bt-unit-next')) $('#bt-unit-next').onclick = () => detail(task.type,task.id,d.unitPage + 1);
  }
  async function act(task, action, confirmed = false) {
    if (pending) return;
    if (action === 'cancel' && !confirmed) return confirmDialog('停止剩余单元', '已提交的结果会保留，尚未提交的单元将停止。', () => act(task,action,true));
    pending = true; stop(); el.querySelectorAll('#bt-detail button').forEach(b=>b.disabled=true);
    const storageKey = `background-task-action:${task.key}:${action}`;
    const key = sessionStorage.getItem(storageKey) || new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date()).replaceAll('-','') + ':' + crypto.randomUUID();
    sessionStorage.setItem(storageKey,key);
    try {
      const result = await API.backgroundTaskAction(task.type,task.id,action,key);
      if (!current()) return;
      message(action === 'cancel' ? '停止请求已保存，已提交的结果保留。' : '重试请求已受理。');
      await detail(result.type,result.id); q.delete('as_of'); await load();
    } catch (error) { if (current()) { message(error.message + ' 可重新读取任务状态后重试。',true); await detail(task.type,task.id); } }
    finally { pending = false; if (current() && selected) renderDetail(selected); schedule(); }
  }
  async function load(manual = false) {
    stop(); if (manual) { failures = 0; q.delete('as_of'); }
    const request = ++revision;
    const params = { page: q.get('page') || '1', page_size: '25' };
    for (const [key, name] of [['type','type'],['project','project_id'],['account','account_id'],['status','status'],['as_of','as_of']]) if (q.get(key)) params[name]=q.get(key);
    try {
      const response = await API.backgroundTasks(params);
      if (!current() || request !== revision) return;
      data = response; failures = 0; q.set('as_of',data.asOf); syncLocation();
      if (data.page > 1 && !data.items.length && data.total) { q.set('page',String(Math.ceil(data.total / 25))); return load(); }
      $('#bt-count').textContent = `共 ${data.total} 条 · 按创建时间倒序`;
      $('#bt-table').innerHTML = data.items.length ? `<table><thead><tr><th>任务 / 模块</th><th>项目 / 账号</th><th>发起人</th><th>状态</th><th>执行进度</th><th>创建时间 / 耗时</th><th>操作</th></tr></thead><tbody>${data.items.map(t=>`<tr><td><strong>${esc(t.title)}</strong><span class="bt-cell-note">${esc(modules[t.module] || t.module)}</span></td><td>${esc(t.projectName || t.accountName || '未关联项目')}</td><td>${esc(t.actorName || '未记录')}</td><td>${tag(t.status)}</td><td>${progress(t)}${t.summary ? `<span class="bt-cell-note">${esc(t.summary)}</span>` : ''}</td><td>${fmt(t.createdAt)}<span class="bt-cell-note">耗时 ${duration(t.durationSeconds)}</span></td><td><button class="btn btn-sm" data-bt-type="${t.type}" data-bt-id="${esc(t.id)}">详情</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">当前筛选下没有任务记录。</div>';
      const pages = Math.max(1,Math.ceil(data.total / 25));
      $('#bt-pager').innerHTML = `<button class="btn btn-sm" id="bt-prev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${data.page} / ${pages} 页</span><button class="btn btn-sm" id="bt-next" ${data.page >= pages ? 'disabled' : ''}>下一页</button>`;
      for (const b of el.querySelectorAll('[data-bt-id]')) b.onclick=()=>detail(b.dataset.btType,b.dataset.btId);
      for (const [id,step] of [['bt-prev',-1],['bt-next',1]]) $('#'+id).onclick=()=>{q.set('page',String(data.page+step));syncLocation();load();};
      if (manual) message('任务记录已刷新。');
      if (q.get('task_type') && q.get('task_id')) await detail(q.get('task_type'),q.get('task_id'),Number(q.get('unit_page')) || 1);
    } catch { if (current() && request === revision) { failures++; message('任务记录读取失败，点击刷新可恢复。' + (failures >= 3 ? '自动跟踪已暂停。' : ''),true); } }
    finally { schedule(); }
  }
  for (const name of ['type','project','account','status']) $('#bt-'+name).onchange = () => {
    const value = $('#bt-'+name).value; value ? q.set(name,value) : q.delete(name);
    ['as_of','task_type','task_id','unit_page'].forEach(k=>q.delete(k)); q.set('page','1'); selected=null; $('#bt-detail').innerHTML=''; syncLocation(); load();
  };
  $('#bt-refresh').onclick=()=>{loadOptions();load(true);}; $('#bt-follow').onchange=schedule;
  await Promise.all([loadOptions(),load()]);
}
