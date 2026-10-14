const {businessDay} = require('./contracts');
const createQueries = require('../db/queries/ai-news');
const {fetchFeed,FETCH_LIMITS} = require('./news/safe-fetch');
const {parseFeed,filterReport,clusterReports,normalizeText,MAX_RAW_REPORT_BYTES} = require('./news/feed');
const {CURATION_VERSION,sourceMetadata,firstPublished,hardMatch,selectGroups}=require('./news/curation');
const {buildDossier}=require('./news/dossier');
const {mapLimit}=require('../lib/async');
const {modelEvidence}=require('./news/narrative');
const {boundedCandidates}=require('./news/candidates');
const NEWS_INPUT_VERSION='news-context-v4';

const NETWORK_BUDGET=Object.freeze({daily:24,projectDaily:480,minute:2});
const MAX_EVENT_REPORTS=20;
// Raw rows are capped at 40000 UTF-8 bytes; retained dates and current source metadata fit in the remaining headroom.
const MAX_REPORT_SNAPSHOT_BYTES=50000;

async function plan({settings,now,assertActive}) {
  await assertActive();
  const day=businessDay(now),dayStart=Date.parse(day+'T00:00:00+08:00');
  const input={
    model_input_version:NEWS_INPUT_VERSION,
    window:{business_day:day,start_at:new Date(dayStart-(settings.news.max_age_days-1)*86400000).toISOString(),end_at:new Date(dayStart+86400000).toISOString()},
    background:{...settings.background},keywords:[...settings.keywords],exclude_keywords:[...settings.exclude_keywords],
    sources:settings.sources.filter(source=>source.approved).map(source=>({...source,tier:source.tier??'unknown',publisher:source.publisher??''})).sort((a,b)=>a.id.localeCompare(b.id)),
    news:{...settings.news,min_summary_chars:settings.news.min_summary_chars??20,max_per_publisher:settings.news.max_per_publisher??2},
  };
  await assertActive();
  return {window_key:day,input,guards:[]};
}

function fatal(error) { return ['STALE_AUTHORIZATION','FORBIDDEN'].includes(error.code); }

function retainedReport(report,cached) {
  if(!cached)return report;
  const oldDate=firstPublished(cached);
  const firstDate=oldDate&&report.published_at?(oldDate<report.published_at?oldDate:report.published_at):(oldDate||report.published_at);
  const useIncoming=Boolean(report.published_at&&(!oldDate||report.published_at<=oldDate));
  const republished=Boolean(oldDate&&report.published_at&&Date.parse(report.published_at)>Date.parse(oldDate));
  return {...report,...(cached.event_key?{event_key:cached.event_key}:{}),
    first_published_at:firstDate,first_publication_quality:firstDate?'known':report.date_status,
    first_publication_raw:useIncoming?report.raw_published_at:(cached.first_publication_raw||cached.raw_published_at||report.raw_published_at||null),
    ...((republished||cached.republished)?{republished:true,original_published_at:firstDate}:{}),
    ...(cached.first_fetched_at?{first_fetched_at:cached.first_fetched_at}:{first_fetched_at:cached.fetched_at})};
}

