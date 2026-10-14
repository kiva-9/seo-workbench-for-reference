const {hash,businessDay,fail}=require('./contracts');
const createQueries=require('../db/queries/ai-indexing');
const {createInspectionAdapter,inspectionError}=require('./indexing/http');
const {propertyContains,officialResult,decodeSnapshot,snapshotEvidence,compareSnapshots}=require('./indexing/rules');
const {MODEL_INPUT_VERSION,buildIndexingNarrative}=require('./indexing/narrative');

const PERMISSIONS=new Set(['siteOwner','siteFullUser','siteRestrictedUser']);
const MESSAGES={
  GSC_BINDING_MISSING:'项目尚未绑定 Search Console property 与 Google 账号',
  GOOGLE_AUTHORIZATION_MISSING:'Google 账号没有可用授权',
  GSC_RESOURCE_UNVERIFIED:'精确 property 尚未在该账号的可访问资源目录中核验',
  GSC_RESOURCE_FORBIDDEN:'Google 资源未向执行者或此项目授权',
  GSC_SOURCE_DISABLED:'项目的 Search Console 数据来源已关闭',
  URL_OUTSIDE_PROPERTY:'登记 URL 不属于项目已授权的精确 property，无法检查',
  EXTERNAL_DISABLED:'外部检查尚未获准，当前状态未知',
  BUDGET_EXCEEDED:'共享 property 或项目检查配额已用完，需等待下一窗口',
  INSPECTION_ADAPTER_MISSING:'合成检查适配器未配置',
};
function authorizationFailure({account_id,property,authorization}) {
  if(!account_id||!property)return 'GSC_BINDING_MISSING';
  const {account,resource,grant,actor,policy}=authorization;
  if(!account?.authorized)return 'GOOGLE_AUTHORIZATION_MISSING';
  if(!resource||resource.state!=='available'||!PERMISSIONS.has(resource.permission_level))return 'GSC_RESOURCE_UNVERIFIED';
  if(!actor||actor.deleted_at||(actor.role!=='admin'&&account.owner_user_id!==actor.id&&(!grant||grant.revoked_at)))return 'GSC_RESOURCE_FORBIDDEN';
  if(policy?.mode==='disabled')return 'GSC_SOURCE_DISABLED';
  return null;
}
async function guardedRead(assertActive,fn) {await assertActive();const value=await fn();await assertActive();return value;}
async function plan({db,project,settings,now,actorId,assertActive,selection={}}) {
  if(!selection||typeof selection!=='object'||Array.isArray(selection))fail('VALIDATION_ERROR','单 URL 检查选择格式无效',400);
  const articleId=selection.article_id??null;
  if(articleId!==null&&(!Number.isSafeInteger(articleId)||articleId<=0))fail('VALIDATION_ERROR','文章 ID 必须为正整数',400);
  if(Object.hasOwn(selection,'article_id')&&selection.article_id===null)fail('VALIDATION_ERROR','文章 ID 必须为正整数',400);
  const queries=createQueries(db.db),accountId=project.gsc_account_id??project.account_id??null,property=project.gsc_site??'';
  const articleGuard=queries.aiIndexingArticleGuard(project.id,articleId);
  const expected=await guardedRead(assertActive,()=>db.db.prepare(articleGuard.sql).get(...articleGuard.args));
  const articleValue=Object.values(expected)[0],document=JSON.parse(articleValue);
  if(articleId!==null&&document.count!==1)fail('VALIDATION_ERROR','该项目没有可检查的启用文章',400);
  const authGuard=queries.aiIndexingAuthorizationGuard(project.id,accountId,property,actorId);
  const auth=await guardedRead(assertActive,()=>db.db.prepare(authGuard.sql).get(...authGuard.args));
  const authValue=Object.values(auth)[0];
  return {window_key:businessDay(now),input:{selection:articleId===null?{}:{article_id:articleId},articles:document.articles,total_articles:document.count,
    account_id:accountId,property,authorization:JSON.parse(authValue),model_input_version:MODEL_INPUT_VERSION},
    guards:[{...articleGuard,expected:articleValue},{...authGuard,expected:authValue}]};
}
function authorizationKey(input) {
  const {account,resource,grant,policy}=input.authorization;
  return hash({account,resource,grant,policy,account_id:input.account_id,property:input.property});
}
function failureInfo(error) {
  const known=MESSAGES[error.code];
  const code=known||String(error.code||'').startsWith('INSPECTION_')||error.code==='GOOGLE_NOT_CONFIGURED'
    ||error.code==='GOOGLE_AUTHORIZATION_MISSING'?error.code:'INSPECTION_NETWORK';
  const safe=known||inspectionError(code).message;
  return {code,message:safe,...(Number.isInteger(error.http_status)?{http_status:error.http_status}:{})};
}
function priority(history,article) {
  const latest=history.find(s=>s.valid);
  return [!latest?3:latest.status==='not_indexed'||history[0]?.execution_status==='failed'?2:1,
    Date.parse(article.published_at||'')||0,-article.id];
}
const PRIORITIES={persistent_not_indexed:90,suspected_drop:80,needs_review:70,check_failed:65,
  newly_indexed:60,not_indexed:50,unknown:30,indexed:10};
