import {API} from '../api.js';
import {beginPageRender} from '../page-lifecycle.js';
import {resourcePickerHtml,bindResourcePicker} from '../components/resource-picker.js';
import {candidateLabels as labels,candidateHeading,candidateToolbar} from '../components/candidate-layout.js';
import {renderPageLoading,renderPageError} from '../components/page-loading.js';

let latestCounts={},latestIdentity='',latestQuery='';
export async function renderProjectCandidates(el) {
  const isCurrent=beginPageRender(el),params=new URLSearchParams(location.hash.split('?')[1]||'');
  const status=params.get('status')||'pending',q=params.get('q')||'',page=Number(params.get('page')||1);
  const identity=JSON.stringify([window.currentUser?.id,window.currentUser?.role]);
  if(identity!==latestIdentity){latestCounts={};latestIdentity=identity;}
  const query={status,q,page,page_size:30},cached=API.peekProjectCandidates(query);
  const navigateEarly=patch=>{location.hash='#/project-candidates?'+new URLSearchParams({status,q,page,...patch});};
  const bindToolbar=navigate=>{
    el.querySelectorAll('[data-filter]').forEach(button=>{
      button.onclick=()=>navigate({status:button.dataset.filter,q:'',page:1});
      button.onpointerenter=button.onfocus=()=>API.projectCandidates({status:button.dataset.filter,q:'',page:1,page_size:30}).catch(()=>{});
    });
    el.querySelector('#candidate-search').onsubmit=e=>{e.preventDefault();navigate({q:new FormData(e.target).get('q').trim(),page:1});};
    el.querySelectorAll('#candidate-reset,[data-reset-search]').forEach(button=>button.onclick=()=>navigate({q:'',page:1}));
    el.querySelector('#candidate-refresh').onclick=()=>{API.invalidateReads();renderProjectCandidates(el);};
  };
  if(!cached){renderPageLoading(el,'project-candidates',{status,q,counts:q===latestQuery?latestCounts:{}});bindToolbar(navigateEarly);}
  let data;
  try{data=cached||await API.projectCandidates(query);}
  catch(error){if(isCurrent())renderPageError(el,error,()=>renderProjectCandidates(el));return;}
  if(!isCurrent())return;latestCounts=data.counts;latestQuery=q;
  const navigate=(patch)=>{const next=new URLSearchParams({status,q,page:data.page,...patch});location.hash='#/project-candidates?'+next;};
  el.innerHTML=`${candidateHeading}${candidateToolbar({status,q,counts:data.counts})}
    <div class="candidate-list">${data.items.length?data.items.map(c=>`<article class="card candidate-card"><div><div class="candidate-title">${esc(c.hostname)} <span class="tag ${c.status==='pending'?'tag-blue':'tag-gray'}">${labels[c.status]}</span></div>
      <div class="muted">${esc(c.website)} · ${c.resource_count} 个匹配资源${c.existing_count?` · ${c.existing_count} 个已有项目`:''}</div>
      ${c.claimed_by?`<div class="hint">确认人：${esc(c.claimed_by)}</div>`:''}</div><div class="candidate-actions">
      ${c.resolved_project_id?`<a class="btn btn-primary" href="#/project?id=${c.resolved_project_id}">打开项目</a><button class="btn" data-confirm="${c.id}">关联资源</button>`:`<button class="btn ${c.status==='pending'?'btn-primary':''}" data-confirm="${c.id}">${c.status==='pending'?'认领项目':c.status==='existing'?'关联项目':'查看资源'}</button>`}
      <button class="btn btn-sm" data-hide="${c.id}" data-hidden="${c.hidden?0:1}">${c.hidden?'恢复显示':'个人忽略'}</button></div></article>`).join(''):
      `<div class="card empty"><div class="big">${status==='pending'?'◇':'☷'}</div>${q?'没有匹配的网站':status==='pending'?'当前没有待认领项目':'当前没有这类候选'}<p class="muted">${q?'可重置搜索，查看当前标签下的全部候选。':'连接账号并完成资源目录同步后，可访问的网站会出现在这里。'}</p>${q?'<button class="btn" data-reset-search>重置搜索</button>':'<a class="btn" href="#/accounts">前往账号中心</a>'}</div>`}</div>
    <div class="candidate-pagination"><span class="muted">共 ${data.total} 个 · 第 ${data.page} 页</span><div><button class="btn btn-sm" id="candidate-prev" ${data.page<=1?'disabled':''}>上一页</button><button class="btn btn-sm" id="candidate-next" ${data.page*data.page_size>=data.total?'disabled':''}>下一页</button></div></div>`;
  bindToolbar(navigate);
  el.querySelector('#candidate-prev').onclick=()=>navigate({page:data.page-1});el.querySelector('#candidate-next').onclick=()=>navigate({page:data.page+1});
  el.querySelectorAll('[data-hide]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await API.hideProjectCandidate(button.dataset.hide,button.dataset.hidden==='1');if(isCurrent())renderProjectCandidates(el);}catch(error){if(isCurrent()){toast(error.message,'err');button.disabled=false;}}});
  el.querySelectorAll('[data-confirm]').forEach(button=>button.onclick=()=>openClaim(data.items.find(c=>c.id===Number(button.dataset.confirm)),isCurrent));
  if(data.page*data.page_size<data.total)API.projectCandidates({...query,page:data.page+1}).catch(()=>{});
}
async function openClaim(item,isCurrent) {
  const id=item.id;
  openModal(`<div class="modal-head"><h3>${item.status==='pending'?'认领项目':'候选资源'} · ${esc(item.hostname)}</h3><button class="modal-x" onclick="closeModal()">×</button></div>
    <div class="claim-loading" role="status" aria-busy="true"><p class="hint">正在读取可用资源与项目…</p><div class="resource-columns">${['GA4','GSC'].map(source=>`<section class="resource-panel"><div class="resource-panel-head"><h4>${source} 主资源</h4></div><div class="loading-card-body"><span class="loading-line"></span><span class="loading-line"></span><span class="loading-line"></span></div></section>`).join('')}</div></div>`,true);
  const modal=document.querySelector('#modal'),pending=modal.querySelector('.claim-loading');modal.classList.add('resource-matching-modal');
  const active=()=>isCurrent()&&pending.isConnected;
  try{
    const candidate=await API.projectCandidate(id);if(!active())return;
    const projects=candidate.projects;
    const targets=candidate.resolved_project_id?projects.filter(p=>p.id===candidate.resolved_project_id):candidate.existing_count?projects.filter(p=>candidate.accessible_project_ids.includes(p.id)):projects;
    const locked=(candidate.status==='claimed'&&!candidate.resolved_project_id)||candidate.status==='unavailable'||(candidate.status==='existing'&&!targets.length);
    openModal(`<div class="resource-matching-heading"><div><div class="resource-eyebrow">RESOURCE MATCHING</div><h3>${candidate.status==='pending'?'认领项目':'候选资源'} · ${esc(candidate.hostname)}</h3><p>${esc(candidate.website)}</p></div><button class="modal-x" onclick="closeModal()">×</button></div>
      <div class="resource-matching-note">可从不同 Google 账号分别选择 GA4 与 GSC。确认后授予该项目资源使用权限；人工选择不会被后续目录刷新覆盖。</div>
      ${locked?`<div class="notice notice-warn">${candidate.status==='existing'?'已对应其他成员的项目，请联系负责人或管理员关联。':candidate.status==='claimed'?'该候选已被认领。':'当前来源均不可用，请由账号连接者刷新目录或重新授权。'}</div>`:''}
      <form id="claim-form"><div class="form-row"><label>创建或关联</label><select id="claim-target" ${locked?'disabled':''}>
        ${candidate.status==='pending'?'<option value="">创建新项目 · 我作为负责人</option>':''}${targets.map(p=>`<option value="${p.id}">关联：${esc(p.name)}</option>`).join('')}</select></div>
      <div id="claim-new-fields" ${candidate.status==='pending'?'':'hidden'}><div class="form-grid"><div class="form-row"><label>项目名称 *</label><input name="name" value="${esc(candidate.hostname)}" maxlength="200"></div>
        <div class="form-row"><label>项目域名</label><input value="${esc(candidate.hostname)}" readonly aria-label="项目域名"><div class="hint">来自已发现资源，自动带入项目。</div></div></div></div>
      <div id="claim-existing-note" class="notice notice-warn" ${candidate.status==='pending'?'hidden':''}>现有负责人保持不变。默认保留已有来源，选中资源会获得项目使用授权。
        <label class="resource-ack"><input type="checkbox" id="claim-replace">替换已有来源（会使旧指标需要重新核验）</label></div>
      ${resourcePickerHtml(candidate.resources,{hostname:candidate.hostname,pages:candidate.resource_pages})}<div class="notice notice-warn" id="claim-error" hidden></div>
      <div class="form-actions resource-matching-actions"><button type="button" class="btn" onclick="closeModal()">取消</button>${locked?'':`<button class="btn btn-primary" id="claim-save">确认${candidate.status==='pending'?'认领':'关联'}并锁定匹配</button>`}</div></form>`,true);
    document.querySelector('#modal').classList.add('resource-matching-modal');
    const form=document.querySelector('#claim-form'),read=bindResourcePicker(form,candidate.resources,{
      pages:candidate.resource_pages,loadPage:(params,opts)=>API.candidateResources(id,params,opts),
    }),key=crypto.randomUUID();
    const target=form.querySelector('#claim-target');target.onchange=()=>{form.querySelector('#claim-new-fields').hidden=Boolean(target.value);form.querySelector('#claim-existing-note').hidden=!target.value;};
    form.onsubmit=async event=>{
      event.preventDefault();if(locked)return;
      const button=form.querySelector('#claim-save');button.disabled=true;
      const input={...read(),expected_revision:candidate.revision,idempotency_key:key};
      if(target.value){input.project_id=Number(target.value);input.replace_existing=form.querySelector('#claim-replace').checked;}
      else Object.assign(input,Object.fromEntries(new FormData(form)));
      try{const result=await API.claimProjectCandidate(id,input);if(!form.isConnected||!isCurrent())return;closeModal();toast(target.value?'已关联项目，负责人保持不变':'已认领，你是项目负责人','ok');location.hash='#/project?id='+result.project.id;}
      catch(error){if(!form.isConnected||!isCurrent())return;const box=form.querySelector('#claim-error');box.hidden=false;box.textContent=error.message;button.disabled=false;if(error.status===409)button.textContent='请关闭并刷新候选';}
    };
  }catch(error){if(active()){pending.removeAttribute('aria-busy');pending.innerHTML=`<div class="empty" role="alert">加载失败：${esc(error.message)}<p><button class="btn" data-claim-retry>重试</button></p></div>`;pending.querySelector('[data-claim-retry]').onclick=()=>openClaim(item,isCurrent);}}
}
