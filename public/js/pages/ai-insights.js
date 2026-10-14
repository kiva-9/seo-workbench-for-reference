import {API} from '../api.js';
import {renderInsightDetail,feedbackHistory} from '../components/ai-insight-detail.js';
import {aiLoading,aiModuleLoading} from '../components/ai-loading.js';
import {insightTabs,insightModule,insightRoute,insightToolbar,bindInsightTabs,bindInsightProject} from '../components/ai-insight-tabs.js';
const names={news:'行业资讯',performance:'文章表现与优化',indexing:'Google 收录变化'};
const labels={not_requested:'尚未请求',rss_feed:'RSS 来源',budget_exceeded:'预算不足',sources_not_configured:'来源未配置',attention_not_configured:'关注词未配置',no_relevant_news:'没有相关资讯',sources_failed:'来源读取失败',review:'值得复盘',optimize:'优先优化',observe:'继续观察',observation:'继续观察',unknown:'无法判断',industry_news:'行业动态',news_observation:'资讯待核查',insufficient_material:'材料不足',unknown_date:'发布时间待核查',indexed:'当前已收录',not_indexed:'当前未收录',newly_indexed:'新收录',suspected_drop:'疑似掉收录',persistent_not_indexed:'持续未收录',needs_review:'口径变化需复核',check_failed:'检查失败',unconfigured:'尚未配置',no_news:'没有相关资讯',source_failed:'来源读取失败',queued:'排队中',running:'运行中',cached:'复用当天检查',succeeded:'已完成',partial:'部分完成',failed:'失败',cancelled:'已取消',uncertain:'结果或费用待核查',unread:'待查看',useful:'有用',ignored:'忽略',handled:'已处理',disabled:'未启用模型',synthetic:'合成演示',stored_metrics:'已保存指标',live:'接口结果'};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label=value=>labels[value]||value||'—';
const time=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'暂无';
const route=insightRoute;
const safeReturn=(value,fallback='#/ai-insights')=>typeof value==='string'&&/^#\/ai-insights(?:\?|$)/.test(value)?value:fallback;
const button=(text,attrs='')=>`<button type="button" class="btn" ${attrs}>${text}</button>`;
function runCounts(run){
  const counts=run.result?.counts;if(!counts)return '尚无处理计数';
  const terms={processed:'处理',articles:'文章',total_articles:'候选文章',attempted:'新检查',checked:'检查成功',cached:'复用',skipped:'跳过',failed:'失败',selected:'入选',relevant:'相关',filtered:'过滤',deduplicated:'去重',duplicates:'重复报道',deferred:'延后',model_failed:'模型降级'};
  return Object.entries(terms).filter(([key])=>typeof counts[key]==='number').map(([key,name])=>`${name} ${counts[key]}`).join(' · ')||'暂无适用计数';
}
function jsonText(value){return esc(JSON.stringify(value,null,2));}
function summary(card){
  const d=card.data||{};
  if(card.module==='indexing'&&card.category==='check_failed')return d.last_valid_state?`本次检查未完成。上次有效结果为「${label(d.last_valid_state)}」，当前状态仍需核查。`:'本次检查未完成，暂时无法判断收录状态。';
  return d.summary||d.model?.explanation?.summary||d.description||d.reason||'打开证据，查看事实、限制与核查建议。';
}
const number=value=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:2}):'未知';
function newsDate(card){
  const value=card.data?.published_at;
  return value?new Date(value).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}):'发布时间待核查';
}
function newsRelation(card){
  const d=card.data,keywords=d.relevance?.matched_keywords||[];
  if(!keywords.length)return '现有材料不足以确认项目相关性，待人工核查。';
  return `匹配关注词「${keywords.join('、')}」${d.relevance?.promotion?`；可结合「${d.relevance.promotion}」核查选题价值。`:'；适用性仍需核对。'}`;
}
function runHistory(data,pid){
  return `<details class="card ai-runs" data-activity><summary>运行记录与来源状态<span>处理日志、来源可用性与调用费用</span></summary>
    <p class="ai-setting-help">${data.synthetic?'合成演示数据，使用固定响应。':'基于已保存数据与检查快照。'}${data.external_enabled?'外部调用按项目授权及预算执行。':'外部调用关闭。'}${data.schedule_enabled?'每日调度已启用。':'仅手动运行。'}读取时间 ${esc(time(data.as_of))}。</p>
    ${data.runs.length?`<div class="ai-run-list">${data.runs.map(r=>`<div class="ai-run"><span>${esc(r.project_name)} · ${names[r.module]}</span><strong>${esc(label(r.status))}</strong><span>${esc(time(r.created_at))}</span><small>开始 ${esc(time(r.started_at))} · 结束 ${esc(time(r.finished_at))}<br>${runCounts(r)}${r.result?.counts?.empty_reason?' · '+esc(label(r.result.counts.empty_reason)):''}</small>${r.error_code?`<code>${esc(r.error_code)}</code>`:''}${pid&&['failed','partial','cancelled'].includes(r.status)?button('重试',`data-retry="${esc(r.id)}" data-module="${r.module}"`):''}${r.result?.counts?.sources?.length?`<details><summary>来源状态</summary>${r.result.counts.sources.map(s=>`<p>${esc(s.name)}：${esc(label(s.status))}${s.cached?' · 使用缓存':''}<br>最后成功 ${esc(time(s.last_success_at))}${s.error_code?' · '+esc(s.error_code):''}</p>`).join('')}</details>`:''}${r.result?.warnings?.length?`<details><summary>限制与失败分项</summary><pre>${jsonText(r.result.warnings)}</pre></details>`:''}</div>`).join('')}</div>`:'<p>暂无运行。进入项目后可分别运行三个模块。</p>'}
    ${data.usage.length?`<div class="ai-usage">${data.usage.map(u=>`<span>${esc(u.kind)}：${u.calls} 次 · ${esc(label(u.status))}${u.kind==='model'?` · 预留 $${Number(u.reserved_cost).toFixed(4)} · ${u.unknown_cost_count?'实际费用含未知':`实际 $${Number(u.actual_cost).toFixed(4)}`}`:''}</span>`).join('')}</div>`:''}</details>`;
}

