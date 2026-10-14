// 后台执行器的每笔写入都验证当前权限、PAT、操作租约及配置，防止旧执行者提交。
const createDbApi=require('../db/api');
const { fail }=require('./mcp-common');

const MAX_ENGINE_STATEMENTS=18;

function operationScopedDb(db,op,lease,unit={}) {
  const backend=db.db;
  let queries=0;
  const consume=(count)=>{
    if(queries+count>MAX_ENGINE_STATEMENTS)fail('BUDGET_EXCEEDED','同步单元超出数据库预算，请重新缩小范围',{max_engine_statements:MAX_ENGINE_STATEMENTS});
    queries+=count;
  };
  const guard=()=>{
    const token=op.channel==='mcp' ? 'AND EXISTS(SELECT 1 FROM mcp_tokens WHERE user_id=o.user_id AND token_id=o.token_id AND revoked_at IS NULL)' : '';
    const config=unit.config_revision!==undefined?' AND NOT EXISTS(SELECT 1 FROM json_each(o.project_ids_json) j JOIN projects p ON p.id=j.value WHERE p.config_revision<>?)':'';
    const article=unit.article_id!==undefined&&unit.fetch_revision!==undefined?" AND EXISTS(SELECT 1 FROM project_articles a WHERE a.id=? AND a.project_id IN (SELECT value FROM json_each(o.project_ids_json)) AND a.status='active' AND a.fetch_revision=?)":'';
    const registry=unit.registry_signature!==undefined?' AND (SELECT json_group_array(json_array(a.id,a.registry_revision)) FROM (SELECT id,registry_revision FROM project_external_articles WHERE project_id IN (SELECT value FROM json_each(o.project_ids_json)) AND domain=? ORDER BY id) a)=?':'';
    const dependencyRefs=unit.dependency_assertions?.length?unit.dependency_assertions:(unit.dependencies||[]).map(item_key=>({operation_id:op.id,item_key}));
    const dependencies=dependencyRefs.length?" AND NOT EXISTS(SELECT 1 FROM json_each(?) d WHERE NOT EXISTS(SELECT 1 FROM business_operation_items i JOIN business_operations parent ON parent.id=i.operation_id WHERE i.operation_id=json_extract(d.value,'$.operation_id') AND i.item_key=json_extract(d.value,'$.item_key') AND i.state='succeeded' AND parent.user_id=o.user_id))":'';
    const item=unit.item_key?" AND EXISTS(SELECT 1 FROM business_operation_items i WHERE i.operation_id=o.id AND i.item_key=? AND i.state IN ('queued','running'))":'';
    return backend.prepare(`INSERT OR REPLACE INTO business_mutation_guards(operation_id,guard_key,ok)
      SELECT ?, 'engine', CASE WHEN EXISTS(SELECT 1 FROM business_operations o JOIN users u ON u.id=o.user_id AND u.deleted_at IS NULL
        WHERE o.id=? AND o.lease_id=? AND o.lease_expires_at>? AND o.status='running' ${token} ${config} ${article} ${registry} ${dependencies} ${item}
        AND NOT EXISTS(SELECT 1 FROM json_each(o.project_ids_json) j WHERE NOT EXISTS(SELECT 1 FROM projects p
          WHERE p.id=j.value AND (u.role='admin' OR p.owner_user_id=u.id OR EXISTS(SELECT 1 FROM project_copywriters c
            WHERE c.project_id=p.id AND c.user_id=u.id AND c.revoked_at IS NULL))))) THEN 1 ELSE 0 END`)
      .bind(op.id,op.id,lease,new Date().toISOString(),...(unit.config_revision!==undefined?[unit.config_revision]:[]),...(article?[unit.article_id,unit.fetch_revision]:[]),
        ...(registry?[unit.domain,unit.registry_signature]:[]),...(dependencies?[JSON.stringify(dependencyRefs)]:[]),...(item?[unit.item_key]:[]));
  };
  async function atomic(statements) {
    consume(statements.length+2);
    const cleanup=backend.prepare("DELETE FROM business_mutation_guards WHERE operation_id=? AND guard_key='engine'").bind(op.id);
    const results=await backend.batchAtomic([guard(),...statements,cleanup]);return results.slice(1,-1);
  }
  const wrapped={
    prepare(sql){
      const prepared=backend.prepare(sql);
      return {...prepared,get:async(...args)=>{consume(1);return prepared.get(...args);},all:async(...args)=>{consume(1);return prepared.all(...args);},run:async(...args)=>{
        const results=await atomic([prepared.bind(...args)]);return results[0];
      }};
    },
    exec(){throw new Error('Background operations cannot execute unguarded database scripts');},
    batchAtomic:atomic,
    batch:atomic,
    // 事实与成功检查点同一事务提交；响应丢失后调度器跳过已经成功的单元。
    async commitSyncUnit(statements,result,{expectedChanges=1,error=null}={}) {
      if(!unit.item_key)fail('DEPENDENCY_UNAVAILABLE','同步单元缺少检查点标识');
      if(statements.length!==1)fail('BUDGET_EXCEEDED','同步单元必须只有一条完整业务写入');
      consume(statements.length+5);
      const at=new Date().toISOString();
      const landed=backend.prepare(`INSERT OR REPLACE INTO business_mutation_guards(operation_id,guard_key,ok)
        VALUES(?,'engine_landed',CASE WHEN changes()=? THEN 1 ELSE 0 END)`).bind(op.id,expectedChanges);
      const receipt=backend.prepare(`UPDATE business_operation_items SET state=?,result_json=?,error_json=?,
        attempts=attempts+1,next_attempt_at=NULL,updated_at=? WHERE operation_id=? AND item_key=?
        AND state IN ('queued','running')`).bind(error?'failed':'succeeded',JSON.stringify(result),error?JSON.stringify(error):null,at,op.id,unit.item_key);
      const audit=backend.prepare(`INSERT INTO business_audit_events(operation_id,user_id,token_id,tool,item_key,effects_json,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`).bind(op.id,op.user_id,op.token_id??null,op.tool,unit.item_key,JSON.stringify([error?'metrics_sync_failed':'metrics_synced']),at,new Date(Date.now()+30*86400000).toISOString());
      const cleanup=backend.prepare("DELETE FROM business_mutation_guards WHERE operation_id=? AND guard_key IN ('engine','engine_landed')").bind(op.id);
      const results=await backend.batchAtomic([guard(),...statements,landed,receipt,audit,cleanup]);
      return results.slice(1,1+statements.length);
    },
    syncUnitUsage:()=>({queries,max_queries:MAX_ENGINE_STATEMENTS}),
  };
  return createDbApi(wrapped);
}
module.exports={operationScopedDb,MAX_ENGINE_STATEMENTS};
