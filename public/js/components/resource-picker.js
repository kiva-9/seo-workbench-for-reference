import {API} from '../api.js';
import {initialResourceSelection,resourceMatchLabel} from './resource-choice.js';
import {createResourcePager} from './resource-pager.js';

const RESOURCE_PAGE_SIZE=50;
function sortedResources(resources,source,hostname) {
  return resources.filter(r=>r.source===source).map(r=>({r,matched:Boolean(resourceMatchLabel(r,hostname))}))
    .sort((a,b)=>Number(b.matched)-Number(a.matched)||a.r.resource_key.localeCompare(b.r.resource_key)||a.r.account_id-b.r.account_id).map(({r})=>r);
}
function resourceOptionsHtml(rows,chosen,hostname,{project=null,source,limit=RESOURCE_PAGE_SIZE,selectedResource=null,pageInfo=null}={}) {
  const visible=rows.slice(0,limit);
  // 已保存的来源始终可见，不能因分页而丢失当前选择。
  const selected=selectedResource||rows.find(r=>String(r.id)===String(chosen));
  if(selected&&!visible.includes(selected))visible.unshift(selected);
  return `${chosen==='keep'?`<label class="resource-option is-selected"><input type="radio" name="rp-${source}-choice" value="keep" checked><span class="resource-option-copy"><span class="resource-option-title">保留当前来源</span><span class="resource-option-meta">${esc(project[source==='gsc'?'gsc_site':'ga4_property_id'])} · 待核验</span></span></label>`:''}
    ${visible.map(r=>resourceOption(r,chosen,hostname)).join('')}
    <div class="resource-search-empty" id="rp-${source}-empty" ${rows.length||pageInfo?.loading?'hidden':''}>暂无匹配资源，可更换搜索条件或刷新账号目录。</div>
    ${!pageInfo&&rows.length>limit?`<button type="button" class="btn btn-sm resource-more" data-rp-more>显示更多资源（共 ${rows.length} 个）</button>`:''}
    <label class="resource-option resource-none ${chosen===''?'is-selected':''}"><input type="radio" name="rp-${source}-choice" value="" ${chosen===''?'checked':''}><span class="resource-option-copy"><span class="resource-option-title">${project?'明确停用此来源':'暂不配置此来源'}</span><span class="resource-option-meta">${project?'暂停取数，保留项目和历史指标':'可先使用另一个数据来源，之后再完善匹配'}</span></span></label>`;
}

function resourcePaginationHtml(info) {
  return `<div class="resource-search-status" role="status">${info.loading?'正在搜索资源…':info.error?`搜索失败：${esc(info.error)} <button type="button" class="btn btn-sm" data-rp-retry>重试</button>`:`共 ${info.total} 个 · 第 ${info.page} 页`}</div>
    <div class="resource-pagination"><button type="button" class="btn btn-sm" data-rp-page="${info.page-1}" ${info.loading||info.page<=1?'disabled':''}>上一页</button>
    <button type="button" class="btn btn-sm" data-rp-page="${info.page+1}" ${info.loading||info.page*info.page_size>=info.total?'disabled':''}>下一页</button></div>`;
}