function makeCard(group,input,ctx,freshIds,sourceStates) {
  const ordered=[...group.reports].sort((a,b)=>Number(b.id===group.representative.id)-Number(a.id===group.representative.id)||
    filterReport(b,{...input,now:ctx.now}).matched_keywords.length-filterReport(a,{...input,now:ctx.now}).matched_keywords.length||a.id.localeCompare(b.id));
  const reports=[];let snapshotBytes=2;
  for(const {curation,...report} of ordered){
    const snapshot={...report,cached:!freshIds.has(report.id)};
    const size=Buffer.byteLength(JSON.stringify(snapshot),'utf8')+(reports.length?1:0);
    if(!reports.length&&size>MAX_REPORT_SNAPSHOT_BYTES)throw Object.assign(new Error('NEWS_REPORT_TOO_LARGE'),{code:'NEWS_REPORT_TOO_LARGE'});
    if(reports.length>=MAX_EVENT_REPORTS||snapshotBytes+size>MAX_REPORT_SNAPSHOT_BYTES)break;
    reports.push(snapshot);snapshotBytes+=size;
  }
  const primary=reports[0],matched_keywords=group.selection.matched_keywords;
  const observation=group.selection.decision==='observe';
  const missingDate=reports.some(report=>report.date_status!=='known'),cached=reports.some(report=>report.cached);
  const limitations=['仅依据 feed 提供的标题和摘要；需要人工核查原文。','同事件报道数量不代表行业趋势、热度或搜索量变化。'];
  if(missingDate)limitations.push('部分报道缺少有效发布时间，抓取时间不作为发布时间。');
  if(primary.publication_precision==='date_only')limitations.push('来源只提供日期，未给出时间和时区；日期原文保留供核查。');
  if(cached)limitations.push('包含以前成功抓取的缓存报道，抓取时间见各条证据。');
  if(new Set(reports.map(report=>normalizeText(report.summary)).filter(Boolean)).size>1)limitations.push('不同报道的摘要存在差异，请核查各原文是否一致或互相矛盾。');
  if(reports.some(report=>report.republished))limitations.push('同一报道再次发布，时间窗口仍按最早已知发布时间判断。');
  if(group.related_event_keys.length)limitations.push('存在此前分开记录的相关事件，原关系保留供人工复核。');
  if(group.possible_related.length)limitations.push('标题相似的报道仅标为可能相关，未据此强行合并事件。');
  if(observation)limitations.push('材料、发布时间或关键词证据不足，仅保留待核查记录，不请求模型解读。');
  const evidence=reports.map(report=>({id:report.id,kind:'feed_report',...report}));
  if(group.reports.length>reports.length){
    limitations.push('该事件关联报道较多，卡片仅展示部分原报道；全部关系保留在资讯记录中。');
    evidence.push({id:'news:report-count',kind:'event_size',total_reports:group.reports.length,displayed_reports:reports.length});
  }
  evidence.push({id:'news:selection',kind:'curation_rule',...group.selection});
  evidence.push({id:'news:context',kind:'project_context',background:input.background,keywords:input.keywords,exclude_keywords:input.exclude_keywords,window:input.window});
  const projectFocus=input.background.promotion?' 当前推广重点为「'+input.background.promotion+'」。':'';
  const products=input.background.products?' 项目产品为「'+input.background.products+'」。':'';
  return {
    entity_key:group.event_key,category:observation?'news_observation':'industry_news',priority:Math.min(observation?30:100,(observation?10:50)+matched_keywords.length*10),
    title:primary.title,url:primary.url,summary:primary.summary,happened:primary.title,
    relevance:{label:group.selection.label,matched_keywords,basis:matched_keywords.length?'标题或摘要匹配项目关注词':'当前材料未提供可确认的关注词关系',products:input.background.products,promotion:input.background.promotion,
      explanation:matched_keywords.length?'该报道匹配关注词「'+matched_keywords.join('、')+'」。'+products+projectFocus+' 需要进一步核查事件与项目产品、推广重点的适用关系。':'当前材料不足以确认与项目关注方向的关系，等待人工核查。'},
    topic_angles:observation?[]:['可围绕「'+matched_keywords.join('、')+'」整理待讨论选题，先核查原文事实、项目产品与目标市场是否相符。'],
    published_at:firstPublished(primary),latest_published_at:primary.published_at,publication_quality:primary.first_publication_quality||primary.date_status||'missing',
    publication_raw:primary.first_publication_raw||primary.raw_published_at||null,publication_precision:primary.publication_precision||null,
    fetched_at:primary.fetched_at,cached,reports,evidence,limitations,selection:group.selection,
    publisher:primary.publisher,reported_publishers:[...new Set(group.reports.map(report=>report.publisher))],
    grouping:{version:CURATION_VERSION,basis:'hard_identity_only',dedupe_links:group.dedupe_links.slice(0,20),possible_related:group.possible_related},
    source_status:sourceStates.filter(source=>reports.some(report=>report.source_id===source.id)),
    related_event_keys:group.related_event_keys,possible_related:group.possible_related,period:input.window,status:observation?'needs_review':'industry_update',provenance:ctx.adapters?.synthetic?'synthetic':'rss_feed',
  };
}

