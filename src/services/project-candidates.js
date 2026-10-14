const {createHash} = require('node:crypto');
const {withAtomicGuard} = require('../lib/atomic-guard');
const {validateBusinessFields} = require('./mcp-write');
const {buildProjectConfiguration} = require('./project-configuration');
const {checkResourceBinding,resourceGrantStatement} = require('./project-resource-access');
const {refreshProjectCandidates,resourceDto} = require('./resource-catalog');
const {resourcePickerPages}=require('./resource-picker');

function problem(status,message) {return Object.assign(new Error(message),{status});}
function candidateStatus(candidate) {
  if(candidate.resolved_project_id)return 'claimed';
  if(JSON.parse(candidate.existing_project_ids||'[]').length)return 'existing';
  return candidate.resource_count===0?'unavailable':'pending';
}
async function candidateList(db,user) {
  await refreshProjectCandidates(db);
  const [candidates,projects]=await Promise.all([db.listProjectCandidates(user.id),db.listCandidateProjects(user)]);
  const accessible=new Set(projects.map(p=>p.id));
  return candidates.map(c=>candidateDto(c,accessible));
}
async function candidatePage(db,user,filters) {
  await refreshProjectCandidates(db);
  const [result,projects]=await Promise.all([db.pageProjectCandidates(user.id,filters),db.listCandidateProjects(user)]);
  const accessible=new Set(projects.map(p=>p.id));
  return {...result,items:result.items.map(c=>candidateDto(c,accessible))};
}
function candidateDto(c,accessible) {
  return {id:c.id,hostname:c.canonical_hostname,website:c.website,revision:c.revision,status:candidateStatus(c),hidden:Boolean(c.hidden),
    resource_count:c.resource_count,existing_count:JSON.parse(c.existing_project_ids).length,
    accessible_project_ids:JSON.parse(c.existing_project_ids).filter(id=>accessible.has(id)),
    resolved_project_id:accessible.has(c.resolved_project_id)?c.resolved_project_id:null,
    claimed_by:c.claimed_by_name||c.claimed_by_email||null};
}
async function candidateDetail(db,id,user,{compactResources=false}={}) {
  await refreshProjectCandidates(db);
  const [candidate,projects]=await Promise.all([db.getProjectCandidateSummary(id,user.id),db.listCandidateProjects(user)]);
  if(!candidate)throw problem(404,'候选不存在');
  return {...candidateDto(candidate,new Set(projects.map(p=>p.id))),projects,
    ...await resourcePickerPages(db,candidate.canonical_hostname,{compact:compactResources})};
}
function selectedResources(resources,input) {
  const selected=[];
  for(const source of ['gsc','ga4']){
    const id=input[`${source}_resource_id`];
    if(id===null||id===undefined||id==='')continue;
    const resource=resources.find(r=>r.id===Number(id)&&r.source===source&&r.state==='available');
    if(!resource)throw problem(400,'选择的资源不可用或不在当前授权目录中');
    if(resourceDto(resource).shared_scope&&input.allow_shared_ga4!==true)throw problem(400,'该 GA4 资源包含多个网站，请先确认按资源整体统计的范围');
    if(resource.source==='ga4'&&resource.stream_state!=='complete'&&input.allow_unverified_ga4!==true)throw problem(400,'GA4 网站信息尚未完整核验，请先确认来源范围');
    selected.push(resource);
  }
  return selected;
}
function configurationFromResources(resources) {
  const gsc=resources.find(r=>r.source==='gsc'),ga4=resources.find(r=>r.source==='ga4');
  return {gsc_account_id:gsc?.account_id??null,gsc_site:gsc?.resource_key??null,ga4_account_id:ga4?.account_id??null,ga4_property_id:ga4?.resource_key??null};
}
function projectAccessSql(alias='p') {
  return `EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.deleted_at IS NULL AND (u.role='admin' OR ${alias}.owner_user_id=u.id OR EXISTS(SELECT 1 FROM project_copywriters w WHERE w.project_id=${alias}.id AND w.user_id=u.id AND w.revoked_at IS NULL)))`;
}
async function claimCandidate(db,id,input,user) {
  if(!Number.isSafeInteger(input.expected_revision)||!/^[-a-zA-Z0-9_]{8,100}$/.test(input.idempotency_key||''))throw problem(400,'请提供候选版本和有效的确认请求标识');
  await refreshProjectCandidates(db);
  const candidate=await db.getProjectCandidate(id);
  if(!candidate)throw problem(404,'候选不存在');
  id=candidate.id;
  // 重试回读同一结果；相同请求标识不允许更换目标或配置。
  const canonical={...input};delete canonical.expected_revision;
  const hash=createHash('sha256').update(JSON.stringify(Object.keys(canonical).sort().map(k=>[k,canonical[k]]))).digest('hex');
  if(candidate.resolved_project_id){
    if(candidate.claimed_by===user.id&&candidate.claim_key===input.idempotency_key&&candidate.claim_hash===hash&&await db.canAccessProject(candidate.resolved_project_id,user.id,user.role==='admin'))return {project:await db.getProject(candidate.resolved_project_id),replayed:true};
    if(Number(input.project_id)!==candidate.resolved_project_id||!await db.canAccessProject(candidate.resolved_project_id,user.id,user.role==='admin'))throw problem(409,'该候选已经被认领，请刷新列表');
  }
  if(candidate.revision!==input.expected_revision)throw problem(409,'候选资源或关联状态已变化，请刷新后确认');
  const ids=['gsc','ga4'].map(source=>Number(input[`${source}_resource_id`])).filter(Number.isSafeInteger);
  const resources=selectedResources(await db.resourcesByIds(ids),input);
  if(!resources.length)throw problem(400,'至少选择一个可用数据来源');
  const backend=db.db,at=new Date().toISOString();
  const actor={user_id:user.id,current_role:user.role};
  const config=configurationFromResources(resources);
  const existingIds=JSON.parse(candidate.existing_project_ids);
  let target=null,business=null;
  const guards=[];
  if(input.project_id){
    const projectId=Number(input.project_id);
    if(!await db.canAccessProject(projectId,user.id,user.role==='admin'))throw problem(403,'无权关联此项目');
    target=await db.getProject(projectId);
    if(!target)throw problem(404,'项目不存在');
    if(existingIds.length&&!existingIds.includes(projectId)&&candidate.resolved_project_id!==projectId)throw problem(409,'该候选已对应其他项目，请选择列表中的现有项目');
    // 关联先保留原人工来源，只有明确勾选替换才写入选中来源。
    if(input.replace_existing!==true){
      for(const field of ['gsc_account_id','gsc_site','ga4_account_id','ga4_property_id'])config[field]=target[field];
    }
  } else {
    if(existingIds.length)throw problem(409,'已存在对应项目，请关联已有项目，负责人保持不变');
    const fields={};for(const key of ['name','status','notes'])if(input[key]!==undefined&&input[key]!=='')fields[key]=input[key];
    fields.name=String(input.name||'').trim();fields.website=candidate.website;
    try{business=validateBusinessFields('project',fields);}catch(error){throw problem(400,error.issues?.[0]?.message||error.message);}
  }
  for(const resource of resources){
    const binding=await checkResourceBinding(db,{projectId:target?.id,source:resource.source,accountId:resource.account_id,resourceKey:resource.resource_key,actor,trustedResources:resources});
    guards.push(...withAtomicGuard(backend,[],binding.sql,binding.args));
  }
  const writes=[...guards];
  if(target){
    const unit=await buildProjectConfiguration(db,target,config,actor,{trustedResources:resources});
    writes.push(...unit.statements);
    // 即使来源完全相同也校验归属和版本，防止只写授权的操作绕过项目访问守卫。
    writes.push(...withAtomicGuard(backend,[],`SELECT EXISTS(SELECT 1 FROM projects p WHERE p.id=? AND p.config_revision=? AND p.revision=? AND ${projectAccessSql()})`,[target.id,target.config_revision,target.revision,user.id]));
    // 配置更新的触发器会推进版本；访问守卫必须在业务写入之前执行。
    const guardUnit=writes.splice(writes.length-2,2);writes.unshift(...guardUnit);
    for(const resource of resources)writes.push(resourceGrantStatement(backend,target.id,resource,user.id,id));
  } else {
    const data={...business,...config,account_id:config.gsc_account_id??config.ga4_account_id,owner_user_id:user.id,origin_candidate_id:id,created_at:at};
    const fields=Object.keys(data);
    writes.push(backend.prepare(`INSERT INTO projects(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`).bind(...fields.map(f=>data[f]??null)));
    writes.push(backend.prepare(`INSERT INTO project_resource_grants(project_id,source,account_id,resource_key,candidate_id,granted_by,created_at)
      SELECT p.id,json_extract(r.value,'$.source'),json_extract(r.value,'$.account_id'),json_extract(r.value,'$.resource_key'),?,?,? FROM json_each(?) r JOIN projects p ON p.origin_candidate_id=? WHERE 1
      ON CONFLICT(project_id,source,account_id,resource_key) DO UPDATE SET candidate_id=excluded.candidate_id`).bind(id,user.id,at,JSON.stringify(resources.map(r=>({source:r.source,account_id:r.account_id,resource_key:r.resource_key}))),id));
  }
  writes.push(backend.prepare(`UPDATE project_candidates SET resolved_project_id=${target?'?':'(SELECT id FROM projects WHERE origin_candidate_id=?)'},claimed_by=?,claim_key=?,claim_hash=?,revision=revision+1,updated_at=? WHERE id=?`).bind(target?.id??id,user.id,input.idempotency_key,hash,at,id));
  try{
    await backend.batchAtomic(withAtomicGuard(backend,writes,'SELECT EXISTS(SELECT 1 FROM project_candidates c JOIN users u ON u.id=? AND u.deleted_at IS NULL WHERE c.id=? AND c.revision=? AND (c.resolved_project_id IS NULL OR c.resolved_project_id=?))',[user.id,id,input.expected_revision,target?.id??null]));
  }catch(error){if(/CHECK constraint failed|UNIQUE constraint failed/.test(error.message))throw problem(409,'候选、来源权限或项目已变化，请刷新后确认');throw error;}
  const resolved=await db.getProjectCandidate(id);
  return {project:await db.getProject(resolved.resolved_project_id),replayed:false};
}

