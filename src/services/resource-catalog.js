const { candidateHostname } = require('../lib/resource-domain');
const {candidateIndex}=require('./candidate-index');
const {withAtomicGuard}=require('../lib/atomic-guard');
const refreshes=new WeakMap();

// 候选记录网站与关联状态，www 别名共用匹配结果，完整资源身份保持不变。
function refreshProjectCandidates(db) {
  // 同一后端的刷新排队读取最新快照，避免迟到快照覆盖。
  const previous=refreshes.get(db)||Promise.resolve();
  const current=previous.catch(()=>{}).then(()=>refreshCandidates(db));
  refreshes.set(db,current);
  return current.finally(()=>{if(refreshes.get(db)===current)refreshes.delete(db);});
}
async function refreshCandidates(db,attempt=0) {
  const backend = db.db;
  const state=await backend.prepare('SELECT input_revision,built_revision FROM candidate_catalog_state WHERE id=1').get();
  if(state.input_revision===state.built_revision)return;
  const [snapshot,projects,resources,domains,candidates]=await backend.batch([
    backend.prepare('SELECT input_revision FROM candidate_catalog_state WHERE id=1').bind(),
    backend.prepare('SELECT id,website,gsc_account_id,ga4_account_id,account_id,gsc_site,ga4_property_id FROM projects ORDER BY id').bind(),
    backend.prepare('SELECT id,account_id,source,resource_key,revision,state FROM google_resources').bind(),
    backend.prepare('SELECT resource_id,hostname FROM google_resource_domains').bind(),
    backend.prepare('SELECT id,hostname,revision,fingerprint,existing_project_ids FROM project_candidates').bind(),
  ]);
  const index=candidateIndex(resources.results,domains.results,projects.results);
  const known=new Set(candidates.results.map(c=>c.hostname)),writes=[];
  const at = new Date().toISOString();
  const newHosts=[...index.hosts].filter(h=>!known.has(h)).sort();
  for(let i=0;i<newHosts.length;i+=100){
    const rows=newHosts.slice(i,i+100).map(hostname=>({hostname,...index.summary(hostname)}));
    writes.push(backend.prepare(`INSERT INTO project_candidates(hostname,website,fingerprint,existing_project_ids,revision,created_at,updated_at)
      SELECT json_extract(value,'$.hostname'),'https://'||json_extract(value,'$.hostname')||'/',json_extract(value,'$.fingerprint'),json_extract(value,'$.existing_project_ids'),
        1+(json_extract(value,'$.fingerprint')<>'')+(json_extract(value,'$.existing_project_ids')<>'[]'),?,? FROM json_each(?) WHERE 1
      ON CONFLICT(hostname) DO NOTHING`).bind(at,at,JSON.stringify(rows)));
  }
  const changes=candidates.results.flatMap(c=>{
    const next=index.summary(c.hostname),bump=Number(next.fingerprint!==c.fingerprint)+Number(next.existing_project_ids!==c.existing_project_ids);
    return bump?[{id:c.id,revision:c.revision,bump,...next}]:[];
  });
  for(let i=0;i<changes.length;i+=100){
    writes.push(backend.prepare(`UPDATE project_candidates AS c SET fingerprint=json_extract(change.value,'$.fingerprint'),
      existing_project_ids=json_extract(change.value,'$.existing_project_ids'),revision=c.revision+json_extract(change.value,'$.bump'),updated_at=?
      FROM json_each(?) AS change WHERE c.id=json_extract(change.value,'$.id') AND c.revision=json_extract(change.value,'$.revision')`).bind(at,JSON.stringify(changes.slice(i,i+100))));
  }
  // 版本检查与投影提交同事务：迟到快照整体回滚，不能把新目录标成已处理。
  const guards=withAtomicGuard(backend,[],`SELECT input_revision=? FROM candidate_catalog_state WHERE id=1`,[snapshot.results[0].input_revision]);
  if(changes.length)guards.push(...withAtomicGuard(backend,[],`SELECT NOT EXISTS (
    SELECT 1 FROM json_each(?) v LEFT JOIN project_candidates c ON c.id=json_extract(v.value,'$.id')
    WHERE c.id IS NULL OR c.revision<>json_extract(v.value,'$.revision'))`,[JSON.stringify(changes.map(({id,revision})=>({id,revision})))]));
  writes.push(backend.prepare('UPDATE candidate_catalog_state SET built_revision=input_revision WHERE id=1').bind());
  try { await backend.batch([...guards,...writes]); }
  catch(error){
    if(!/CHECK constraint failed/.test(error.message))throw error;
    if(attempt<2)return refreshCandidates(db,attempt+1);
    throw Object.assign(new Error('候选状态正在变化，请重试'),{status:409});
  }
}

function resourceDto(row) {
  const {domains_json,...resource} = row;
  const domains = JSON.parse(domains_json||'[]');
  const hostnames = [...new Set(domains.map(d=>d.hostname).filter(Boolean))];
  return {...resource,domains,hostnames,shared_scope:row.source==='ga4'&&new Set(hostnames.map(candidateHostname)).size>1,
    scope_note:row.source==='ga4'?'网站地址来自数据流配置；现有指标按路径统计，同一资源中的流量不会按网站隔离。':
      (row.resource_key.startsWith('sc-domain:')?'域名属性覆盖该域名及子域名。':'URL 前缀仅覆盖完整前缀内的网址。')};
}
module.exports = {refreshProjectCandidates,resourceDto};
