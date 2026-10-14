const {fail} = require('./mcp-common');

async function checkResourceBinding(db,{projectId=null,source,accountId,resourceKey,actor,trustedResources=[]}) {
  if(Boolean(accountId)!==Boolean(resourceKey))fail('VALIDATION_ERROR','Google 账号与资源必须成对设置或清空');
  if(!accountId)return null;
  const account=await db.getAccount(accountId);
  const user=actor?await db.getUser(actor.user_id):null;
  const resource=await db.findGoogleResource(accountId,source,String(resourceKey));
  const trusted=resource&&trustedResources.some(r=>r.id===resource.id);
  const grant=projectId?await db.hasResourceGrant(projectId,source,accountId,String(resourceKey)):null;
  if(!account||(actor&&(!user||(!trusted&&!grant&&user.role!=='admin'&&account.owner_user_id!==user.id))))fail('FORBIDDEN','此资源尚未授权给该项目');
  if(resource&&resource.state!=='available')fail('VALIDATION_ERROR','该资源已不在账号的可访问目录中，请刷新或选择其他来源');
  // 存量人工绑定在首次目录核验前可继续使用；已成功列举的目录必须校验资源身份。
  if(!resource){
    const sources=await db.listResourceSyncSources(accountId);
    if(trusted||sources.some(s=>s.source===source&&s.last_success_at))fail('VALIDATION_ERROR','资源不在该账号的已同步目录中');
  }
  const sql=`SELECT EXISTS(SELECT 1 FROM google_accounts a WHERE a.id=? AND a.auth_revision=?
    ${actor?`AND EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.deleted_at IS NULL AND (${trusted?'1=1':`u.role='admin' OR a.owner_user_id=u.id OR EXISTS(SELECT 1 FROM project_resource_grants g WHERE g.project_id=? AND g.source=? AND g.account_id=a.id AND g.resource_key=? AND g.revoked_at IS NULL)`}))`:''}
    ${resource?"AND EXISTS(SELECT 1 FROM google_resources r WHERE r.id=? AND r.revision=? AND r.state='available' AND r.stream_state=?)":''})`;
  const args=[account.id,account.auth_revision,...(actor?[actor.user_id,...(trusted?[]:[projectId,source,String(resourceKey)])]:[]),...(resource?[resource.id,resource.revision,resource.stream_state]:[])];
  return {sql,args,account,resource,trusted};
}

function sourcePolicyStatement(backend,projectId,source,enabled,userId,at) {
  return backend.prepare(`INSERT INTO project_source_policies(project_id,source,mode,updated_by,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(project_id,source) DO UPDATE SET mode=excluded.mode,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(projectId,source,enabled?'manual':'disabled',userId??null,at);
}
function resourceGrantStatement(backend,projectId,resource,userId,candidateId=null) {
  return backend.prepare(`INSERT INTO project_resource_grants(project_id,source,account_id,resource_key,candidate_id,granted_by,created_at,revoked_at)
    VALUES (?,?,?,?,?,?,?,NULL) ON CONFLICT(project_id,source,account_id,resource_key) DO UPDATE SET revoked_at=NULL,candidate_id=COALESCE(excluded.candidate_id,project_resource_grants.candidate_id),granted_by=excluded.granted_by`).bind(projectId,resource.source,resource.account_id,resource.resource_key,candidateId,userId,new Date().toISOString());
}
module.exports={checkResourceBinding,sourcePolicyStatement,resourceGrantStatement};
