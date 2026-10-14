const {randomUUID}=require('node:crypto');
const {withAtomicGuard}=require('../lib/atomic-guard');
const {ACCESS}=require('../db/queries/ai-insights');
const {explainEvidence}=require('./explain');
const {createRuntimeSettings}=require('./runtime-settings');
const {normalizeSources}=require('./news/sources');
const {MODULES,VERSION,parseSettings,fail,hash,businessDay,safeUrl}=require('./contracts');

function createInsightService({db,google,config={},modules={},adapters={},resolveModel,now=()=>new Date().toISOString()}){
  const b=db.db;
  const runtimeSettings=createRuntimeSettings({db,config,now});
  const readModel=resolveModel||(()=>Promise.resolve({adapter:adapters.model}));
  const modelIdentity=model=>model?.identity||{model:model?'injected':'disabled',prompt_version:VERSION};
  async function access(projectId,actorId){const p=await db.aiAccess(projectId,actorId);if(!p)fail('FORBIDDEN','无权访问该项目',403);return p;}
  const accessGuard=(projectId,actorId)=>({sql:`SELECT EXISTS(SELECT 1 FROM projects p WHERE p.id=? AND ${ACCESS.replaceAll('@actor','?')})`,args:[projectId,actorId]});
  async function guardedWrite(projectId,actorId,statements,sql,args){
    try{return await b.batchAtomic(withAtomicGuard(b,statements,sql,args));}
    catch(error){
      if(!/CHECK constraint/.test(error.message))throw error;
      await access(projectId,actorId);
      fail('CONFLICT','配置或输入已变化，请刷新后重试',409);
    }
  }
  async function saveSettings(projectId,actorId,version,raw){
    await access(projectId,actorId);const value=parseSettings(raw),guard=accessGuard(projectId,actorId);
    value.sources=normalizeSources(value.sources);
    if(new Set(value.sources.map(s=>s.id)).size!==value.sources.length||value.sources.some(s=>!safeUrl(s.url)))fail('VALIDATION_ERROR','来源 ID 不得重复，地址必须为 HTTP(S)',400);
    await guardedWrite(projectId,actorId,[b.prepare(`INSERT INTO ai_project_settings(project_id,version,config_json,updated_by,updated_at) VALUES (?,1,?,?,?) ON CONFLICT(project_id) DO UPDATE SET version=version+1,config_json=excluded.config_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(projectId,JSON.stringify(value),actorId,now())],`${guard.sql} AND COALESCE((SELECT version FROM ai_project_settings WHERE project_id=?),0)=?`,[...guard.args,projectId,version]);
    return db.aiSettings(projectId,actorId);
  }
  async function enqueue(projectId,actorId,module,{retry_of=null,article_id}={}){
    const project=await access(projectId,actorId),settings=await db.aiSettings(projectId,actorId);
    if(!MODULES.includes(module)||!modules[module])fail('VALIDATION_ERROR','未知见解任务类型',400);
    let retry=null;if(retry_of){retry=await db.aiRun(retry_of,projectId,actorId);if(!retry||retry.module!==module||!['failed','partial','cancelled'].includes(retry.status))fail('CONFLICT','该任务不可自动重试');}
    if(article_id===undefined&&retry)article_id=JSON.parse(retry.input_json).selection?.article_id;
    if(article_id!==undefined&&(module!=='indexing'||!Number.isSafeInteger(article_id)||article_id<1))fail('VALIDATION_ERROR','单 URL 检查需要有效文章 ID',400);
    const selection=article_id===undefined?{}:{article_id};
    const plan=await modules[module].plan({db,project,settings:settings.config,now:now(),actorId,selection,assertActive:()=>access(projectId,actorId)});
    if(!plan||typeof plan.window_key!=='string'||!Array.isArray(plan.guards))fail('INVALID_PLAN','模块输入计划缺少版本守卫');
    const binding={gsc_site:project.gsc_site??null,gsc_account_id:project.gsc_account_id??null,account_id:project.account_id??null,ga4_property_id:project.ga4_property_id??null};
    const modelState=await readModel(),runtimeState=await runtimeSettings.read();
    const input={plan,binding,selection,settings:settings.config,settings_version:settings.version,model_identity:modelIdentity(modelState.adapter),model_settings_version:modelState.version,external_settings_version:runtimeState.version,version:VERSION};
    const inputHash=hash(input),key=hash({projectId,module,window:plan.window_key,inputHash,retry:retry?.id||null});
    const id=randomUUID(),guard=accessGuard(projectId,actorId);
    await guardedWrite(projectId,actorId,[b.prepare(`INSERT OR IGNORE INTO ai_insight_runs(id,project_id,actor_id,module,idempotency_key,input_hash,input_json,settings_version,status,retry_of,created_at,selection_article_id) VALUES (?,?,?,?,?,?,?,?,'queued',?,?,?)`).bind(id,projectId,actorId,module,key,inputHash,JSON.stringify(input),settings.version,retry?.id||null,now(),selection.article_id||null)],`${guard.sql} AND COALESCE((SELECT version FROM ai_project_settings WHERE project_id=?),0)=?`,[...guard.args,projectId,settings.version]);
    const run=await b.prepare('SELECT * FROM ai_insight_runs WHERE project_id=? AND module=? AND idempotency_key=?').get(projectId,module,key);
    await access(projectId,actorId);return publicRun(run);
  }
  function runGuard(run,input){
    const guard=accessGuard(run.project_id,run.actor_id);
    let sql=`${guard.sql} AND EXISTS(SELECT 1 FROM ai_insight_runs WHERE id=? AND status='running' AND lease_token=? AND lease_until>?) AND COALESCE((SELECT version FROM ai_project_settings WHERE project_id=?),0)=?`;
    const args=[...guard.args,run.id,run.lease_token,now(),run.project_id,run.settings_version];
    if(input.model_settings_version!==undefined){sql+=` AND COALESCE((SELECT version FROM ai_model_configuration WHERE id=1),0)=?`;args.push(input.model_settings_version);}
    sql+=` AND COALESCE((SELECT version FROM ai_runtime_configuration WHERE id=1),0)=?`;args.push(input.external_settings_version||0);
    for(const [key,value]of Object.entries(input.binding)){sql+=` AND (SELECT ${key} FROM projects WHERE id=?) IS ?`;args.push(run.project_id,value);}
    for(const g of input.plan.guards){sql+=` AND (${g.sql}) IS ?`;args.push(...(g.args||[]),g.expected);}
    return {sql,args};
  }
  async function runOnce(){
    const at=now();
    await b.prepare(`UPDATE ai_insight_runs SET status=CASE WHEN external_started=1 THEN 'uncertain' ELSE 'queued' END,error_code=CASE WHEN external_started=1 THEN 'EXTERNAL_UNCERTAIN' ELSE NULL END,lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?`).run(at);
    await b.prepare(`UPDATE ai_usage SET status='uncertain' WHERE status='reserved' AND run_id IN (SELECT id FROM ai_insight_runs WHERE status='uncertain')`).run();
    const next=await b.prepare("SELECT * FROM ai_insight_runs WHERE status='queued' ORDER BY created_at,id LIMIT 1").get();
    if(!next)return {processed:0};
    const token=randomUUID();
    const claim=await b.prepare("UPDATE ai_insight_runs SET status='running',lease_token=?,lease_until=?,started_at=? WHERE id=? AND status='queued'").run(token,new Date(Date.parse(at)+180000).toISOString(),at,next.id);
    if(!claim.changes)return {processed:0};
    const run={...next,status:'running',lease_token:token},input=JSON.parse(run.input_json);
    const assertActive=async()=>{const g=runGuard(run,input);const row=await b.prepare(g.sql).get(...g.args);if(!row||!Object.values(row)[0])fail('STALE_AUTHORIZATION','权限或输入已变化',409);await b.prepare("UPDATE ai_insight_runs SET lease_until=? WHERE id=? AND status='running' AND lease_token=?").run(new Date(Date.parse(now())+180000).toISOString(),run.id,run.lease_token);};
    const commit=async statements=>{const g=runGuard(run,input);try{return await b.batchAtomic(withAtomicGuard(b,statements,g.sql,g.args));}catch(error){if(/CHECK constraint/.test(error.message))fail('STALE_AUTHORIZATION','权限或输入已变化');throw error;}};
    const context={db,google,config,adapters,run,input:input.plan.input,settings:input.settings,now:now(),actorId:run.actor_id,assertActive,commit};
    context.external=async(kind,scope,fn,limits={})=>{
      await assertActive();if(!(await runtimeSettings.read()).external_enabled&&!adapters.synthetic)fail('EXTERNAL_DISABLED','外部调用开关已关闭');
      if(kind==='model'&&await b.prepare("SELECT 1 FROM ai_usage WHERE project_id=? AND kind='model' AND status='uncertain' LIMIT 1").get(run.project_id))fail('EXTERNAL_UNCERTAIN','项目存在待核查模型调用，已暂停后续调用');
      const id=randomUUID(),day=businessDay(now()),cost=Number(limits.cost||0);
      const g=runGuard(run,input),cutoff=new Date(Date.parse(now())-60000).toISOString();
      let sql=`${g.sql} AND (SELECT COUNT(*) FROM ai_usage WHERE kind=? AND scope=? AND business_day=?)<? AND (SELECT COUNT(*) FROM ai_usage WHERE kind=? AND project_id=? AND business_day=?)<? AND (SELECT COUNT(*) FROM ai_usage WHERE kind=? AND scope=? AND created_at>?)<?`;
      const args=[...g.args,kind,scope,day,limits.daily??100,kind,run.project_id,day,limits.projectDaily??100,kind,scope,cutoff,limits.minute??20];
      if(limits.dailyCost!==undefined){
        // A previous count-only request without a price cannot fit a known money budget.
        sql+=` AND NOT EXISTS(SELECT 1 FROM ai_usage WHERE kind='model' AND project_id=? AND business_day=? AND reserved_cost=0 AND actual_cost IS NULL) AND (SELECT COALESCE(SUM(MAX(reserved_cost,COALESCE(actual_cost,0))),0) FROM ai_usage WHERE kind='model' AND project_id=? AND business_day=?)+?<=?`;
        args.push(run.project_id,day,run.project_id,day,cost,limits.dailyCost);
      }
      try{await b.batchAtomic(withAtomicGuard(b,[b.prepare("INSERT INTO ai_usage(id,project_id,run_id,kind,scope,business_day,reserved_cost,status,created_at,model_name,model_profile_id) VALUES (?,?,?,?,?,?,?,'reserved',?,?,?)").bind(id,run.project_id,run.id,kind,scope,day,cost,now(),limits.model_name||null,limits.model_profile_id||null),b.prepare('UPDATE ai_insight_runs SET external_started=1 WHERE id=?').bind(run.id)],sql,args));}
      catch(error){await assertActive();if(/CHECK constraint/.test(error.message))fail('BUDGET_EXCEEDED','调用预算或配额已用完');throw error;}
      try{await assertActive();const result=await fn();await assertActive();await commit([b.prepare("UPDATE ai_usage SET status='succeeded',actual_cost=? WHERE id=?").bind(Number.isFinite(result?.usage?.cost)&&result.usage.cost>=0?result.usage.cost:null,id)]);return result;}
      catch(error){const uncertain=kind==='model'&&!error.definitive;await b.prepare('UPDATE ai_usage SET status=? WHERE id=?').run(uncertain?'uncertain':'failed',id);if(uncertain)error.uncertain=true;throw error;}
    };
    context.explain=evidence=>explainEvidence({evidence,settings:input.settings.model,background:input.settings.background,
      module:run.module,runId:run.id,projectId:run.project_id,expectedIdentity:input.model_identity,
      resolveModel:readModel,external:context.external,assertActive});
    try{
      context.project=await access(run.project_id,run.actor_id);await assertActive();
      const result=await modules[run.module].run(context);await assertActive();
      const cards=result.cards||[];if(cards.length>100)fail('RESULT_LIMIT','单次见解数量超限');
      const statements=cards.map(card=>{
        if(!card.entity_key||!card.category||!card.title||!Array.isArray(card.evidence)||!card.evidence.length)fail('INVALID_CARD','见解缺少证据');
        const data={...card,provenance:adapters.synthetic?'synthetic':(card.provenance||'stored_metrics'),rules_version:VERSION};
        if(JSON.stringify(data).length>200000)fail('RESULT_LIMIT','证据快照超限');
        return b.prepare(`INSERT INTO ai_insights(id,project_id,module,entity_key,run_id,category,priority,title,url,data_json,generated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,module,entity_key) DO UPDATE SET run_id=excluded.run_id,category=excluded.category,priority=excluded.priority,title=excluded.title,url=excluded.url,data_json=excluded.data_json,generated_at=excluded.generated_at`).bind(hash([run.project_id,run.module,card.entity_key]),run.project_id,run.module,card.entity_key,run.id,card.category,card.priority||0,String(card.title).slice(0,500),safeUrl(card.url),JSON.stringify(data),now());
      });
      const uncertain=await b.prepare("SELECT 1 FROM ai_usage WHERE run_id=? AND status='uncertain' LIMIT 1").get(run.id);
      const state=uncertain?'uncertain':(result.status||((result.warnings||[]).length?'partial':'succeeded'));
      statements.push(b.prepare('UPDATE ai_insight_runs SET status=?,result_json=?,finished_at=?,lease_until=NULL WHERE id=?').bind(state,JSON.stringify({counts:result.counts||{processed:cards.length},warnings:result.warnings||[],version:VERSION}),now(),run.id));
      await commit(statements);
    }catch(error){
      const cancelled=['FORBIDDEN','STALE_AUTHORIZATION'].includes(error.code),uncertain=error.uncertain;
      await b.prepare("UPDATE ai_insight_runs SET status=?,error_code=?,finished_at=?,lease_until=NULL WHERE id=? AND lease_token=? AND status='running'").run(cancelled?'cancelled':uncertain?'uncertain':'failed',error.code||'MODULE_FAILED',now(),run.id,token);
    }
    return {processed:1,run_id:run.id};
  }
  async function feedback(projectId,actorId,id,action,note=''){
    if(!['unread','useful','ignored','handled'].includes(action)||typeof note!=='string'||note.length>1000)fail('VALIDATION_ERROR','无效的反馈',400);
    if(!await db.aiDetail(id,projectId,actorId))fail('FORBIDDEN','无权访问该见解',403);
    const g=accessGuard(projectId,actorId);await guardedWrite(projectId,actorId,[b.prepare('UPDATE ai_insights SET feedback=? WHERE id=? AND project_id=?').bind(action,id,projectId),b.prepare('INSERT INTO ai_insight_feedback(project_id,insight_id,actor_id,action,note,created_at) VALUES (?,?,?,?,?,?)').bind(projectId,id,actorId,action,note,now())],g.sql,g.args);return {ok:true};
  }
  async function schedule(){
    if(!config.AI_SCHEDULE_ENABLED)return;
    const day=businessDay(now()),hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date(now())));
    for(const row of await b.prepare('SELECT project_id,updated_by,config_json FROM ai_project_settings ORDER BY project_id').all()){
      const s=parseSettings(JSON.parse(row.config_json));if(!s.schedule.enabled||hour<s.schedule.hour)continue;
      for(const module of s.schedule.modules){if(await b.prepare('SELECT 1 FROM ai_schedule_days WHERE project_id=? AND module=? AND business_day=?').get(row.project_id,module,day))continue;
        try{const run=await enqueue(row.project_id,row.updated_by,module);await b.prepare('INSERT OR IGNORE INTO ai_schedule_days VALUES (?,?,?,?)').run(row.project_id,module,day,run.id);}catch(error){if(error.code!=='FORBIDDEN')throw error;}
      }
    }
  }
  return {access,saveSettings,enqueue,runOnce,feedback,schedule,publicRun};
}
function publicRun(run){if(!run)return null;return {id:run.id,project_id:run.project_id,module:run.module,status:run.status,error_code:run.error_code,created_at:run.created_at,started_at:run.started_at,finished_at:run.finished_at,retry_of:run.retry_of,result:run.result_json?JSON.parse(run.result_json):null};}
module.exports={createInsightService,publicRun};