export async function renderAiInsights(el){
  const key=location.hash,params=new URLSearchParams(key.split('?')[1]||''),pid=Number(params.get('project'))||null,id=params.get('insight');
  const previousRestoration=history.scrollRestoration;history.scrollRestoration='manual';
  const module=insightModule(params);
  let disposed=false,restoring=true,timer,feedbackDraft,projectCombo;const active=()=>!disposed&&el.isConnected&&location.hash===key;
  const saveScroll=()=>{if(!active()||restoring)return;try{sessionStorage.setItem(`ai-scroll:${key}`,String(window.scrollY));}catch{}};
  const cleanup=()=>{disposed=true;clearTimeout(timer);projectCombo?.destroy();window.removeEventListener('scroll',saveScroll);window.removeEventListener('seo-route-change',cleanup);history.scrollRestoration=previousRestoration;};
  window.addEventListener('scroll',saveScroll,{passive:true});window.addEventListener('seo-route-change',cleanup,{once:true});
  const previous=el._aiView;
  const partial=previous&&previous.pid===pid&&previous.key!==key&&!id&&el.querySelector('#ai-module-panel');
  const focusTab=!!partial&&el.querySelector('[role="tab"]:focus');
  if(!partial)el.innerHTML=aiLoading(id?'detail':pid?'project':'overview',module);
  else {const node=el.querySelector('#ai-module-panel');node.setAttribute('aria-busy','true');node.innerHTML=aiModuleLoading(module);el.querySelectorAll('[data-ai-tab]').forEach(tab=>{const chosen=tab.dataset.aiTab===module;tab.setAttribute('aria-selected',String(chosen));tab.tabIndex=chosen?0:-1;});}

  const query={module};for(const [k,v]of params)if(['offset','category','feedback'].some(field=>k===`${module}_${field}`)||(module==='news'&&k==='news_date'))query[k]=v;
  async function load(){return pid?API.aiProject(pid,query):API.aiOverview(query);}
  try{
    if(id){await detail();return;}
    const data=await load();
    if(!active())return;render(data,!!partial);

    function render(data,partial=false){
      restoring=true;
      const root=safeReturn(params.get('from'));
      const html=`<div class="ai-page">
        <div class="ai-heading"><div>${pid?`<a href="${esc(root)}" class="ai-back">← 返回主看板</a>`:''}<h2>${pid?esc(data.project?.name):'AI 见解'}${data.synthetic?'<span class="ai-demo-badge">合成演示</span>':''}</h2><p>${pid?'与项目相关的资讯、文章机会和收录变化':`${data.projects.length} 个授权项目的资讯与内容机会`}</p></div><div class="ai-heading-actions">${button('刷新','data-refresh')}<a class="btn" href="#/ai-settings${pid?'?tab=projects&project='+pid:''}">AI 功能配置</a></div></div>
        ${!data.projects.length?'<div class="card ai-empty">暂无可访问项目。获得项目权限后，这里会显示对应结果。</div>':''}
        ${insightToolbar(data,pid,module)}
        <div id="ai-module-panel" role="tabpanel" tabindex="0" aria-labelledby="ai-tab-${module}">${section(module,names[module],data.modules[module],data.runs)}</div>
        ${runHistory(data,pid)}
        </div>`;
      projectCombo?.destroy();
      if(partial){
        const next=document.createElement('div');next.innerHTML=html;
        el.querySelector('.ai-heading>div').innerHTML=next.querySelector('.ai-heading>div').innerHTML;
        for(const selector of ['.ai-insight-toolbar','#ai-module-panel','[data-activity]'])el.querySelector(selector).replaceWith(next.querySelector(selector));
      }else el.innerHTML=html;
      el._aiView={key,pid,data};
      bindActivity(data);
      bindInsightTabs(el,params,next=>{saveScroll();location.hash=next;});
      projectCombo=bindInsightProject(el,data,pid,selected=>{saveScroll();const next=new URLSearchParams(params);next.set('module',module);for(const name of Object.keys(insightTabs))next.delete(`${name}_offset`);if(selected){next.set('project',selected);if(!pid)next.set('from',key);}else {next.delete('project');next.delete('from');}location.hash=route(next);});
      if(focusTab)el.querySelector('#ai-tab-'+module)?.focus({preventScroll:true});

      el.querySelector('[data-refresh]').onclick=()=>{saveScroll();cleanup();renderAiInsights(el);};
      el.querySelectorAll('[data-filter]').forEach(select=>{select.onchange=()=>{saveScroll();const next=new URLSearchParams(params);next.set(select.dataset.filter,select.value);next.delete(`${select.dataset.module}_offset`);location.hash=route(next);};});
      el.querySelectorAll('[data-page]').forEach(btn=>btn.onclick=()=>{saveScroll();const next=new URLSearchParams(params);next.set(`${btn.dataset.module}_offset`,btn.dataset.page);location.hash=route(next);});
      bindRunButtons();
      const savedScroll=sessionStorage.getItem(`ai-scroll:${key}`);requestAnimationFrame(()=>{if(active()){if(savedScroll!==null)window.scrollTo(0,Number(savedScroll));else window.scrollTo(0,0);requestAnimationFrame(()=>{restoring=false;});}});
      clearTimeout(timer);
      pollPending(data);
    }
    function section(module,name,group,runs){
      const category=params.get(`${module}_category`)||'',feedback=params.get(`${module}_feedback`)||'';
      const filtered=category||feedback||(module==='news'&&params.get('news_date'));
      const cats=module==='performance'?['review','optimize','observe','unknown']:module==='news'?['industry_news','news_observation']:['indexed','not_indexed','newly_indexed','suspected_drop','persistent_not_indexed','needs_review','unknown','check_failed'];
      const pending=runs.some(r=>r.module===module&&['queued','running'].includes(r.status));
      const latest=runs.find(r=>r.module===module),reason=latest?.result?.counts?.empty_reason;
      const newsEmpty=({sources_not_configured:'尚未配置资讯来源。请在 AI 功能配置中添加已批准的来源。',attention_not_configured:'尚未设置关注方向。请在 AI 功能配置中填写项目关注词。',no_relevant_news:'当前关注方向暂无匹配资讯。',sources_failed:'资讯暂未更新，可展开运行与来源状态查看原因。'})[reason]||(['failed','partial','uncertain'].includes(latest?.status)?'资讯暂未更新，可展开运行与来源状态查看原因。':'还没有相关资讯。可在 AI 功能配置中添加关注词和资讯来源。');
      let items=group.items.map(card=>cardHtml(card,module)).join('');
      if(module==='news'){
        const days=new Map();
        for(const card of group.items){const day=newsDate(card);if(!days.has(day))days.set(day,[]);days.get(day).push(card);}
        items=[...days].sort(([a],[b])=>a==='发布时间待核查'?1:b==='发布时间待核查'?-1:b.localeCompare(a)).map(([day,cards])=>`<div class="ai-news-day"><div class="ai-news-date"><strong>${esc(day==='发布时间待核查'?day:day.slice(5).replace('-','月')+'日')}</strong><span>${day==='发布时间待核查'?'':day.slice(0,4)+' 年 · '}${cards.length} 条</span></div><div class="ai-news-stories">${cards.map(card=>cardHtml(card,module)).join('')}</div></div>`).join('');
      }
      return `<section class="card ai-module" data-insight-module="${module}" id="ai-${module}"><div class="ai-module-heading"><div class="ai-module-title"><h3>${name}</h3><span class="ai-total">${group.total} 条</span>${pending?'<span class="ai-pill" role="status">正在更新</span>':''}</div><div class="ai-module-actions">${pid?button('更新内容',`data-run data-module="${module}"`):''}<details class="ai-filter-panel"><summary>${filtered?'已筛选':'筛选'}</summary><div class="ai-filters"><label>分类<select aria-label="${name}分类" data-filter="${module}_category" data-module="${module}"><option value="">全部分类</option>${cats.map(c=>`<option value="${c}" ${c===category?'selected':''}>${esc(label(c))}</option>`).join('')}</select></label><label>处理<select aria-label="${name}处理状态" data-filter="${module}_feedback" data-module="${module}"><option value="">全部状态</option>${['unread','useful','ignored','handled'].map(c=>`<option value="${c}" ${c===feedback?'selected':''}>${label(c)}</option>`).join('')}</select></label>${module==='news'?`<label class="ai-date">发布日期（上海）<input type="date" aria-label="资讯发布日期" data-filter="news_date" data-module="news" value="${esc(params.get('news_date')||'')}"></label>`:''}</div></details></div></div>
        ${group.counts?.length?`<nav class="ai-module-stats" aria-label="${name}分类统计">${group.counts.map(c=>{const next=new URLSearchParams(params);next.set(`${module}_category`,c.category);next.delete(`${module}_offset`);return `<a href="${esc(route(next))}" class="ai-stat" data-category="${esc(c.category)}" ${category===c.category?'aria-current="true"':''}>${esc(label(c.category))}<strong>${c.count}</strong></a>`;}).join('')}</nav>`:''}
        ${group.total>group.limit||group.offset?`<nav class="ai-pagination" aria-label="${insightTabs[module]}分页">${button('上一页',`data-page="${Math.max(0,group.offset-group.limit)}" data-module="${module}" ${group.offset?'':'disabled'}`)}<span>${group.items.length?`${group.offset+1}–${Math.min(group.offset+group.items.length,group.total)} / ${group.total}`:'0 条'}${!group.items.length&&group.total?' · 共 '+group.total+' 条':''}</span>${button('下一页',`data-page="${group.offset+group.limit}" data-module="${module}" ${group.offset+group.items.length<group.total?'':'disabled'}`)}</nav>`:''}
        <div class="ai-cards">${items||`<p class="ai-empty">${filtered?'当前筛选下暂无内容。':module==='news'?newsEmpty:module==='performance'?'还没有文章见解。进入项目后，使用已保存指标分析文章表现。':'还没有收录结果。进入项目后检查已关联的文章。'}</p>`}</div></section>`;
    }
    function cardHtml(card,module){
      const projectParams=new URLSearchParams(params);projectParams.set('project',card.project_id);projectParams.set('module',module);if(!pid)projectParams.set('from',key);
      for(const name of Object.keys(insightTabs))projectParams.delete(`${name}_offset`);
      const projectHref=route(projectParams),detailParams=new URLSearchParams({project:card.project_id,insight:card.id,return:key,from:pid?safeReturn(params.get('from')):key});
      const detailHref=route(detailParams),d=card.data;
      const category=module!=='news'||card.category==='news_observation'?`<span class="ai-category" data-category="${esc(card.category)}">${card.identity_changed?'历史：':''}${esc(label(card.category))}</span>`:'';
      const cardSummary=['news','performance'].includes(module)&&d.model?.status==='succeeded'&&d.model.explanation?.summary?d.model.explanation.summary:summary(card);
      const content=typeof cardSummary==='string'?cardSummary:JSON.stringify(cardSummary);
      const feedback=card.feedback&&card.feedback!=='unread'?`<span class="ai-feedback-label">${esc(label(card.feedback))}</span>`:'';
      const history=card.identity_changed?'<p class="ai-history-note">文章地址或检查口径已变化，请重新核查。</p>':card.latest_run_id&&card.latest_run_id!==card.run_id?'<p class="ai-history-note">本轮尚无有效结论，保留上次结果。</p>':'';
      if(module==='news')return `<article class="ai-card ai-news-card"><div class="ai-card-meta"><div><span>${esc(d.publisher||d.reports?.[0]?.publisher||d.reports?.[0]?.source_name||'资讯来源')}</span>${category}${d.reports?.length>1?`<span>另有 ${d.reports.length-1} 条报道</span>`:''}</div><a href="${esc(projectHref)}">${esc(card.project_name)}</a></div><h4><a href="${esc(detailHref)}">${esc(card.title)}</a></h4><p class="ai-card-summary">${esc(content)}</p><div class="ai-news-relation"><p>项目关联：${esc(newsRelation(card))}</p><a href="${esc(detailHref)}">查看内容与证据 →</a>${feedback}</div>${history}</article>`;
      return `<article class="ai-card"><div class="ai-card-meta"><div>${category}${feedback}</div>${!pid?`<a href="${esc(projectHref)}">${esc(card.project_name)}</a>`:''}</div><h4><a href="${esc(detailHref)}">${esc(card.title)}</a></h4>${module==='performance'?`<p class="ai-card-facts">${esc(d.period?.baseline||'未知月份')} → ${esc(d.period?.comparison||'未知月份')}${d.history?`<span>历史 ${esc(d.history.start)}–${esc(d.history.end)} · ${d.history.comparable_months} 个可比月</span>`:""}<span>点击 <strong>${number(d.sources?.gsc?.baseline?.values?.clicks)} → ${number(d.sources?.gsc?.current?.values?.clicks)}</strong></span></p>`:''}<p class="ai-card-summary">${esc(content)}</p><div class="ai-card-bottom"><a href="${esc(detailHref)}">${module==='performance'?'查看建议与证据':'查看状态与证据'} →</a></div>${history}</article>`;
    }
    function bindRunButtons(){
      el.querySelectorAll('[data-run],[data-retry]').forEach(btn=>btn.onclick=async()=>{
        btn.disabled=true;try{const run=await API.aiRun(pid,btn.dataset.module,btn.dataset.retry);if(active()){btn.textContent=label(run.status);timer=setTimeout(async()=>{try{if(active()){const next=await load();if(active())render(next);}}catch(error){if(active())showError(error);}},700);}}
        catch(error){if(active())showError(error);}finally{if(active())btn.disabled=false;}
      });
    }
    function pollPending(data){
      const pending=data.runs.filter(r=>['queued','running'].includes(r.status));if(!pending.length)return;
      timer=setTimeout(async()=>{try{
        const states=await Promise.all(pending.map(run=>API.aiRunStatus(pid||run.project_id,run.id)));if(!active())return;
        if(states.some(run=>!['queued','running'].includes(run.status))){const next=await load();if(active())render(next);}else pollPending(data);
      }catch(error){if(active())showError(error);}},1800);
    }
    function bindActivity(data){
      const node=el.querySelector('[data-activity]');
      node.ontoggle=async()=>{if(!node.open||data.activity_loaded)return;data.activity_loaded=true;
        try{const activity=await API.aiActivity(pid);if(!active()||!node.isConnected)return;data.runs=activity.runs;data.usage=activity.usage;node.outerHTML=runHistory(data,pid);el.querySelector('[data-activity]').open=true;bindActivity(data);bindRunButtons();}
        catch(error){if(active()&&node.isConnected){data.activity_loaded=false;const p=document.createElement('p');p.textContent=error.message;node.append(p);}}
      };
    }

  }catch(error){if(active())showError(error);}
  function showError(error){el.innerHTML=`<section class="card ai-page" role="alert"><h2>暂时无法读取见解</h2><p>${esc(error.message)}</p><a href="#/ai-insights">返回主看板</a></section>`;}
  async function detail(){
    if(!pid)throw new Error('缺少项目');const card=await API.aiDetail(pid,id);if(!active())return;
    const value=summary(card);let currentAction=card.feedback;
    const projectParams=new URLSearchParams(params);projectParams.delete('insight');projectParams.delete('return');
    el.innerHTML=renderInsightDetail({card,back:safeReturn(params.get('return'),route(projectParams)),summary:typeof value==='string'?value:JSON.stringify(value),label,time});
    const noteInput=el.querySelector('[data-feedback-note]');if(feedbackDraft!==undefined)noteInput.value=feedbackDraft;
    noteInput.oninput=()=>{feedbackDraft=noteInput.value;};
    el.querySelector('[data-inspect]')?.addEventListener('click',async event=>{
      const btn=event.currentTarget;btn.disabled=true;
      async function check(run){
        if(!active())return;
        const message=`检查任务${label(run.status)}。${run.result?.counts?.cached?'复用了当天检查，未新增外部请求。':''}${run.error_code?' '+run.error_code:''}`;
        el.querySelector('[data-inspect-status]').textContent=message;
        if(['queued','running'].includes(run.status)){
          timer=setTimeout(async()=>{try{await check(await API.aiRunStatus(pid,run.id));}catch(error){if(active()){el.querySelector('[data-inspect-status]').textContent=error.message;btn.disabled=false;}}},1800);
        }else{
          saveScroll();await detail();
          if(active())el.querySelector('[data-inspect-status]').textContent=message;
        }
      }
      try{await check(await API.aiRun(pid,'indexing',undefined,Number(btn.dataset.inspect)));}
      catch(error){if(active()){el.querySelector('[data-inspect-status]').textContent=error.message;btn.disabled=false;}}
    });
    async function saveFeedback(action){
      const controls=el.querySelectorAll('[data-action],[data-save-note]');controls.forEach(btn=>btn.disabled=true);
      const note=el.querySelector('[data-feedback-note]').value;
      let committed=false;try{
        await API.aiFeedback(pid,id,{action,note});if(!active())return;
        committed=true;
        currentAction=action;el.querySelector('[data-feedback-status]').textContent='已保存：'+label(action);
        el.querySelectorAll('[data-action]').forEach(btn=>btn.setAttribute('aria-pressed',String(btn.dataset.action===action)));
        const updated=await API.aiDetail(pid,id);if(active())el.querySelector('[data-feedback-history]').innerHTML=feedbackHistory(updated.feedback_history,label,time);
      }catch(error){if(active()){if([401,403,404].includes(error.status))showError(error);else el.querySelector('[data-feedback-status]').textContent=(committed?'已保存，处理记录读取未完成：':'保存未完成：')+error.message;}}
      finally{if(active())controls.forEach(btn=>btn.disabled=false);}
    }
    el.querySelectorAll('[data-action]').forEach(btn=>btn.onclick=()=>saveFeedback(btn.dataset.action));
    el.querySelector('[data-save-note]').onclick=()=>saveFeedback(currentAction);
    requestAnimationFrame(()=>{if(active()){window.scrollTo(0,Number(sessionStorage.getItem(`ai-scroll:${key}`)||0));requestAnimationFrame(()=>{restoring=false;});}});
  }
}