async function run(ctx) {
  const {input}=ctx,queries=createQueries(ctx.db.db),sourceIds=input.sources.map(source=>source.id);
  if(input.model_input_version!==NEWS_INPUT_VERSION)throw Object.assign(new Error('资讯证据格式已更新，请重新运行'),{code:'STALE_AUTHORIZATION'});
  const warnings=[],counts={processed:0,selected:0,skipped:0,failed:0,sources:[],filters:{},empty_reason:null};
  if(!sourceIds.length){counts.empty_reason='sources_not_configured';return {cards:[],counts,warnings};}
  await ctx.assertActive();
  const cache=await queries.aiNewsCache(ctx.run.project_id,sourceIds);
  await ctx.assertActive();
  const history=await queries.aiNewsSourceHistory(ctx.run.project_id,input.sources);
  await ctx.assertActive();
  if(!input.keywords.some(word=>normalizeText(word))){
    counts.empty_reason='attention_not_configured';
    counts.sources=input.sources.map(source=>({id:source.id,name:source.name,url:source.url,status:'not_requested',last_success_at:history[source.id]||null,cached:false}));
    return {cards:[],counts,warnings,status:'succeeded'};
  }
  const reports=new Map(cache.map(report=>[report.dedupe_key,report])),freshIds=new Set();
  await mapLimit(input.sources,3,async source=>{
    await ctx.assertActive();
    const previous=cache.filter(report=>report.source_id===source.id&&report.source_url===source.url);
    const last_success_at=previous.reduce((last,report)=>!last||report.fetched_at>last?report.fetched_at:last,history[source.id]||null);
    const state={id:source.id,name:source.name,url:source.url,status:'failed',last_success_at,cached:previous.length>0};
    try{
      const options={assertActive:ctx.assertActive,limits:FETCH_LIMITS};
      if(ctx.adapters?.synthetic){
        if(typeof ctx.adapters.newsTransport!=='function')throw Object.assign(new Error('NEWS_ADAPTER_MISSING'),{code:'NEWS_ADAPTER_MISSING'});
        options.lookup=async()=>[{address:'93.184.216.34',family:4}];
        options.transport=ctx.adapters.newsTransport;
      }
      await ctx.assertActive();
      const result=await ctx.external('news',source.url,()=>fetchFeed(source,options),NETWORK_BUDGET);
      await ctx.assertActive();
      const parsed=await parseFeed(result.xml,{source,url:result.url,fetched_at:ctx.now});
      await ctx.assertActive();
      const fresh=parsed.reports.map(report=>{
        const byKey=reports.get(report.dedupe_key);
        const old=(byKey?.source_url===source.url?byKey:null)||cache.find(item=>
          input.sources.some(approved=>approved.id===item.source_id&&approved.url===item.source_url)&&
          hardMatch(item,report));
        return retainedReport(report,old);
      });
      if(fresh.length)await ctx.commit(queries.aiNewsStatements(ctx.run.project_id,fresh));
      await ctx.assertActive();
      for(const report of fresh){reports.set(report.dedupe_key,report);freshIds.add(report.id);}
      state.status='succeeded';state.last_success_at=ctx.now;state.cached=false;state.received=parsed.received;state.saved=fresh.length;
      counts.processed+=parsed.received;counts.skipped+=parsed.invalid+parsed.truncated;
      if(parsed.invalid)warnings.push({code:'NEWS_INVALID_ITEMS',source_id:source.id,count:parsed.invalid});
      if(parsed.truncated)warnings.push({code:'NEWS_FEED_TRUNCATED',source_id:source.id,count:parsed.truncated});
    }catch(error){
      if(fatal(error))throw error;
      await ctx.assertActive();
      state.error_code=error.code||'NEWS_SOURCE_FAILED';counts.failed++;
      warnings.push({code:state.error_code,source_id:source.id,source_name:source.name,last_success_at,cached:state.cached});
    }
    counts.sources.push(state);
  });
  counts.sources.sort((a,b)=>a.id.localeCompare(b.id));
  const usable=[];
  for(const report of reports.values()){
    const source=input.sources.find(item=>item.id===report.source_id);
    if(!source||report.source_url!==source.url)continue;
    if(Buffer.byteLength(JSON.stringify(report),'utf8')>MAX_RAW_REPORT_BYTES){
      counts.skipped++;warnings.push({code:'NEWS_CACHED_ITEM_TOO_LARGE',source_id:source.id});continue;
    }
    const curated=sourceMetadata(report,source),filtered=filterReport(curated,{...input,now:ctx.now});
    if(filtered.reason&&filtered.reason!=='no_keyword_match'){counts.filters[filtered.reason]=(counts.filters[filtered.reason]||0)+1;counts.skipped++;continue;}
    usable.push({...curated,curation:filtered});
  }
  const candidates=boundedCandidates(usable);
  if(candidates.length<usable.length){counts.skipped+=usable.length-candidates.length;warnings.push({code:'NEWS_CANDIDATE_LIMIT',retained:candidates.length,deferred:usable.length-candidates.length});}
  const groups=clusterReports(candidates,input.news),selection=selectGroups(groups,input,ctx.now),selected=selection.selected,cards=[];
  for(const item of selection.filtered){counts.filters[item.reason]=(counts.filters[item.reason]||0)+1;counts.skipped++;}
  const matchedReports=selected.flatMap(group=>group.reports).map(({cached,curation,...report})=>report);
  if(matchedReports.length){await ctx.assertActive();await ctx.commit(queries.aiNewsStatements(ctx.run.project_id,matchedReports));await ctx.assertActive();}
  for(const group of selected){
    await ctx.assertActive();
    const card=makeCard(group,input,ctx,freshIds,counts.sources);
    card.context=buildDossier(group,groups,input,counts.sources);card.evidence.push(card.context);
    if(card.category==='news_observation'){
      card.model={status:'disabled',explanation:null,error_code:'NEWS_OBSERVATION_NO_MODEL'};cards.push(card);continue;
    }
    try{
      card.model=await ctx.explain(modelEvidence(card));await ctx.assertActive();
      if(!['succeeded','disabled'].includes(card.model?.status))warnings.push({code:card.model?.error_code||'NEWS_MODEL_'+String(card.model?.status||'FAILED').toUpperCase(),entity_key:card.entity_key});
    }catch(error){
      if(fatal(error))throw error;
      await ctx.assertActive();card.model={status:'failed',explanation:null,error_code:error.code||'NEWS_MODEL_FAILED'};
      warnings.push({code:card.model.error_code,entity_key:card.entity_key});
    }
    cards.push(card);
  }
  counts.selected=cards.length;counts.events=groups.length;counts.reports=usable.length;counts.duplicates=Math.max(0,usable.length-groups.length);
  counts.industry_news=cards.filter(card=>card.category==='industry_news').length;counts.news_observation=cards.filter(card=>card.category==='news_observation').length;counts.selection_version=CURATION_VERSION;
  for(const state of counts.sources)state.cached=usable.some(report=>report.source_id===state.id&&!freshIds.has(report.id));
  for(const warning of warnings)if(warning.source_id&&'cached' in warning)warning.cached=counts.sources.find(source=>source.id===warning.source_id)?.cached||false;
  if(!cards.length)counts.empty_reason=counts.failed===sourceIds.length?'sources_failed':
    input.keywords.every(word=>!normalizeText(word))?'attention_not_configured':'no_relevant_news';
  return {cards,counts,warnings,status:counts.failed===sourceIds.length&&!cards.length?'failed':warnings.length?'partial':'succeeded'};
}

module.exports={plan,run};