async function saveResourceMatches(db,project,input,user) {
  if(input.expected_config_revision!==project.config_revision)throw problem(409,'项目来源已变化，请刷新后保存');
  const ids=['gsc','ga4'].map(source=>Number(input[`${source}_resource_id`])).filter(Number.isSafeInteger);
  const choices=await db.listProjectResourceChoices(project.id,user.id,user.role==='admin',ids);
  const selected=selectedResources(choices,input);
  const config={};
  for(const source of ['gsc','ga4']){
    if(input[`${source}_resource_id`]===undefined)continue;
    const resource=selected.find(r=>r.source===source);
    config[`${source}_account_id`]=resource?.account_id??null;
    config[source==='gsc'?'gsc_site':'ga4_property_id']=resource?.resource_key??null;
  }
  const unit=await buildProjectConfiguration(db,project,config,{user_id:user.id,current_role:user.role});
  if(unit.statements.length){
    const grants=selected.map(r=>resourceGrantStatement(db.db,project.id,r,user.id));
    try{await db.db.batchAtomic([...unit.statements,...grants]);}catch(error){if(/CHECK constraint failed/.test(error.message))throw problem(409,'项目或资源权限已变化，请刷新后保存');throw error;}
  }
  return {project:await db.getProject(project.id),changed:unit.changed};
}
module.exports={candidateList,candidatePage,candidateDetail,claimCandidate,saveResourceMatches,configurationFromResources,problem};
