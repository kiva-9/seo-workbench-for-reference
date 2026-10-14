// 配置保存与失效使用同一个业务计划，旧事实保留供指纹检查识别 stale。
const { parseKeyEventNames } = require('../google/project-config');
const { fail } = require('./mcp-common');
const { withAtomicGuard } = require('../lib/atomic-guard');
const {checkResourceBinding,sourcePolicyStatement} = require('./project-resource-access');
const FIELDS = ['gsc_account_id','gsc_site','ga4_account_id','ga4_property_id','key_event_names'];
function normalizeEvents(raw) {
  if (!Array.isArray(raw)) fail('VALIDATION_ERROR','关键事件必须是数组');
  const names=[...new Set(raw.map((v)=>String(v??'').trim()).filter(Boolean))].sort();
  if(names.length>50||names.some((v)=>v.length>120||/[\u0000-\u001f\u007f]/.test(v)))fail('VALIDATION_ERROR','关键事件最多 50 个，单项最多 120 字且不能包含控制字符');
  return names;
}
async function buildProjectConfiguration(db,project,patch,actor=null,{trustedResources=[]}={}) {
  const backend=db.db;const at=new Date().toISOString();const data={};
  for(const f of FIELDS)if(f in patch)data[f]=f==='key_event_names'?JSON.stringify(normalizeEvents(patch[f])):patch[f];
  const effective={...project,...data};
  const bindingGuards=[];
  for(const [account,resource] of [['gsc_account_id','gsc_site'],['ga4_account_id','ga4_property_id']]){
    // 项目成员可维护已有来源的监控口径；只有重新绑定来源才检查账号归属。
    const bindingChanged=[account,resource].some(field=>field in data && (data[field]??null)!==(project[field]??null));
    if(!bindingChanged)continue;
    if(Boolean(effective[account])!==Boolean(effective[resource]))fail('VALIDATION_ERROR','Google 账号与资源必须成对设置或清空',{reason:'INCOMPLETE_SOURCE_CONFIGURATION',source:account});
    if(effective[account]){
      bindingGuards.push(await checkResourceBinding(db,{projectId:project.id,source:account==='gsc_account_id'?'gsc':'ga4',accountId:effective[account],resourceKey:effective[resource],actor,trustedResources}));
    }
  }
  const changedSources=[];for(const f of FIELDS){if(!(f in data))continue;const before=f==='key_event_names'?JSON.stringify(parseKeyEventNames(project[f]).sort()):(project[f]??null);const after=data[f]??null;if(before===after)delete data[f];else changedSources.push(f);}
  if(!changedSources.length)return {statements:[],changed:false,changedSources,internalCount:0,externalCount:0};
  const counts=await backend.prepare('SELECT (SELECT COUNT(*) FROM project_articles WHERE project_id=?) AS internal,(SELECT COUNT(*) FROM project_external_articles WHERE project_id=?) AS external').get(project.id,project.id);
  const statements=[];
  for(const guard of bindingGuards)statements.push(...withAtomicGuard(backend,[],guard.sql,guard.args));
  if(Object.keys(data).length){
    if('gsc_account_id'in data||'ga4_account_id'in data)data.account_id=effective.gsc_account_id??effective.ga4_account_id??null;
    const fields=Object.keys(data);statements.push(backend.prepare(`UPDATE projects SET ${fields.map((f)=>f+'=?').join(',')} WHERE id=?`).bind(...fields.map((f)=>data[f]),project.id));
  }
  // 同步执行器仍消费其原有配置修订，因此两个入口都推进这个共同守卫。
  statements.push(backend.prepare(`INSERT INTO project_monitor_sync_state(project_id,config_revision,updated_at) VALUES (?,2,?) ON CONFLICT(project_id) DO UPDATE SET config_revision=config_revision+1,updated_at=excluded.updated_at`).bind(project.id,at));
  statements.push(backend.prepare('UPDATE project_articles SET metrics_dirty=1,updated_at=? WHERE project_id=?').bind(at,project.id));
  statements.push(backend.prepare('UPDATE project_external_articles SET metrics_dirty=1,updated_at=? WHERE project_id=?').bind(at,project.id));
  for(const [source,account,resource] of [['gsc','gsc_account_id','gsc_site'],['ga4','ga4_account_id','ga4_property_id']]){
    if(account in data||resource in data)statements.push(sourcePolicyStatement(backend,project.id,source,Boolean(effective[account]&&effective[resource]),actor?.user_id,at));
  }
  const actorCondition=actor?" AND EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.deleted_at IS NULL AND (u.role='admin' OR p.owner_user_id=u.id OR EXISTS(SELECT 1 FROM project_copywriters c WHERE c.project_id=p.id AND c.user_id=u.id AND c.revoked_at IS NULL)))":'';
  const guarded=withAtomicGuard(backend,statements,'SELECT EXISTS(SELECT 1 FROM projects p WHERE p.id=? AND p.config_revision=? AND p.revision=? AND p.data_revision=?'+actorCondition+')',[project.id,project.config_revision,project.revision,project.data_revision,...(actor?[actor.user_id]:[])]);
  return {statements:guarded,changed:true,changedSources,internalCount:counts.internal,externalCount:counts.external};
}
async function saveProjectConfiguration(db,project,patch,actor=null){const unit=await buildProjectConfiguration(db,project,patch,actor);if(unit.statements.length)await db.db.batchAtomic(unit.statements);return unit;}
module.exports={buildProjectConfiguration,saveProjectConfiguration,normalizeEvents};
