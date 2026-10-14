const express=require('express');
const {wrap,parseId,badId}=require('../lib/http');
const {enqueueResourceSync,publicResourceJob}=require('../services/google-resource-sync');
const {resourceDto}=require('../services/resource-catalog');
const {pickerResourceDto,resourcePickerPages}=require('../services/resource-picker');
const {candidateHostname}=require('../lib/resource-domain');
const {candidatePage,candidateDetail,claimCandidate,saveResourceMatches,problem}=require('../services/project-candidates');

module.exports=function({db,google,assertProjectAccess}) {
  const router=express.Router();
  async function accountAccess(req,id) {
    const account=await db.getAccount(id);
    if(!account)throw problem(404,'账号不存在');
    if(req.user.role!=='admin'&&account.owner_user_id!==req.user.id)throw problem(403,'无权访问该账号');
    return account;
  }
  router.post('/api/accounts/:id/resource-sync',wrap(async(req,res)=>{
    const id=parseId(req.params.id);if(!id)return badId(res);
    const job=await enqueueResourceSync(db,id,req.user.id);
    req.app.locals.wakeResourceSync?.();res.status(202).json(job);
  }));
  router.get('/api/accounts/:id/resource-sync/:jobId',wrap(async(req,res)=>{
    const id=parseId(req.params.id);if(!id)return badId(res);await accountAccess(req,id);
    const job=await db.getResourceSyncJob(req.params.jobId);
    if(!job||job.account_id!==id)throw problem(404,'目录任务不存在');
    res.json(publicResourceJob(job));
  }));
  router.get('/api/accounts/:id/resources',wrap(async(req,res)=>{
    const id=parseId(req.params.id);if(!id)return badId(res);await accountAccess(req,id);
    res.json({resources:(await db.listAccountResources(id)).map(resourceDto),sources:await db.listResourceSyncSources(id),job:publicResourceJob(await db.getLatestResourceSyncJob(id))});
  }));
  router.get('/api/accounts/:id/disconnect-impact',wrap(async(req,res)=>{
    const id=parseId(req.params.id);if(!id)return badId(res);await accountAccess(req,id);
    res.json({projects:await db.resourceAccountImpact(id)});
  }));
  router.get('/api/project-candidates',wrap(async(req,res)=>{
    const status=String(req.query.status||'pending'),rawQ=String(req.query.q||'').trim().toLowerCase().slice(0,200),q=candidateHostname(rawQ)||rawQ;
    res.json(await candidatePage(db,req.user,{status,query:q,page:req.query.page,pageSize:req.query.page_size||50}));
  }));
  router.get('/api/project-candidates/:id',wrap(async(req,res)=>{
    const id=parseId(req.params.id);if(!id)return badId(res);res.json(await candidateDetail(db,id,req.user,{compactResources:req.query.resources==='picker'}));
  }));
  router.post('/api/project-candidates/:id/claim',wrap(async(req,res)=>{
    const id=parseId(req.params.id);if(!id)return badId(res);
    const result=await claimCandidate(db,id,req.body||{},req.user);res.status(result.replayed?200:201).json(result);
  }));
  for(const [action,hidden] of [['ignore',1],['restore',0]])router.post(`/api/project-candidates/:id/${action}`,wrap(async(req,res)=>{
    const id=parseId(req.params.id);if(!id)return badId(res);
    const candidate=await db.getProjectCandidate(id);if(!candidate)throw problem(404,'候选不存在');
    await db.setProjectCandidateHidden(candidate.id,req.user.id,hidden);
    res.json({ok:true,hidden:Boolean(hidden)});
  }));
  router.get('/api/projects/:id/resource-matches',wrap(async(req,res)=>{
    const id=parseId(req.params.id);if(!id)return badId(res);const project=await assertProjectAccess(req,res,id);if(!project)return;
    const boundAccounts=await db.db.prepare('SELECT id,email,note FROM google_accounts WHERE id IN (?,?)').all(project.gsc_account_id??project.account_id??null,project.ga4_account_id??project.account_id??null);
    res.json({project,bound_accounts:boundAccounts,policies:await db.getProjectSourcePolicies(id),
      ...await resourcePickerPages(db,candidateHostname(project.website),{project,user:req.user})});
  }));
  router.put('/api/projects/:id/resource-matches',wrap(async(req,res)=>{
    const id=parseId(req.params.id);if(!id)return badId(res);const project=await assertProjectAccess(req,res,id);if(!project)return;
    res.json(await saveResourceMatches(db,project,req.body||{},req.user));
  }));
  router.get('/api/projects/:id/resource-events',wrap(async(req,res)=>{
    const id=parseId(req.params.id);if(!id)return badId(res);const project=await assertProjectAccess(req,res,id);if(!project)return;
    const accountId=parseId(req.query.account_id),key=String(req.query.property_id||'');
    const current=(project.ga4_account_id??project.account_id)===accountId&&project.ga4_property_id===key;
    const account=accountId?await db.getAccount(accountId):null;
    if(!account||(!current&&req.user.role!=='admin'&&account.owner_user_id!==req.user.id&&!await db.hasResourceGrant(id,'ga4',accountId,key)))throw problem(403,'资源尚未授权给此项目');
    res.json(await google.ga4ListEvents(accountId,key));
  }));
  router.get('/api/resources/search',wrap(async(req,res)=>{
    let hostname='',projectId=0;
    const candidateId=parseId(req.query.candidate_id),requestedProject=parseId(req.query.project_id);
    if(candidateId){const candidate=await db.getProjectCandidate(candidateId);if(!candidate)throw problem(404,'候选不存在');hostname=candidateHostname(candidate.hostname);}
    else if(requestedProject){const project=await assertProjectAccess(req,res,requestedProject);if(!project)return;projectId=project.id;hostname=candidateHostname(project.website);}
    else throw problem(400,'请指定候选或项目');
    const accountId=req.query.account_id===undefined?0:parseId(req.query.account_id);
    if(accountId===null||accountId===undefined)throw problem(400,'账号 ID 无效');
    const result=await db.searchResourcePage({hostname,projectId,userId:req.user.id,isAdmin:req.user.role==='admin',
      accountId,q:req.query.q,source:String(req.query.source||''),page:req.query.page,pageSize:req.query.page_size||25});
    res.json({...result,items:result.items.map(req.query.resources==='picker'?pickerResourceDto:resourceDto)});
  }));
  return router;
};
