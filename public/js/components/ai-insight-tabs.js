import {createCombo} from './combo.js';
export const insightTabs={news:'行业资讯',performance:'文章监控',indexing:'收录监控'};
export const insightModule=params=>Object.hasOwn(insightTabs,params.get('module'))?params.get('module'):'news';
export const insightRoute=params=>'#/ai-insights'+(params.toString()?'?'+params:'');
export function tabParams(params,module){const next=new URLSearchParams(params);next.set('module',module);return next;}
export function insightToolbar(data,pid,module){
  return `<div class="ai-insight-toolbar"><div class="ai-insight-tabs" role="tablist" aria-label="AI 见解模块">${Object.entries(insightTabs).map(([id,name])=>`<button type="button" role="tab" id="ai-tab-${id}" data-ai-tab="${id}" aria-controls="ai-module-panel" aria-selected="${module===id}" tabindex="${module===id?'0':'-1'}"><span>${name}</span><span class="ai-tab-count">${data.tab_totals?.[id]??'—'}</span></button>`).join('')}</div><div class="ai-insight-project"><span>项目</span><div data-ai-project></div></div></div>`;
}
export function bindInsightProject(el,data,pid,onSelect){
  const host=el.querySelector('[data-ai-project]'),combo=createCombo(host,{name:'ai_project',placeholder:'搜索项目名称…',label:'搜索 AI 见解项目'});
  combo.setOptions([{value:'',label:'全部授权项目'},...data.projects.map(p=>({value:p.id,label:p.name}))],pid||'');
  host.addEventListener('change',()=>onSelect(combo.getValue()));
  return combo;
}
export function bindInsightTabs(el,params,onNavigate){
  const tabs=[...el.querySelectorAll('[data-ai-tab]')];
  function select(tab){onNavigate(insightRoute(tabParams(params,tab.dataset.aiTab)));}
  for(const tab of tabs){
    tab.onclick=()=>select(tab);
    tab.onkeydown=event=>{
      const index=tabs.indexOf(tab),last=tabs.length-1;
      const next={ArrowRight:(index+1)%tabs.length,ArrowLeft:(index+last)%tabs.length,Home:0,End:last}[event.key];
      if(next===undefined)return;event.preventDefault();tabs[next].focus();select(tabs[next]);
    };
  }
}