const SUMMARIES={indexed:'最近一次有效检查支持当前已收录。',not_indexed:'最近一次有效检查支持当前未收录；尚无可比较的已收录历史。',
  newly_indexed:'可比较的有效未收录基线之后，当前有效检查支持已收录。',suspected_drop:'历史已收录之后出现有效未收录结果，疑似掉收录，需人工复核。',
  persistent_not_indexed:'两次有效负结果跨越暂定确认窗口，持续未收录，待人工确认。',
  needs_review:'URL、property 或 canonical 检查口径改变，需人工复核。',unknown:'官方检查结果不足以可靠判定收录状态。'};
function cardFor(article,current,comparison) {
  const last=snapshotEvidence(comparison.latest_valid),evidence=comparison.evidence.map(snapshotEvidence);
  const limitations=['检查反映 Google 已知的索引版本，不是实时抓取测试，也不能证明全部搜索可见性。'];
  if(comparison.stale)limitations.push('比较基线已超过项目陈旧阈值；历史状态不代表实时状态。');
  if(current.status==='not_indexed'&&!current.official?.googleCanonical)limitations.push('本次负结果未返回 Google canonical，不能据此认定 canonical 改变。');
  if(['suspected_drop','persistent_not_indexed'].includes(comparison.category))limitations.push('疑似变化不能证明精确掉收录时间或原因；持续负结果确认窗口是待校准的产品规则。');
  if(comparison.category==='needs_review')limitations.push(`需复核：${comparison.review_reasons.join('、')}`);
  if(current.provenance==='synthetic')limitations.push('合成样本检查，用于演示与测试。');
  let summary=SUMMARIES[comparison.category]||'收录状态待复核。';
  if(comparison.category==='check_failed'){
    const lastLabel=last?.state==='indexed'?'已收录':last?.state==='not_indexed'?'未收录':null;
    summary=`本次检查失败：${current.failure.message}。${lastLabel?`最后有效检查为${lastLabel}（${last.checked_at}）；本次失败不改变该历史事实。`:'尚无明确有效检查，当前状态未知。'}`;
  }
  if(comparison.recovered)summary='有效未收录结果之后恢复 PASS，最近一次有效检查支持已收录；异常已结束。';
  return {entity_key:String(article.id),category:comparison.category,priority:PRIORITIES[comparison.category]||0,
    title:article.title||article.url,url:article.url,summary,evidence,limitations,
    status:current.execution_status,current_state:current.status,last_valid_state:last?.state??null,
    last_valid_category:last?.category??null,
    latest_valid:last,failure:current.failure,checked_at:current.checked_at,
    property:current.property,inspection_link:current.inspection_link??null,
    comparison:{baseline_id:comparison.baseline?.id??null,current_id:current.id,
      first_negative_id:comparison.first_negative?.id??null,recovered:comparison.recovered,
      review_reasons:comparison.review_reasons,confirm_hours:comparison.confirm_hours,
      confirmation_rule_tentative:true,stale_baseline:comparison.stale},
    provenance:current.provenance};
}
async function run(ctx) {
  if(ctx.input.model_input_version!==MODEL_INPUT_VERSION)fail('STALE_AUTHORIZATION','收录解读输入版本已变化，请重新运行');
  const queries=createQueries(ctx.db.db),settings=ctx.settings.indexing,warnings=[],cards=[];
  const key=authorizationKey(ctx.input),provenance=ctx.adapters?.synthetic?'synthetic':'url_inspection';
  const day=businessDay(ctx.now),start=new Date(`${day}T00:00:00+08:00`).toISOString(),end=new Date(Date.parse(start)+86400000).toISOString();
  const rows=await guardedRead(ctx.assertActive,()=>queries.aiIndexingHistories(ctx.run.project_id,ctx.input.articles.map(a=>a.id)));
  const histories=new Map();for(const row of rows){const list=histories.get(row.article_id)||[];list.push(decodeSnapshot(row));histories.set(row.article_id,list);}
  const candidates=[...ctx.input.articles].sort((a,b)=>{
    const left=priority(histories.get(a.id)||[],a),right=priority(histories.get(b.id)||[],b);
    for(let i=0;i<left.length;i++)if(left[i]!==right[i])return right[i]-left[i];return 0;
  }).slice(0,settings.max_urls);
  const counts={processed:0,attempted:0,checked:0,failed:0,unknown:0,reused:0,cached:0,deferred:Math.max(0,ctx.input.total_articles-candidates.length),categories:{}};
  if(!candidates.length)warnings.push({code:'NO_REGISTERED_URLS',message:'项目没有启用的已登记文章 URL'});
  if(ctx.input.total_articles>createQueries.CANDIDATE_LIMIT)warnings.push({code:'INDEXING_CANDIDATE_LIMIT',message:'待检查文章超过候选读取上限，本次仅在前 1000 篇登记文章中选择'});
  const authFailure=authorizationFailure(ctx.input);
  const adapter=ctx.adapters?.inspectUrl||createInspectionAdapter({getAccessToken:ctx.google?.getAccessToken,assertActive:ctx.assertActive});
  for(const article of candidates){
    await ctx.assertActive();
    const existing=await guardedRead(ctx.assertActive,()=>queries.aiIndexingRunSnapshot(ctx.run.id,article.url));
    let current=decodeSnapshot(existing);
    let reused=Boolean(current),cache=null;
    if(!current&&!ctx.run.retry_of&&!authFailure&&propertyContains(ctx.input.property,article.url)){
      const cached=await guardedRead(ctx.assertActive,()=>queries.aiIndexingDailySnapshot(ctx.run.project_id,article.id,
        article.url,ctx.input.property,article.fetch_revision,key,provenance,start,end));
      if(cached){current=decodeSnapshot(cached);reused=true;counts.cached++;}
    }
    if(reused){counts.reused++;cache={reused:true,snapshot_id:current.id,source_run_id:current.run_id,checked_at:current.checked_at,business_day:day};}
    else{
      counts.attempted++;
      current={id:`index-${hash([ctx.run.id,article.id,article.url])}`,project_id:ctx.run.project_id,
        run_id:ctx.run.id,article_id:article.id,fetch_revision:article.fetch_revision,url:article.url,
        property:ctx.input.property,checked_at:ctx.now,provenance,authorization_key:key};
      try{
        const problem=authFailure||(!propertyContains(ctx.input.property,article.url)?'URL_OUTSIDE_PROPERTY':null)
          ||(ctx.adapters?.synthetic&&!ctx.adapters.inspectUrl?'INSPECTION_ADAPTER_MISSING':null);
        if(problem)throw Object.assign(new Error(MESSAGES[problem]),{code:problem});
        await ctx.assertActive();
        const response=await ctx.external('indexing',ctx.input.property,async()=>{
          await ctx.assertActive();
          const result=await adapter({articleId:article.id,accountId:ctx.input.account_id,
            inspectionUrl:article.url,siteUrl:ctx.input.property,
            languageCode:ctx.settings.background.language||'en-US',signal:AbortSignal.timeout(15000)});
          await ctx.assertActive();return result;
        },{daily:settings.property_daily,projectDaily:settings.project_daily,minute:settings.property_minute});
        await ctx.assertActive();Object.assign(current,officialResult(response));
      }catch(error){
        await ctx.assertActive();
        if(['STALE_AUTHORIZATION','FORBIDDEN'].includes(error.code))throw error;
        Object.assign(current,{valid:false,status:'unknown',execution_status:'failed',official:null,
          inspection_link:null,failure:failureInfo(error)});
      }
      const history=histories.get(article.id)||[];
      const comparison=compareSnapshots(current,history,settings);
      current.comparison={category:comparison.category,baseline_id:comparison.baseline?.id??null,
        first_negative_id:comparison.first_negative?.id??null,review_reasons:comparison.review_reasons,recovered:comparison.recovered};
      await ctx.commit([queries.aiIndexingSnapshotStatement(current)]);
    }
    const comparison=compareSnapshots(current,histories.get(article.id)||[],settings),card=cardFor(article,current,comparison);
    if(cache){card.cache=cache;card.limitations.push('本次复用上海业务日内已有快照；检查时间保持原值，未生成新的模型解释。');}
    if(current.execution_status==='failed'){counts.failed++;warnings.push({article_id:article.id,...current.failure});}
    else{if(!reused)counts.checked++;if(!current.valid){counts.unknown++;warnings.push({article_id:article.id,code:'INSPECTION_VERDICT_UNKNOWN',message:'官方 verdict 未提供明确收录判定'});}}
    await ctx.assertActive();
    if(reused)card.model={status:'cached',explanation:null,source_snapshot_id:current.id};
    else{card.model_input=buildIndexingNarrative(card);card.model=await ctx.explain(card.model_input.evidence);}
    await ctx.assertActive();
    if(!['succeeded','disabled','cached'].includes(card.model.status))warnings.push({article_id:article.id,code:card.model.error_code||'MODEL_UNAVAILABLE',message:'模型解释未完成，保留规则事实',model_status:card.model.status});
    cards.push(card);counts.processed++;counts.categories[card.category]=(counts.categories[card.category]||0)+1;
  }
  return {cards,counts,warnings,status:warnings.length?'partial':'succeeded'};
}
module.exports={plan,run};
