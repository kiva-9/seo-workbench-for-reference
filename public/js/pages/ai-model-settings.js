import {API} from '../api.js';
import {aiLoading} from '../components/ai-loading.js';
import {renderInsightSettings} from '../components/ai-insight-settings.js';
import {createCombo} from '../components/combo.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=(name,label,value)=>`<label>${label}<input name="${name}" type="number" min="0" max="${name==='call_ceiling'?10:1000}" step="any" value="${esc(value)}"></label>`;
export async function renderAiModelSettings(el){
  let key=location.hash,projectEpoch=0,disposed=false,projectCombo;const active=()=>!disposed&&el.isConnected&&location.hash===key;
  window.addEventListener('seo-route-change',()=>{disposed=true;projectCombo?.destroy();},{once:true});
  const admin=window.currentUser?.role==='admin',params=new URLSearchParams(key.split('?')[1]||'');
  el.innerHTML=aiLoading('configuration');
  const [metadata,settings]=await Promise.all([API.aiConfiguration(),admin?API.aiModelSettings():null]);if(!active())return;
  let current=settings,editorId=settings?.selected_model_id,tab=params.get('tab')||(admin?'models':'projects');
  if(!admin)tab='projects';
  el.innerHTML=`<div class="ai-page ai-function-page"><header class="ai-heading"><div><span class="ai-eyebrow">AI 工作空间</span><h2>AI 功能配置</h2><p>模型、外部调用、项目背景与资讯来源都在这里。</p></div><div class="ai-heading-actions"><button type="button" class="btn" data-reload-ai-config>重新读取</button><a class="btn" href="#/ai-insights">查看 AI 见解</a></div></header><nav class="ai-config-tabs" aria-label="AI 功能配置">${admin?'<button type="button" class="btn" data-main-tab="models">模型与调用开关</button>':''}<button type="button" class="btn" data-main-tab="projects">项目、RSS 与关键词</button></nav>${admin?'<div data-main-panel="models"></div>':''}<div data-main-panel="projects"><section class="card ai-project-picker"><div><h3>选择项目</h3><p class="ai-setting-help">按项目维护关注方向、RSS、文章分析和运行设置。</p></div><div class="ai-project-search"><span>项目</span><div data-project-picker></div></div></section><div data-project-config><section class="card ai-empty">选择一个项目，即可找到关注词、排除词和资讯来源。</section></div></div></div>`;
  el.querySelector('[data-reload-ai-config]').onclick=()=>window.refreshView();
  const updateURL=()=>{if(!active())return;params.set('tab',tab);history.replaceState(history.state,'','#/ai-settings?'+params);key=location.hash;};
  const showTab=name=>{if(!active())return;tab=name;el.querySelectorAll('[data-main-panel]').forEach(n=>n.hidden=n.dataset.mainPanel!==tab);el.querySelectorAll('[data-main-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mainTab===tab)));updateURL();};
  el.querySelectorAll('[data-main-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.mainTab));showTab(tab==='projects'?'projects':'models');
  const projectHost=el.querySelector('[data-project-picker]');
  projectCombo=createCombo(projectHost,{name:'ai_configuration_project',placeholder:'搜索项目名称…',label:'搜索 AI 配置项目'});
  const selected=metadata.projects.some(p=>p.id===Number(params.get('project')))?params.get('project'):'';
  projectCombo.setOptions(metadata.projects.map(p=>({value:p.id,label:p.name})),selected);
  async function loadProject(){
    if(!active())return;
    const pid=Number(projectCombo.getValue()),epoch=++projectEpoch,slot=el.querySelector('[data-project-config]');
    if(pid)params.set('project',pid);else params.delete('project');updateURL();
    if(!pid){slot.innerHTML='<section class="card ai-empty">选择一个项目，即可找到关注词、排除词和资讯来源。</section>';return;}
    slot.innerHTML='<section class="card ai-settings ai-loading" role="status"><h3>正在读取项目配置…</h3><span class="ai-loading-line title"></span><span class="ai-loading-line control"></span><span class="ai-loading-line control"></span></section>';
    try{const value=await API.aiSettings(pid);if(!active()||epoch!==projectEpoch)return;renderInsightSettings(slot,{pid,projectName:metadata.projects.find(p=>p.id===pid)?.name||'',current:value,modelConfigured:metadata.model_configured,embedded:true,initialTab:params.get('section')||'news',active:()=>active()&&epoch===projectEpoch});}
    catch(e){if(active()&&epoch===projectEpoch)slot.innerHTML=`<section class="card" role="alert">${esc(e.message)}</section>`;}
  }
  projectHost.addEventListener('change',loadProject);
  if(params.get('project'))await loadProject();
  if(admin&&active())renderModels();

  function renderModels(message=''){
    const panel=el.querySelector('[data-main-panel="models"]'),profiles=current.profiles;
    const primary=profiles.find(p=>p.id===current.selected_model_id),backup=profiles.find(p=>p.id===current.fallback_model_id);
    const options=(selected,empty)=>`<option value="">${empty}</option>`+profiles.filter(p=>p.enabled&&p.key_configured||p.id===selected).map(p=>`<option value="${p.id}" ${selected===p.id?'selected':''} ${p.enabled&&p.key_configured?'':'disabled'}>${esc(p.label)} · ${esc(p.model_name)}</option>`).join('');
    panel.innerHTML=`<div class="ai-settings-overview"><section class="card"><span class="ai-eyebrow">可管理多个条目</span><strong>${profiles.length} 个模型</strong></section><section class="card"><span class="ai-eyebrow">使用模型</span><strong>${esc(primary?.label||'尚未选择')}</strong></section><section class="card"><span class="ai-eyebrow">Fallback 模型</span><strong>${esc(backup?.label||'未设置备用')}</strong></section></div><section class="card ai-runtime-switch"><div><h3>外部调用开关</h3><p class="ai-setting-help">控制 AI 见解的模型请求、资讯抓取和 Google 收录检查。项目外发授权仍单独检查；自动日任务独立设置。</p></div><div><label class="ai-switch"><input type="checkbox" role="switch" aria-label="外部调用开关" data-external-switch ${current.external_enabled?'checked':''}><span>${current.external_enabled?'已开启':'已关闭'}</span></label><button type="button" class="btn" data-save-external>保存调用开关</button></div><p role="status" data-external-status></p></section><section class="card ai-model-selection ai-settings"><h3>选择使用模型与备用模型</h3><div class="ai-form-grid"><label>主模型<select data-primary>${options(current.selected_model_id,'选择主模型')}</select></label><label>Fallback 模型<select data-fallback>${options(current.fallback_model_id,'不使用备用模型')}</select></label></div><label class="ai-checkbox"><input type="checkbox" data-model-enabled ${current.enabled?'checked':''}>启用所选模型配置</label><p class="ai-setting-help">主模型明确拒绝或完整响应未通过校验时，最多尝试一次备用模型。每次尝试独立记账；结果或费用不确定时暂停，保留已保存事实。</p><button type="button" class="btn btn-primary" data-save-selection>保存模型选择</button><p role="status" data-model-status>${esc(message||`配置版本 ${current.version} · 密钥加密保存，读取时不回显。`)}</p></section><div class="ai-model-layout"><section class="card ai-model-list"><div class="ai-section-heading"><h3>模型条目</h3><button type="button" class="btn" data-add-model>新增模型</button></div>${profiles.length?profiles.map(p=>`<article class="ai-model-entry ${p.id===current.selected_model_id?'is-primary':''}"><div><strong>${esc(p.label)}</strong><p>${esc(p.model_name||'尚未填写模型 ID')}</p><small>${esc(p.base_url)} · ${p.key_configured?'密钥已配置':'密钥待配置'}</small></div><span class="ai-pill">${p.id===current.selected_model_id?'主模型':p.id===current.fallback_model_id?'备用':p.enabled?'可用':'停用'}</span><button type="button" class="btn" data-edit-model="${p.id}">编辑</button></article>`).join(''):'<p class="ai-empty">先新增模型条目，再选择主模型。</p>'}</section><section class="card ai-settings ai-model-editor" data-model-editor></section></div>`;
    panel.querySelector('[data-save-external]').onclick=async event=>{
      const button=event.currentTarget,status=panel.querySelector('[data-external-status]');button.disabled=true;
      try{const value=await API.aiSaveRuntimeSettings({version:current.external_configuration.version,external_enabled:panel.querySelector('[data-external-switch]').checked});if(!active())return;current.external_enabled=value.external_enabled;current.external_configuration=value;panel.querySelector('.ai-switch span').textContent=value.external_enabled?'已开启':'已关闭';status.textContent='已保存。后续请求立即使用新的开关状态。';}
      catch(e){if(active())status.textContent=e.message;}finally{if(active())button.disabled=false;}
    };
    panel.querySelector('[data-save-selection]').onclick=()=>saveAll();
    panel.querySelectorAll('[data-edit-model]').forEach(b=>b.onclick=()=>{captureEditor();editorId=b.dataset.editModel;renderEditor();});
    panel.querySelector('[data-add-model]').onclick=()=>{captureEditor();if(current.profiles.length>=20){panel.querySelector('[data-model-status]').textContent='最多二十个模型条目';return;}editorId=crypto.randomUUID();current.profiles.push({id:editorId,label:'新模型',base_url:'https://api.openai.com/v1',model_name:'',key_configured:false,enabled:false,input_rate:null,output_rate:null,call_ceiling:0});renderModels();};
    renderEditor();
  }
  function renderEditor(){
    const slot=el.querySelector('[data-model-editor]'),p=current.profiles.find(p=>p.id===editorId);
    if(!p){slot.innerHTML='<h3>编辑模型</h3><p class="ai-empty">从左侧选择条目，或新增一个模型。</p>';return;}
    slot.innerHTML=`<form data-profile-form autocomplete="off"><span class="ai-eyebrow">模型条目</span><h3>编辑 ${esc(p.label)}</h3><label>显示名称<input name="label" required maxlength="160" value="${esc(p.label)}" placeholder="例如 日常分析模型"></label><label>Base URL<input name="base_url" type="url" required maxlength="2000" value="${esc(p.base_url)}" placeholder="https://api.openai.com/v1"><small>公共 HTTPS API 基础地址，自动追加 /chat/completions。</small></label><label>模型 ID<input name="model_name" maxlength="200" value="${esc(p.model_name)}" placeholder="供应商提供的模型名称"></label><label>API Key<input name="api_key" type="password" maxlength="4096" autocomplete="new-password" spellcheck="false" value="${esc(p.api_key||'')}" placeholder="${p.key_configured?'留空保留已保存密钥':'输入 API Key'}"><small>更换供应商地址需重新填写密钥；现有密钥不回显。</small></label><label class="ai-checkbox"><input name="clear_key" type="checkbox" ${p.clear_key?'checked':''}>清除密钥并停用条目</label><label class="ai-checkbox"><input name="enabled" type="checkbox" ${p.enabled?'checked':''}>该条目可用</label><details><summary>价格与费用上限（可选）</summary><p class="ai-setting-help">输入/输出价格为美元 / 百万 token。项目选择次数模式或测试不限额时，可以留空，费用保持未知。</p><div class="ai-form-grid">${money('input_rate','输入价格',p.input_rate)}${money('output_rate','输出价格',p.output_rate)}${money('call_ceiling','单次费用上限（美元）',p.call_ceiling)}</div></details><div class="ai-heading-actions"><button type="submit" class="btn btn-primary">保存此条目</button><button type="button" class="btn" data-remove-model>移除条目</button></div><p role="status" data-editor-status>保存配置不会测试连接或发起模型请求。</p></form>`;
    slot.querySelector('form').onsubmit=event=>{event.preventDefault();saveAll();};
    slot.querySelector('[data-remove-model]').onclick=()=>{captureEditor();if([current.selected_model_id,current.fallback_model_id].includes(editorId)){slot.querySelector('[data-editor-status]').textContent='先改选主模型或备用模型并保存，再移除此条目。';return;}current.profiles=current.profiles.filter(p=>p.id!==editorId);editorId=null;saveAll(false);};
  }
  function captureEditor(){
    const form=el.querySelector('[data-profile-form]'),p=current.profiles.find(p=>p.id===editorId);if(!form||!p)return;
    for(const name of ['label','base_url','model_name','api_key'])p[name]=form.elements[name].value;
    for(const name of ['input_rate','output_rate','call_ceiling'])p[name]=form.elements[name].value===''?(name==='call_ceiling'?0:null):Number(form.elements[name].value);
    p.clear_key=form.elements.clear_key.checked;p.enabled=p.clear_key?false:form.elements.enabled.checked;p.key_configured=p.clear_key?false:!!p.api_key||p.key_configured;
  }
  async function saveAll(capture=true){
    if(capture)captureEditor();const panel=el.querySelector('[data-main-panel="models"]'),status=panel.querySelector('[data-model-status]');
    const selected=panel.querySelector('[data-primary]').value||null,fallback=panel.querySelector('[data-fallback]').value||null;
    const controls=[...panel.querySelectorAll('button')];controls.forEach(b=>b.disabled=true);
    try{
      const profiles=current.profiles.map(({key_configured,...p})=>p);
      const saved=await API.aiSaveModelSettings({version:current.version,profiles,selected_model_id:selected,fallback_model_id:current.profiles.find(p=>p.id===fallback)?.enabled?fallback:null,enabled:panel.querySelector('[data-model-enabled]').checked&&!!current.profiles.find(p=>p.id===selected)?.enabled});if(!active())return;
      current=saved;metadata.model_configured=saved.enabled&&saved.key_configured;renderModels('已保存模型配置，未发起外部调用。');
    }catch(e){if(active()){status.textContent=e.message;el.querySelector('[data-editor-status]')?.replaceChildren(document.createTextNode(e.message));}}
    finally{if(active())controls.forEach(b=>b.disabled=false);}
  }
}
