export function initialResourceSelection(resources,source,project=null,hostname='') {
  const rows=resources.filter(r=>r.source===source);
  if(project){
    const key=project[source==='gsc'?'gsc_site':'ga4_property_id'];
    const account=project[`${source}_account_id`]??project.account_id;
    return rows.find(r=>r.resource_key===key&&r.account_id===account)?.id??(key?'keep':'');
  }
  const recommended=hostname?rows.filter(r=>resourceMatchLabel(r,hostname)):rows;
  const identities=new Set(recommended.map(r=>r.resource_key));
  const available=recommended.find(r=>!r.shared_scope&&r.stream_state==='complete');
  return identities.size===1&&available?available.id:'';
}
export function resourceMatchLabel(resource,hostname) {
  if(!hostname)return '';
  const canonical=value=>value.toLowerCase().replace(/\.$/,'').replace(/^www\./,'');
  const host=canonical(hostname);
  if(resource.hostnames.some(value=>canonical(value)===host))return '域名一致';
  if(resource.source==='gsc'&&resource.resource_key.startsWith('sc-domain:')&&host.endsWith('.'+resource.resource_key.slice(10).toLowerCase().replace(/\.$/,'')))return '覆盖此域名';
  return '';
}