function resourceOption(resource,selected,hostname) {
  const matched=resourceMatchLabel(resource,hostname);
  return `<label class="resource-option ${String(selected)===String(resource.id)?'is-selected':''}" data-resource-row="${resource.id}">
    <input type="radio" name="rp-${resource.source}-choice" value="${resource.id}" ${String(selected)===String(resource.id)?'checked':''}>
    <span class="resource-option-copy"><span class="resource-option-title">${esc(resource.display_name||resource.resource_key)}</span>
      <span class="resource-option-meta">${resource.source==='ga4'?`ID ${esc(resource.resource_key)}${resource.account_display_name?' · '+esc(resource.account_display_name):''}`:`${esc(resource.permission_level)} · ${esc(resource.resource_key)}`}</span>
      <span class="resource-option-account">${esc(resource.email)}${resource.hostnames.length?' · '+esc(resource.hostnames.join('、')):''}</span></span>
    ${matched?`<span class="tag tag-green resource-match-tag">${matched}</span>`:''}${resource.shared_scope?'<span class="tag tag-amber resource-match-tag">多网站</span>':''}</label>`;
}
export function resourcePickerHtml(resources,{project=null,hostname='',pages=null}={}) {
  return `<div class="resource-picker" data-hostname="${esc(hostname)}" data-has-project="${Boolean(project)}">
    <div class="resource-connection-status" id="rp-connection-status" role="status"></div>
    <div class="resource-columns">${['ga4','gsc'].map(source=>{
      const rows=pages?pages[source].ids.map(id=>resources.find(r=>r.id===id)).filter(Boolean):sortedResources(resources,source,hostname);
      // 自动选择必须依据全目录的匹配数量，不能把首批结果误当成唯一候选。
      const chosen=project?initialResourceSelection(resources,source,project,hostname):pages?(pages[source].recommended_id??''):initialResourceSelection(resources,source,null,hostname);
      return `<section class="resource-panel" aria-label="${source.toUpperCase()} 主资源">
        <div class="resource-panel-head"><span class="resource-source-icon ${source}">${source==='ga4'?'◉':'⌁'}</span><div><h4>${source.toUpperCase()} 主资源</h4><div class="resource-selection-summary" id="rp-${source}-summary"></div></div></div>
        <div class="resource-search"><input type="search" id="rp-${source}-search" aria-label="搜索 ${source.toUpperCase()} 资源" placeholder="${source==='ga4'?'搜索名称、Property ID、域名或账号':'搜索 Site URL、域名或账号'}"></div>
        <input type="hidden" id="rp-${source}" value="${chosen}">
        <div class="resource-options" role="radiogroup" aria-label="${source.toUpperCase()} 数据来源" data-source="${source}" data-keep-value="${esc(project?.[source==='gsc'?'gsc_site':'ga4_property_id']||'')}">
          ${resourceOptionsHtml(rows,chosen,hostname,{project,source,pageInfo:pages?.[source],selectedResource:resources.find(r=>r.id===chosen)})}
        </div>${pages?`<div class="resource-controls" data-source="${source}">${resourcePaginationHtml(pages[source])}</div>`:''}
        <div class="resource-selected-scope" id="rp-${source}-details"></div></section>`;
    }).join('')}</div>
    <label class="resource-ack" id="rp-shared-row" hidden><input type="checkbox" id="rp-shared">我确认该 GA4 资源包含多个网站，当前指标会按资源中的路径统计。</label>
    <label class="resource-ack" id="rp-unverified-row" hidden><input type="checkbox" id="rp-unverified">我已核对 GA4 来源范围，确认使用尚未完整读取网站信息的资源。</label>
  </div>`;
}
export function bindResourcePicker(root,resources,{pages=null,loadPage}={}) {
  const picker=root.querySelector('.resource-picker');
  const pager=pages?createResourcePager({resources,pages,loadPage,isActive:()=>picker.isConnected,onChange:source=>updateRemote(source)}):null;
  const byId=pager?.byId||new Map(resources.map(r=>[r.id,r]));
  const render=()=>{
    let count=0;
    for(const source of ['ga4','gsc']){
      const value=root.querySelector(`#rp-${source}`).value;
      const resource=byId.get(Number(value));
      const summary=root.querySelector(`#rp-${source}-summary`);
      summary.textContent=resource?`${resource.email} · ${source==='ga4'?'ID ':''}${resource.resource_key}`:value==='keep'?'保留当前来源 · 待核验':'尚未选择';
      summary.classList.toggle('is-connected',Boolean(resource));
      if(resource||value==='keep')count++;
      const scopeNote=resource?.scope_note||(source==='ga4'?'网站地址来自数据流配置；现有指标按路径统计，同一资源中的流量不会按网站隔离。':
        resource?.resource_key.startsWith('sc-domain:')?'域名属性覆盖该域名及子域名。':'URL 前缀仅覆盖完整前缀内的网址。');
      root.querySelector(`#rp-${source}-details`).innerHTML=resource?`<div>${esc(scopeNote)}</div>
        ${resource.stream_state!=='complete'?`<div class="resource-health-note">网站信息：${esc(({app_only:'仅 App 数据流',no_website:'网站地址缺失',pending:'读取中',error:'读取失败，保留上次结果'})[resource.stream_state]||resource.stream_state)}</div>`:''}`:'';
      root.querySelectorAll(`input[name="rp-${source}-choice"]`).forEach(radio=>radio.closest('.resource-option').classList.toggle('is-selected',radio.checked));
    }
    const status=root.querySelector('#rp-connection-status');status.classList.toggle('is-complete',count===2);
    status.textContent=`已选数据来源 ${count} / 2：${count===2?'GA4 与 GSC 均已选择，请核对来源范围后保存。':count===1?'已选择一个来源，可先保存单路选择。':'当前尚未选择来源。'}`;
    const ga4=byId.get(Number(root.querySelector('#rp-ga4').value));
    root.querySelector('#rp-shared-row').hidden=!ga4?.shared_scope;
    root.querySelector('#rp-unverified-row').hidden=!ga4||ga4.stream_state==='complete';
  };
  root.querySelectorAll('.resource-options').forEach(group=>group.onchange=event=>{
    const radio=event.target.closest('input[type=radio]');if(!radio)return;
    root.querySelector(`#rp-${group.dataset.source}`).value=radio.value;
    if(group.dataset.source==='ga4'){root.querySelector('#rp-shared').checked=false;root.querySelector('#rp-unverified').checked=false;}
    render();
  });
  function updateRemote(source) {
    const state=pager.states[source],chosen=root.querySelector(`#rp-${source}`).value;
    const group=root.querySelector(`.resource-options[data-source="${source}"]`);
    group.setAttribute('aria-busy',String(state.loading));
    group.innerHTML=resourceOptionsHtml(state.ids.map(id=>byId.get(id)),chosen,picker.dataset.hostname,{
      source,pageInfo:state,selectedResource:byId.get(Number(chosen)),
      project:picker.dataset.hasProject==='true'?{[source==='gsc'?'gsc_site':'ga4_property_id']:group.dataset.keepValue}:null,
    });
    group.scrollTop=0;
    picker.querySelector(`.resource-controls[data-source="${source}"]`).innerHTML=resourcePaginationHtml(state);
    render();
  }
  for(const source of ['gsc','ga4']){
    const search=root.querySelector(`#rp-${source}-search`);
    const group=root.querySelector(`.resource-options[data-source="${source}"]`),hostname=root.querySelector('.resource-picker').dataset.hostname;
    // 搜索回车只用于筛选，避免提交认领表单。
    search.onkeydown=event=>{if(event.key==='Enter')event.preventDefault();};
    if(pager){
      search.oninput=()=>pager.load(source,{q:search.value.trim(),page:1},250);
      picker.querySelector(`.resource-controls[data-source="${source}"]`).onclick=event=>{
        const button=event.target.closest('[data-rp-page],[data-rp-retry]');
        if(button&&!button.disabled)pager.load(source,{page:Number(button.dataset.rpPage)||pager.states[source].requested_page||1});
      };
      continue;
    }
    const rows=sortedResources(resources,source,hostname),searchText=new Map(rows.map(r=>[r.id,[r.email,r.display_name,r.account_display_name,r.resource_key,...r.hostnames].join(' ').toLowerCase()]));
    const project=root.querySelector('.resource-picker').dataset.hasProject==='true'?{[source==='gsc'?'gsc_site':'ga4_property_id']:group.dataset.keepValue}:null;
    let limit=RESOURCE_PAGE_SIZE;
    const updateChoices=()=>{
      const query=search.value.trim().toLowerCase(),filtered=rows.filter(r=>!query||searchText.get(r.id).includes(query));
      const chosen=root.querySelector(`#rp-${source}`).value;
      group.innerHTML=resourceOptionsHtml(filtered,chosen,hostname,{source,limit,project,selectedResource:byId.get(Number(chosen))});
      render();
    };
    group.onclick=event=>{if(event.target.closest('[data-rp-more]')){limit+=RESOURCE_PAGE_SIZE;updateChoices();}};
    search.oninput=()=>{limit=RESOURCE_PAGE_SIZE;updateChoices();};
  }
  render();
  return ()=>{
    const data={allow_shared_ga4:root.querySelector('#rp-shared').checked,allow_unverified_ga4:root.querySelector('#rp-unverified').checked};
    for(const source of ['gsc','ga4']){const value=root.querySelector(`#rp-${source}`).value;if(value!=='keep')data[`${source}_resource_id`]=value?Number(value):null;}
    return data;
  };
}
export async function openResourceMatches(projectId,onSaved) {
  const view=document.querySelector('#view'),hash=location.hash,previousModal=document.querySelector('#modal').firstChild;
  try{
    const data=await API.projectResourceMatches(projectId);
    if(!view.isConnected||location.hash!==hash||document.querySelector('#modal').firstChild!==previousModal)return;
    let hostname='';try{hostname=new URL(data.project.website).hostname;}catch{/* 无网站时仍可人工选择 */}
    openModal(`<div class="resource-matching-heading"><div><div class="resource-eyebrow">RESOURCE MATCHING</div><h3>项目资源匹配 · ${esc(data.project.name)}</h3><p>${esc(data.project.website||'选择项目的数据来源')}</p></div><button class="modal-x" onclick="closeModal()">×</button></div>
      <div class="resource-matching-note">可从不同 Google 账号分别选择 GA4 与 GSC。保存后锁定人工选择，目录刷新不会覆盖；停用会暂停对应来源，历史数据保留。</div>
      ${resourcePickerHtml(data.resources,{project:data.project,hostname,pages:data.resource_pages})}<div class="notice notice-warn" id="rp-error" hidden></div>
      <div class="form-actions resource-matching-actions"><button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" id="rp-save">保存并锁定匹配</button></div>`,true);
    const root=document.querySelector('#modal');root.classList.add('resource-matching-modal');
    const read=bindResourcePicker(root,data.resources,{pages:data.resource_pages,loadPage:(params,opts)=>API.projectResources(projectId,params,opts)});
    root.querySelector('#rp-save').onclick=async()=>{
      const button=root.querySelector('#rp-save');button.disabled=true;
      try{await API.saveProjectResourceMatches(projectId,{...read(),expected_config_revision:data.project.config_revision});if(!button.isConnected||!view.isConnected||location.hash!==hash)return;closeModal();toast('项目来源已保存','ok');onSaved?.();}
      catch(error){if(!button.isConnected)return;const message=root.querySelector('#rp-error');message.hidden=false;message.textContent=error.message;button.disabled=false;}
    };
  }catch(error){if(view.isConnected&&location.hash===hash)toast(error.message,'err');}
}
