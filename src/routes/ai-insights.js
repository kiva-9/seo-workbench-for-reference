const {Router}=require('express');
const {wrap,parseId}=require('../lib/http');
const {MODULES,fail}=require('../insights/contracts');
const {ACCESS}=require('../db/queries/ai-insights');
const {publicRun}=require('../insights/service');
const {compactCard,compactRun}=require('../insights/list-card');
function integer(value,fallback,max){if(value===undefined)return fallback;const n=Number(value);if(!Number.isInteger(n)||n<0||n>max)fail('VALIDATION_ERROR','无效的分页参数',400);return n;}
module.exports=({db,insights,config,modelSettings})=>{
  const router=Router(),b=db.db;
  router.use(['/api/ai-insights','/api/projects/:id/ai-insights','/api/projects/:id/index-snapshots'],(req,res,next)=>{
    res.set('Cache-Control','no-store');if(['POST','PUT','PATCH'].includes(req.method)&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||JSON.stringify(req.body).length>64000))return res.status(400).json({error:'请求正文格式或大小无效',code:'VALIDATION_ERROR'});if(config.AI_INSIGHTS_ENABLED===false)return res.status(503).json({error:'AI 见解已关闭',code:'AI_DISABLED'});next();
  });
  async function usage(req,pid=null){
    return await b.prepare(`SELECT usage.kind,usage.status,COUNT(*) calls,SUM(usage.reserved_cost) reserved_cost,SUM(usage.actual_cost) actual_cost,SUM(usage.actual_cost IS NULL) unknown_cost_count FROM ai_usage usage JOIN projects p ON p.id=usage.project_id WHERE ${ACCESS} AND (@pid IS NULL OR p.id=@pid) GROUP BY usage.kind,usage.status`).all({actor:req.user.id,pid});
  }
  async function overview(req,pid=null){
    const only=req.query.module_only,selected=req.query.module;
    if((only!==undefined&&!MODULES.includes(only))||(selected!==undefined&&!MODULES.includes(selected))||(only&&selected&&only!==selected))fail('VALIDATION_ERROR','无效的见解模块',400);
    const external=await modelSettings.runtimeSettings.read();
    const result={modules:{},...(!only?{projects:await db.aiProjects(req.user.id),external_enabled:external.external_enabled,schedule_enabled:!!config.AI_SCHEDULE_ENABLED,model_configured:await modelSettings.configured(),synthetic:!!config.AI_DEMO_MODE}:{}),as_of:new Date().toISOString()};
    if(pid&&!only){await insights.access(pid,req.user.id);result.project=result.projects.find(p=>p.id===pid);if(!selected)result.settings=await db.aiSettings(pid,req.user.id);}
    const limit=integer(req.query.limit,6,20)||6;
    const date=String(req.query.news_date||'');if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))fail('VALIDATION_ERROR','无效的资讯发布日期',400);
    for(const module of only||selected?[only||selected]:MODULES){const group=await db.aiList(req.user.id,{module,projectId:pid,offset:integer(req.query[`${module}_offset`],0,10000),limit,category:String(req.query[`${module}_category`]||'').slice(0,80),feedback:String(req.query[`${module}_feedback`]||'').slice(0,20),date:module==='news'?date:''});result.modules[module]={...group,items:group.items.map(compactCard)};}
    if(only)return result;
    if(selected){
      result.tab_totals={};
      for(const module of MODULES)result.tab_totals[module]=(await db.aiList(req.user.id,{module,projectId:pid,countsOnly:true})).total;
    }
    const runs=await b.prepare(`SELECT r.id,r.project_id,r.module,r.status,r.error_code,r.created_at,r.started_at,r.finished_at,r.retry_of,r.result_json,p.name project_name FROM ai_insight_runs r JOIN projects p ON p.id=r.project_id WHERE ${ACCESS} AND (@pid IS NULL OR p.id=@pid) AND (@module IS NULL OR r.module=@module) ORDER BY r.created_at DESC,r.rowid DESC LIMIT 24`).all({actor:req.user.id,pid,module:selected||null});
    result.runs=runs.map(r=>compactRun({...publicRun(r),project_name:r.project_name}));
    result.usage=selected?[]:await usage(req,pid);
    return result;
  }
  router.get('/api/ai-insights/overview',wrap(async(req,res)=>res.json(await overview(req))));
  router.get('/api/ai-insights/configuration',wrap(async(req,res)=>res.json({projects:await db.aiProjects(req.user.id),model_configured:await modelSettings.configured(),external_enabled:(await modelSettings.runtimeSettings.read()).external_enabled})));
  async function activity(req,pid=null){
    const runs=await b.prepare(`SELECT r.id,r.project_id,r.module,r.status,r.error_code,r.created_at,r.started_at,r.finished_at,r.retry_of,r.result_json,p.name project_name FROM ai_insight_runs r JOIN projects p ON p.id=r.project_id WHERE ${ACCESS} AND (@pid IS NULL OR p.id=@pid) ORDER BY r.created_at DESC,r.rowid DESC LIMIT 24`).all({actor:req.user.id,pid});
    return {runs:runs.map(r=>({...publicRun(r),project_name:r.project_name})),usage:await usage(req,pid)};
  }
  router.get('/api/ai-insights/activity',wrap(async(req,res)=>res.json(await activity(req))));
  const base='/api/projects/:id/ai-insights';
  router.use(base,wrap(async(req,res,next)=>{const pid=parseId(req.params.id);if(!pid)fail('VALIDATION_ERROR','无效项目 ID',400);await insights.access(pid,req.user.id);req.aiProjectId=pid;next();}));
  router.get(base,wrap(async(req,res)=>res.json(await overview(req,req.aiProjectId))));
  router.get(`${base}/settings`,wrap(async(req,res)=>res.json(await db.aiSettings(req.aiProjectId,req.user.id))));
  router.get(`${base}/activity`,wrap(async(req,res)=>res.json(await activity(req,req.aiProjectId))));
  router.put(`${base}/settings`,wrap(async(req,res)=>{if(req.body.version===undefined||!req.body.config||Object.keys(req.body).some(k=>!['version','config'].includes(k)))fail('VALIDATION_ERROR','需要明确的配置和版本',400);res.json(await insights.saveSettings(req.aiProjectId,req.user.id,integer(req.body.version,0,1e9),req.body.config));}));
  router.post(`${base}/runs`,wrap(async(req,res)=>{if(Object.keys(req.body).some(k=>!['module','retry_of','article_id'].includes(k))||(req.body.retry_of!==undefined&&typeof req.body.retry_of!=='string'))fail('VALIDATION_ERROR','任务参数无效',400);const run=await insights.enqueue(req.aiProjectId,req.user.id,req.body.module,{retry_of:req.body.retry_of||null,article_id:req.body.article_id});req.app.locals.wakeInsights?.();res.status(202).json(run);}));
  router.get(`${base}/runs/:runId`,wrap(async(req,res)=>{const run=await db.aiRun(req.params.runId,req.aiProjectId,req.user.id);if(!run)fail('NOT_FOUND','运行不存在',404);res.json(publicRun(run));}));
  router.patch(`${base}/:insightId/feedback`,wrap(async(req,res)=>res.json(await insights.feedback(req.aiProjectId,req.user.id,req.params.insightId,req.body.action,req.body.note??''))));
  router.get(`${base}/:insightId`,wrap(async(req,res)=>{const item=await db.aiDetail(req.params.insightId,req.aiProjectId,req.user.id);if(!item)fail('NOT_FOUND','见解不存在',404);res.json(item);}));
  router.get('/api/projects/:id/index-snapshots',wrap(async(req,res)=>{
    const pid=parseId(req.params.id);if(!pid)fail('VALIDATION_ERROR','无效项目 ID',400);await insights.access(pid,req.user.id);
    const rows=await b.prepare(`SELECT s.* FROM ai_index_snapshots s JOIN projects p ON p.id=s.project_id WHERE p.id=@pid AND ${ACCESS} AND (@url='' OR s.url=@url) ORDER BY s.checked_at DESC,s.id LIMIT @limit OFFSET @offset`).all({pid,actor:req.user.id,url:String(req.query.url||''),limit:integer(req.query.limit,20,100)||20,offset:integer(req.query.offset,0,10000)});
    res.json({items:rows.map(r=>({...r,data:JSON.parse(r.data_json),data_json:undefined}))});
  }));
  return router;
};
