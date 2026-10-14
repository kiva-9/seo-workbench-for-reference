export const candidateLabels={pending:'待认领',existing:'已有项目',claimed:'已认领',unavailable:'资源不可用',hidden:'已忽略',all:'全部'};
export const candidateHeading=`<div class="page-head"><div><h2>项目候选</h2><p class="page-desc">所有成员都能查看并认领。认领后，你会成为项目负责人。</p></div>
  <div class="page-actions"><a class="btn" href="#/accounts">账号与目录</a><a class="btn" href="#/projects">我的项目</a></div></div>`;
export function candidateToolbar({status='pending',q='',counts={}}={}) {
  return `<div class="candidate-toolbar"><div class="candidate-tabs" role="group" aria-label="候选状态">
    ${Object.entries(candidateLabels).map(([key,label])=>`<button class="btn btn-sm ${status===key?'btn-primary':''}" data-filter="${key}" aria-pressed="${status===key}">${label}${counts[key]!==undefined?` <span>${counts[key]}</span>`:''}</button>`).join('')}</div>
    <form id="candidate-search"><input aria-label="搜索网站" name="q" placeholder="搜索网站域名" value="${esc(q)}"><button class="btn">搜索</button><button type="button" class="btn" id="candidate-reset">重置</button><button type="button" class="btn" id="candidate-refresh">刷新</button></form></div>`;
}
