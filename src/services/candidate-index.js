const {candidateHostname}=require('../lib/resource-domain');

function add(index,key,value) {
  if(!index.has(key))index.set(key,new Set());
  index.get(key).add(value);
}
// 按域名与来源身份索引，再沿主机后缀找域名属性，避免每个候选扫描整个目录。
function candidateIndex(resources,domains,projects) {
  const byId=new Map(resources.map(r=>[r.id,r])),exact=new Map(),suffix=new Map(),hosts=new Set();
  for(const d of domains){
    const r=byId.get(d.resource_id);if(!r||!d.hostname)continue;
    const host=d.hostname.replace(/^www\./,'');
    add(exact,host,r.id);
    if(r.source==='gsc'&&r.resource_key.startsWith('sc-domain:'))add(suffix,d.hostname,r.id);
    if(r.state==='available')hosts.add(d.hostname);
  }
  const projectHosts=new Map(),projectResources=new Map();
  for(const p of projects){
    const host=candidateHostname(p.website);
    if(host)add(projectHosts,host,p.id);
    else for(const source of ['gsc','ga4']){
      const account=p[`${source}_account_id`]??p.account_id,key=p[source==='gsc'?'gsc_site':'ga4_property_id'];
      if(account&&key)add(projectResources,JSON.stringify([source,account,key]),p.id);
    }
  }
  const summaries=new Map();
  function summary(rawHost) {
    const host=rawHost.replace(/^www\./,'');
    if(summaries.has(host))return summaries.get(host);
    const ids=new Set(exact.get(host)||[]),existing=new Set(projectHosts.get(host)||[]);
    let parent=host;
    while(parent.includes('.')){
      parent=parent.slice(parent.indexOf('.')+1);
      for(const id of suffix.get(parent)||[])ids.add(id);
    }
    const matched=[...ids].sort((a,b)=>a-b).map(id=>byId.get(id));
    for(const r of matched)for(const id of projectResources.get(JSON.stringify([r.source,r.account_id,r.resource_key]))||[])existing.add(id);
    const result={fingerprint:matched.map(r=>`${r.id}:${r.revision}:${r.state}`).join('|'),existing_project_ids:JSON.stringify([...existing].sort((a,b)=>a-b))};
    summaries.set(host,result);return result;
  }
  return {hosts,summary};
}
module.exports={candidateIndex};
