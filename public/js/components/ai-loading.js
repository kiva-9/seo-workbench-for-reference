const line=(width='')=>`<span class="ai-loading-line ${width}" aria-hidden="true"></span>`;
const story=()=>`<div class="ai-loading-story">${line('short')}${line('title')}${line()}${line('medium')}</div>`;
export function aiModuleLoading(module){
  return `<div class="ai-module-loading" role="status" aria-label="正在读取${{news:'行业资讯',performance:'文章表现',indexing:'收录变化'}[module]}">${Array.from({length:module==='news'?2:3},story).join('')}</div>`;
}
export function aiLoading(kind='overview',module='news'){
  if(!['news','performance','indexing'].includes(module))module='news';
  const heading=`<div class="ai-heading"><div><h2>${kind==='configuration'?'AI 功能配置':kind==='detail'?'见解详情':kind==='project'?'项目 AI 见解':'AI 见解'}</h2><p role="status">${kind==='configuration'?'正在读取模型、调用开关与项目配置…':kind==='detail'?'正在读取保存的结论与证据…':'正在读取当前授权项目的见解…'}</p></div></div>`;
  if(kind==='configuration')return `<div class="ai-page ai-function-page ai-loading" aria-busy="true">${heading}<div class="ai-config-tabs">${line('control')}${line('control')}</div><div class="ai-settings-overview">${Array.from({length:3},()=>`<section class="card">${line('short')}${line('title')}</section>`).join('')}</div><div class="ai-model-layout"><section class="card">${Array.from({length:3},story).join('')}</section><section class="card">${line('title')}${Array.from({length:5},()=>line('control')).join('')}</section></div></div>`;
  if(kind==='detail')return `<div class="ai-page ai-detail ai-loading" aria-busy="true">${heading}<div class="ai-detail-layout"><div class="ai-detail-content"><section class="card">${story()}${story()}</section><section class="card">${line('title')}${story()}</section></div><aside class="card">${line('title')}${line('control')}${line('control')}${line()}</aside></div></div>`;
  return `<div class="ai-page ai-loading" aria-busy="true">${heading}<div class="ai-insight-toolbar"><div class="ai-insight-tabs" aria-label="AI 见解模块">${Object.entries({news:'行业资讯',performance:'文章监控',indexing:'收录监控'}).map(([id,name])=>`<span class="ai-loading-tab" ${id===module?'data-selected':''}>${name}</span>`).join('')}</div>${line('short')}</div><section class="card ai-module" data-insight-module="${module}"><h3>${{news:'行业资讯',performance:'文章表现与优化',indexing:'Google 收录变化'}[module]}</h3>${aiModuleLoading(module)}</section></div>`;
}
