const { randomUUID, createHash } = require('node:crypto');
const { z, fail, BusinessError, assertProject, idSchema, monthSchema, pageSchema, pagination, canonicalJson,
  businessDate } = require('./mcp-common');
const { shiftDay, shiftMonth, monthOf, monthBounds, isValidDay } = require('../lib/business-dates');
const { resolveAccounts,parseKeyEventNames } = require('../google/project-config');
const { buildXlsx, sanitizeText } = require('../lib/xlsx');
const { fetchArticleTitle } = require('../lib/article-title-fetch');
const { canExposeMutationItems } = require('./mcp-mutations');
const { collectQueryMetrics } = require('../lib/request-timing');

const TERMINAL = new Set(['succeeded','partial','failed','cancelled']);
const MAX_BYTES = 5 * 1024 * 1024;
const parse = (value, fallback = null) => { try { return JSON.parse(value ?? 'null') ?? fallback; } catch { return fallback; } };
const stamp = () => new Date().toISOString();
const hash = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const publicFailure = error => {
  if(!(error instanceof BusinessError))return {code:'SOURCE_ERROR',message:'安全执行单元未完成，请查看当前状态后重试'};
  if(error.code==='SOURCE_ERROR')return {code:error.code,message:Number.isInteger(error.status)
    ? `数据来源返回 HTTP ${error.status}，本次尝试未完成`
    : error.retryable?'数据来源暂时不可用，请按退避时间重试':'数据来源本次尝试未完成，已保留上次成功事实'};
  return {code:error.code,message:error.message};
};
const keySchema = z.string().regex(/^\d{8}:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const uniqueIds = z.array(idSchema).min(1).max(100).refine(a => new Set(a).size===a.length, '文章 ID 不可重复');
const syncSchema = z.object({project_id:idSchema,scope:z.enum(['internal','external']),
  months:z.array(monthSchema).min(1).max(6).refine(a=>new Set(a).size===a.length,'月份不可重复').optional(),
  article_ids:uniqueIds.optional(),domain:z.string().max(253).optional(),force:z.boolean().default(false)}).strict()
  .refine(v=>v.scope==='internal' ? !v.domain : !v.article_ids,'scope 与文章/域名筛选不匹配');
const titleSchema = z.object({project_id:idSchema,article_type:z.enum(['internal','external']),article_ids:uniqueIds,
  mode:z.enum(['missing_or_failed','force']).default('missing_or_failed'),overwrite_manual:z.boolean().default(false)}).strict()
  .refine(v=>!v.overwrite_manual || v.mode==='force','覆盖人工标题必须使用 force');
const opId = z.string().min(1).max(100);
const withKey = (schema) => schema.safeExtend({idempotency_key:keySchema});

function validateKey(key) {
  const raw = key.slice(0,8); const day = `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
  const today = businessDate();
  if (!isValidDay(day) || day>today || day<shiftDay(today,-90)) fail('VALIDATION_ERROR','幂等键日期必须处于最近 90 天接收窗口');
}
function operationDto(op, counts) {
  const errors=parse(op.error_json,[]);
  return {id:op.id,kind:op.kind || op.tool,status:op.status,created_by:Number(op.user_id),
    project_ids:parse(op.project_ids_json,[]),created_at:op.created_at,updated_at:op.updated_at,
    progress:{completed:Number(counts?.succeeded || 0)+Number(counts?.failed || 0),total:op.progress_total ?? null,unit:op.progress_unit || 'item'},
    data_through:parse(op.data_through_json),errors:Array.isArray(errors)?errors:[errors],result_available:TERMINAL.has(op.status)&&(!op.detail_expires_at||op.detail_expires_at>stamp()),
    retry_after_seconds:TERMINAL.has(op.status)?null:2};
}
function minimalReceipt(op, counts) {
  return {receipt_only:true,operation_id:op.id,status:op.status,committed_count:Number(counts.succeeded),failed_count:Number(counts.failed)};
}
async function accessOperation(db, actor, id, {receipt=false,cancel=false}={}) {
  const op = await db.mcpGetOperation(id);
  if (!op || (Number(op.user_id)!==actor.user_id && actor.current_role!=='admin')) fail('NOT_FOUND','操作不存在或不可访问');
  if (op.expires_at && op.expires_at<stamp()) fail('OPERATION_EXPIRED','操作摘要已过期');
  try { const ids=parse(op.project_ids_json,[]);
    if(ids.length && Number((await db.mcpOperationProjectAccessCount(ids,actor.user_id)).count)!==ids.length)fail('FORBIDDEN','项目权限已变化');
    if(op.kind==='mutation' && !await canExposeMutationItems(db,actor,await db.mcpOperationItems(op.id,1,1001)))fail('FORBIDDEN','业务结果的当前权限已变化');
  }
  catch (error) {
    if ((receipt || cancel) && Number(op.user_id)===actor.user_id && op.kind!=='export') return {op,receipt:true};
    if (cancel && Number(op.user_id)===actor.user_id) return {op,receipt:true};
    fail('FORBIDDEN','当前权限不覆盖该操作，请按当前范围重新执行');
  }
  return {op,receipt:receipt && op.kind!=='export' && Boolean(op.detail_expires_at && op.detail_expires_at<stamp())};
}
async function legacyStatus(db,id,actor) {
  const job=await db.getJob(id.slice('legacy-sync:'.length));
  if(!job || (Number(job.created_by)!==actor.user_id && actor.current_role!=='admin'))fail('NOT_FOUND','操作不存在或不可访问');
  await assertProject(db,actor,Number(job.project_id));
  const metrics=parse(job.metrics_json,{});const errors=parse(job.errors_json,[]);
  return {operation:{id,kind:'legacy_internal_sync',status:job.status,created_by:Number(job.created_by),project_ids:[Number(job.project_id)],
    created_at:job.created_at,updated_at:job.updated_at,progress:{completed:metrics.months||0,total:null,unit:'month'},
    data_through:metrics.dataThrough?{internal:metrics.dataThrough}:null,errors:errors.map(message=>({message})),
    result_available:TERMINAL.has(job.status),retry_after_seconds:TERMINAL.has(job.status)?null:2},
    succeeded_count:metrics.months||0,failed_count:errors.length,unprocessed_count:metrics.unprocessed||0,legacy_job_id:job.job_id};
}
async function currentActor(db, op) {
  // 同一快照校验账号、PAT 和完整项目范围，减少每个执行单元的重复权限查询。
  const user = await db.db.prepare(`SELECT u.id,u.role,
    (?<>'mcp' OR EXISTS(SELECT 1 FROM mcp_tokens t WHERE t.user_id=u.id AND t.token_id=? AND t.revoked_at IS NULL)) AS token_ok,
    NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN projects p ON p.id=j.value
      WHERE p.id IS NULL OR NOT(u.role='admin' OR COALESCE(p.owner_user_id=u.id,0)
        OR EXISTS(SELECT 1 FROM project_copywriters c WHERE c.project_id=p.id AND c.user_id=u.id AND c.revoked_at IS NULL))) AS scope_ok
    FROM users u WHERE u.id=? AND u.deleted_at IS NULL`).get(op.channel,op.token_id,op.project_ids_json,op.user_id);
  if (!user) fail('FORBIDDEN','创建账号已不可用');
  if (!user.token_ok) fail('FORBIDDEN','创建操作的 token 已撤销或重置');
  const actor={user_id:Number(user.id),current_role:user.role,channel:op.channel,token_id:op.token_id};
  if (!user.scope_ok) fail('FORBIDDEN','创建账号项目权限已变化');
  return actor;
}
function enabled(ctx) {
  if (!ctx.config?.MCP_BACKGROUND_ENABLED) fail('DEPENDENCY_UNAVAILABLE','后台最小执行单元尚未完成此环境资源验收');
}
async function queue(ctx, tool, input, actor, projectIds, kind, items, checkpoint={}, parent=null) {
  validateKey(input.idempotency_key);
  const {idempotency_key,...business}=input;
  const inputHash=hash(business);
  const old=await ctx.db.mcpFindOperation(actor.user_id,tool,idempotency_key);
  if (old) {
    if (old.input_hash!==inputHash) fail('IDEMPOTENCY_CONFLICT','同一幂等键已用于不同参数');
    return {op:old,reused:true};
  }
  let op=await ctx.db.mcpCreateQueuedOperation({id:randomUUID(),user_id:actor.user_id,channel:actor.channel||'mcp',
    token_id:actor.token_id,tool,input_hash:inputHash,idempotency_key,project_ids:projectIds,input:business,kind,
    checkpoint,parent_operation_id:parent},items);
  if(!op && kind==='sync') {
    const active=await ctx.db.mcpActiveSync(projectIds[0]);
    if(active?.input_hash===inputHash && Number(active.user_id)===actor.user_id)return {op:active,reused:true};
    fail('BUSY','项目存在活动同步，请稍后重试',{},true);
  }
  if(!op)fail('BUSY','操作认领已变化，请稍后重试',{},true);
  if (op.input_hash!==inputHash) fail('IDEMPOTENCY_CONFLICT','同一幂等键已用于不同参数');
  ctx.wakeOperations?.();
  return {op,reused:false};
}
async function replayQueued(ctx,tool,input,actor) {
  validateKey(input.idempotency_key);
  const previous=await ctx.db.mcpFindOperation(actor.user_id,tool,input.idempotency_key);
  if(!previous)return null;
  const {idempotency_key,...business}=input;
  if(previous.input_hash!==hash(business))fail('IDEMPOTENCY_CONFLICT','同一幂等键已用于不同参数');
  const access=await accessOperation(ctx.db,actor,previous.id,{receipt:true});
  const counts=await ctx.db.mcpOperationCounts(previous.id);
  return {op:previous,counts,receipt:access.receipt || (previous.detail_expires_at && previous.detail_expires_at<stamp())};
}
async function titlePlan(db, input, actor) {
  await assertProject(db,actor,input.project_id);
  const rows=[];let skippedManual=0;
  const articles=await db.mcpTitleArticles(input.project_id,input.article_type,input.article_ids);
  if(articles.length!==input.article_ids.length)fail('NOT_FOUND','文章不存在或不可访问');
  for (const article of articles) {
    const id=article.id;
    if (article.title_source==='manual' && !(input.mode==='force' && input.overwrite_manual)) {skippedManual++;continue;}
    if (article.status!=='active' || (input.mode!=='force' && String(article.title||'').trim() && article.title_fetch_status!=='failed')) continue;
    rows.push({key:String(id),revision:article.revision,input:{article_id:id,url:article.url,revision:article.revision}});
  }
  return {rows,skippedManual};
}
async function syncPlan(ctx, input, actor) {
  const project=await assertProject(ctx.db,actor,input.project_id);
  if (!ctx.google) fail('DEPENDENCY_UNAVAILABLE','同步服务不可用');
  if (input.article_ids && (await ctx.db.mcpTitleArticles(project.id,'internal',input.article_ids)).length!==input.article_ids.length)
    fail('NOT_FOUND','文章不存在或不可访问');
  const raw=input.scope==='internal'
    ? await ctx.google.planArticleSync(project,{months:input.months,force:input.force,articleIds:input.article_ids,
      articleId:input.article_ids?.length===1?input.article_ids[0]:null})
    : await ctx.google.planExternalDaily(project,{months:input.months,force:input.force});
  if (raw.skipped==='missing_publication_date') fail('VALIDATION_ERROR',raw.reason||'请先补填文章发布日期',
    {article_ids:raw.missingPublicationIds||[]});
  if (raw.skipped==='unconfigured' || (input.scope==='internal' && !project.gsc_site && !project.ga4_property_id)) fail('SOURCE_UNCONFIGURED','项目尚未配置相应数据源');
  const months=(raw.months||[]).map(m=>typeof m==='string'?m:m.month);
  // 默认站内计划包含已完成的历史；持久队列按实际执行单元控制预算，不能按业务跨度拒绝。
  if (months.length>6 && (input.scope!=='internal' || input.months)) fail('RANGE_TOO_LARGE','单次同步最多 6 个月，请明确拆分月份',{suggested_batches:months.reduce((all,m,i)=>{if(i%6===0)all.push([]);all.at(-1).push(m);return all;},[])});
  if (input.domain && !raw.domains?.includes(input.domain)) fail('NOT_FOUND','该项目没有登记此平台');
  const units=[];let affectedCount=null;const warnings=[];
  if (input.scope==='internal') {
    const registered=await ctx.db.mcpActiveSyncArticles(project.id);
    const selected=input.article_ids?registered.filter(a=>input.article_ids.includes(a.id)):registered;
    affectedCount=selected.length;
    const missing=new Set(raw.missingPublicationIds||[]);
    const missingIds=selected.filter(a=>missing.has(a.id)).map(a=>a.id);
    if(missingIds.length)warnings.push({code:'MISSING_PUBLICATION_DATE',message:'部分文章缺少有效发布日期，请补填后重新同步',article_ids:missingIds});
    const {gscAccountId,ga4AccountId}=resolveAccounts(project);
    const sources=[...(gscAccountId&&project.gsc_site?['gsc']:[]),...(ga4AccountId&&project.ga4_property_id?['ga4']:[])];
    const currentMonth=monthOf(businessDate());
    for (const article of selected) {
      if(missing.has(article.id)) {
        units.push({key:`publication:${article.id}`,input:{kind:'missing_publication',article_id:article.id,
          fetch_revision:article.fetch_revision,config_revision:project.config_revision}});
        continue;
      }
      const dependencies=[];
      for (const row of raw.months||[])for(const source of sources) {
        const month=typeof row==='string'?row:row.month;
        if(month>=currentMonth)continue;
        if(Array.isArray(row.articleIds) && !row.articleIds.includes(article.id))continue;
        if(row[source]?.need===false && row[source]?.reason!=='unavailable')continue;
        const key=`monthly:${month}:${article.id}:${source}`;dependencies.push(key);
        units.push({key,input:{kind:'monthly',month,source,article_id:article.id,
          fetch_revision:article.fetch_revision,config_revision:project.config_revision}});
      }
      if(raw.current?.planned!==false && (!Array.isArray(raw.current?.articleIds)||raw.current.articleIds.includes(article.id)))for(const source of sources){const key=`current:${currentMonth}:${article.id}:${source}`;dependencies.push(key);
        units.push({key,input:{kind:'current',month:currentMonth,source,article_id:article.id,fetch_revision:article.fetch_revision,config_revision:project.config_revision}});}
      if(dependencies.length)units.push({key:`zfinalize:${article.id}`,input:{kind:'internal_finalize',article_id:article.id,dependencies,
        fetch_revision:article.fetch_revision,config_revision:project.config_revision}});
    }
  } else {
    const registry=new Map((await ctx.db.mcpExternalRegistrySignatures(project.id)).map(r=>[r.domain,r.signature]));
    for (const domain of input.domain?[input.domain]:(raw.domains||[])) for (const row of raw.months||[]) {
    if(row.need===false || !row.range)continue;
    const sources=['users',...(parseKeyEventNames(project.key_event_names).length?['events']:[])];
    for(const source of sources) {
      const dependencies=[];
      for(let start=row.range.start;start<=row.range.end;start=shiftDay(start,8)) {
        const end=shiftDay(start,7)<row.range.end?shiftDay(start,7):row.range.end;
        const key=`days:${row.month}:${domain}:${source}:${start}`;dependencies.push(key);
        units.push({key,input:{kind:'external_days',month:row.month,domain,source,start,end,registry_signature:registry.get(domain),config_revision:project.config_revision}});
      }
      units.push({key:`finalize:${row.month}:${domain}:${source}`,input:{kind:'external_finalize',month:row.month,domain,source,
        start:row.range.start,end:row.range.end,dependencies,registry_signature:registry.get(domain),config_revision:project.config_revision}});
    }
  }
  }
  if(units.length>200 || Buffer.byteLength(JSON.stringify(units))>192*1024)fail('RANGE_TOO_LARGE','同步范围超过 200 个安全执行单元或检查点预算，请拆分文章、月份或平台',
    {estimated_units:units.length,suggestion:input.scope==='internal'?'每批最多约 10 篇文章、1 到 6 个月':'每批选择一个平台或缩小月份'});
  const requests=units.filter(u=>!u.input.kind.endsWith('_finalize')&&u.input.kind!=='missing_publication').length;
  return {project,units,preview:{generated_at:stamp(),input_hash:hash(input),affected_count:affectedCount,
    changes:[],warnings,input_revisions:[{project_id:project.id,config_revision:project.config_revision}],estimated_cost:{google_requests:requests},
    plan:{months,sources:input.scope==='internal'?['gsc','ga4_views','ga4_key_events']:['external_users','external_events'],
      url_batches:raw.urlBatches||0,domain_batches:input.scope==='external'?Math.ceil((raw.domains?.length||0)/30):0,
      estimated_google_requests:requests,
      skipped:(raw.months||[]).filter(m=>m.need===false || (m.gsc?.need===false && m.ga4?.need===false)),
      unavailable:(raw.months||[]).filter(m=>m.gsc?.reason==='unavailable'||m.ga4?.reason==='unavailable'),suggested_batches:[]},estimate_complete:false}};
}
function getReadTools(ctx) { return ctx.getReadTools ? ctx.getReadTools() : require('./mcp-read')(ctx); }
function exportFilter(ctx,input) {
  const name={internal_articles:'query_article_metrics',external_platforms:'list_external_platforms',project_report:'get_project_report'}[input.report_type];
  const descriptor=getReadTools(ctx).find(t=>t.name===name);
  if (!descriptor) fail('DEPENDENCY_UNAVAILABLE','报表读取服务不可用');
  if ('page' in input.filters || 'page_size' in input.filters) fail('VALIDATION_ERROR','导出 filters 不接受 page/page_size');
  const filters={...input.filters};
  if (input.report_type==='internal_articles') {
    if (filters.group_by && filters.group_by!=='article') fail('VALIDATION_ERROR','站内文章导出固定按 article 分组');
    filters.group_by='article';
  }
  const parsed=descriptor.inputSchema.safeParse(input.report_type==='project_report'?filters:{...filters,page:1,page_size:100});
  if (!parsed.success) fail('VALIDATION_ERROR','导出筛选参数无效',{issues:parsed.error.issues});
  return {descriptor,filters:parsed.data};
}
async function exportProjects(ctx, filters, actor) {
  const ids=filters.project_id?[filters.project_id]:filters.project_ids;
  if(ids) {
    if(Number((await ctx.db.mcpOperationProjectAccessCount(ids,actor.user_id)).count)!==ids.length)fail('NOT_FOUND','项目不存在或不可访问');
    return ids;
  }
  const projects=await ctx.db.listProjects({ownerUserId:actor.user_id,isAdmin:actor.current_role==='admin'});
  if (projects.length>20) fail('RANGE_TOO_LARGE','一致导出最多 20 个项目，请分批指定 project_ids');
  return projects.map(p=>p.id);
}

function createOperationTools(ctx) {
  const tool=(id,name,title,effect,inputSchema,handler,phase=3)=>({id,name,title,description:title,phase,effect,inputSchema,handler});
  return [
    tool('T20','get_operation_status','查询持久操作状态','R',z.object({operation_id:opId}).strict(),async(input,actor)=>{
      if(input.operation_id.startsWith('legacy-sync:'))return {data:await legacyStatus(ctx.db,input.operation_id,actor)};
      const {op,receipt}=await accessOperation(ctx.db,actor,input.operation_id,{receipt:true});
      const counts=await ctx.db.mcpOperationCounts(op.id);
      return {data:receipt?minimalReceipt(op,counts):{operation:operationDto(op,counts),succeeded_count:Number(counts.succeeded),failed_count:Number(counts.failed),unprocessed_count:Number(counts.unprocessed)}};
    },2),
    tool('T21','get_operation_result','分页读取操作结果或导出元信息','R',z.object({operation_id:opId,result_part:z.enum(['summary','items','report_rows','artifact']).default('summary'),...pageSchema.shape}).strict(),async(input,actor)=>{
      const {op,receipt}=await accessOperation(ctx.db,actor,input.operation_id,{receipt:input.result_part==='summary'});
      const counts=await ctx.db.mcpOperationCounts(op.id);
      if (receipt) return {data:minimalReceipt(op,counts)};
      if (!TERMINAL.has(op.status)) fail('BUSY','操作结果尚未就绪',{},true);
      if (op.detail_expires_at && op.detail_expires_at<stamp()) fail('OPERATION_EXPIRED','详细结果已过期，请重新执行');
      if (input.result_part==='summary') {
        const summary=parse(op.result_summary_json,{status:op.status,committed_count:counts.succeeded});
        if(op.kind==='mutation' && !await canExposeMutationItems(ctx.db,actor,await ctx.db.mcpOperationItems(op.id,1,counts.total)))return {data:minimalReceipt(op,counts)};
        return {data:{summary}};
      }
      if (input.result_part==='items') {
        let rows;
        if(op.kind==='mutation') {
          const all=await ctx.db.mcpOperationItems(op.id,1,counts.total);
          if(!await canExposeMutationItems(ctx.db,actor,all))fail('FORBIDDEN','当前权限不覆盖已保存的业务结果');
          rows=all.slice((input.page-1)*input.page_size,input.page*input.page_size);
        }else rows=await ctx.db.mcpOperationItems(op.id,input.page,input.page_size);
        return {data:{items:rows.map(r=>({key:r.item_key,state:r.state,result:parse(r.result_json),error:parse(r.error_json)}))},meta:{pagination:pagination(input.page,input.page_size,counts.total,rows.length)}};
      }
      const artifact=await ctx.db.mcpGetExportArtifact(op.id);
      if (!artifact || op.status!=='succeeded' || artifact.expires_at<stamp()) fail('OPERATION_EXPIRED','导出文件不可用或已过期');
      if (input.result_part==='artifact') return {data:{artifact:{name:artifact.name,mime_type:artifact.mime_type,bytes:artifact.bytes,
        expires_at:artifact.expires_at,download_path:`/mcp/exports/${op.id}`,auth_required:true,checksum:artifact.checksum}}};
      const chunks=await ctx.db.mcpExportChunks(artifact.id);
      const rows=chunks.flatMap(c=>parse(c.rows_json,[]));const page=rows.slice((input.page-1)*input.page_size,input.page*input.page_size);
      return {data:{report_rows:page},meta:{pagination:pagination(input.page,input.page_size,rows.length,page.length)}};
    },2),
    tool('T31','plan_sync','零写入估算同步范围','P',syncSchema,async(input,actor)=>({data:(await syncPlan(ctx,input,actor)).preview})),
    tool('T32','preview_changes','零写入预览允许的业务修改','P',z.object({action:z.enum(['assign_articles','change_article_url','set_article_status',
      'change_external_domain','update_project_configuration','update_project','delete_task','delete_link','delete_articles','reorder_articles','fetch_article_titles']),arguments:z.record(z.string(),z.unknown())}).strict(),async(input,actor)=>{
      if ('idempotency_key' in input.arguments) fail('VALIDATION_ERROR','预览不接受 idempotency_key');
      if (input.action==='fetch_article_titles') {
        const checked=titleSchema.safeParse(input.arguments);if (!checked.success) fail('VALIDATION_ERROR','标题预览参数无效');
        const plan=await titlePlan(ctx.db,checked.data,actor);
        return {data:{generated_at:stamp(),input_hash:hash(checked.data),affected_count:plan.rows.length,
          changes:plan.rows.map(r=>({article_id:r.input.article_id,fields:['title'],current_revision:r.revision})),
          warnings:plan.skippedManual?[{code:'MANUAL_TITLE_PRESERVED',count:plan.skippedManual}]:[],estimated_cost:{external_requests:plan.rows.length},
          input_revisions:plan.rows.map(r=>({article_id:r.input.article_id,revision:r.revision}))}};
      }
      const descriptors=ctx.getWriteTools?ctx.getWriteTools():require('./mcp-write').createWriteTools(ctx);
      const descriptor=descriptors.find(t=>t.name===input.action);
      if (!descriptor?.preview) fail('DEPENDENCY_UNAVAILABLE','共享变更预览服务不可用');
      const checked=descriptor.inputSchema.omit({idempotency_key:true}).safeParse(input.arguments);
      if(!checked.success)fail('VALIDATION_ERROR','变更预览参数无效',{issues:checked.error.issues});
      return {data:await descriptor.preview(checked.data,actor)};
    }),
    tool('T33','start_sync','排队启动指标同步','X',withKey(syncSchema),async(input,actor)=>{
      enabled(ctx);const previous=await replayQueued(ctx,'start_sync',input,actor);
      if(previous){const {idempotency_key,...scope}=input;return {data:previous.receipt?minimalReceipt(previous.op,previous.counts)
        :{operation:operationDto(previous.op,previous.counts),reused:true,accepted_scope:scope,remaining_scope:[],poll_after_seconds:2}};}
      const plan=await syncPlan(ctx,input,actor);
      const active=await ctx.db.mcpActiveSync(input.project_id);
      const {idempotency_key,...business}=input;
      if(active && Number(active.user_id)!==actor.user_id && actor.current_role!=='admin')fail('BUSY','项目存在活动同步，请稍后重试',{},true);
      if (active && active.input_hash!==hash(business)) fail('BUSY','项目存在不同范围的活动同步',{},true);
      if (active) return {data:{operation:operationDto(active,await ctx.db.mcpOperationCounts(active.id)),reused:true,accepted_scope:business,remaining_scope:[],poll_after_seconds:2}};
      const q=await queue(ctx,'start_sync',input,actor,[input.project_id],'sync',plan.units);
      return {data:{operation:operationDto(q.op,await ctx.db.mcpOperationCounts(q.op.id)),reused:q.reused,accepted_scope:business,remaining_scope:[],poll_after_seconds:2}};
    }),
    tool('T34','cancel_operation','停止尚未提交的操作单元','M',z.object({operation_id:opId,idempotency_key:keySchema}).strict(),async(input,actor)=>{
      validateKey(input.idempotency_key);
      const {op,receipt}=await accessOperation(ctx.db,actor,input.operation_id,{cancel:true});
      const counts=await ctx.db.mcpOperationCounts(op.id);const changed=!TERMINAL.has(op.status);
      const data=receipt?{...minimalReceipt(op,counts),changed,rollback_performed:false}
        :{operation:operationDto(op,counts),changed,already_committed_count:counts.succeeded,remaining_count:counts.unprocessed,rollback_performed:false};
      const sql=ctx.db.db;
      const output=await ctx.mutate({tool:'cancel_operation',input,actor,prepare:async()=>({projectIds:[],units:[{
        key:op.id,guards:[{code:'FORBIDDEN',message:'无权停止此操作',sql:`SELECT EXISTS(SELECT 1 FROM business_operations o
          JOIN users u ON u.id=? AND u.deleted_at IS NULL WHERE o.id=? AND (o.user_id=u.id OR u.role='admin'))`,args:[actor.user_id,op.id]}],
        statements:[sql.prepare(`UPDATE business_operations SET status=CASE WHEN lease_id IS NULL OR lease_expires_at<=?
          THEN 'cancelled' ELSE 'cancel_requested' END,updated_at=?,
          detail_expires_at=CASE WHEN lease_id IS NULL OR lease_expires_at<=? THEN ? ELSE detail_expires_at END,
          expires_at=CASE WHEN lease_id IS NULL OR lease_expires_at<=? THEN ? ELSE expires_at END
          WHERE id=? AND status IN ('queued','running','cancel_requested')`)
          .bind(stamp(),stamp(),stamp(),new Date(Date.now()+86400000).toISOString(),stamp(),new Date(Date.now()+91*86400000).toISOString(),op.id)],
        result:{...data,effects:changed?['cancellation_requested']:[]},
        // json_patch 会递归删除嵌套 null，导致已提交的取消回执不能通过公开输出契约。
        resultSql:{sql:`SELECT CASE WHEN ?=1 THEN json_set(?,'$.status',status)
          ELSE json_set(?,'$.operation.status',status,'$.operation.updated_at',updated_at) END AS result_json
          FROM business_operations WHERE id=?`,args:[receipt?1:0,JSON.stringify(data),JSON.stringify(data),op.id]},
      }]})});
      const {effects,...publicResult}=output.results?.[0]||output;
      if(output.receipt_only)return {data:{...minimalReceipt(op,counts),changed:false,rollback_performed:false}};
      if (publicResult.operation) {
        // 也修复旧版本已提交、响应失败的幂等回执；终态不再提示客户端继续轮询。
        publicResult.operation.data_through ??= null;
        publicResult.operation.progress.total ??= null;
        publicResult.operation.result_available = TERMINAL.has(publicResult.operation.status);
        publicResult.operation.retry_after_seconds = publicResult.operation.result_available ? null : 2;
      }
      return {data:publicResult};
    }),
    tool('T35','retry_operation','仅重试失败与未处理单元','M',z.object({operation_id:opId,retry_scope:z.enum(['failed','unprocessed','both']),idempotency_key:keySchema}).strict(),async(input,actor)=>{
      enabled(ctx);let {op}=await accessOperation(ctx.db,actor,input.operation_id);
      validateKey(input.idempotency_key);
      const previous=await ctx.db.mcpFindOperation(actor.user_id,'retry_operation',input.idempotency_key);
      if(previous){const {idempotency_key,...business}=input;if(previous.input_hash!==hash(business))fail('IDEMPOTENCY_CONFLICT','同一幂等键已用于不同重试意图');
        await accessOperation(ctx.db,actor,previous.id);return {data:{operation:operationDto(previous,await ctx.db.mcpOperationCounts(previous.id)),parent_operation_id:op.id,reused:true,skipped_succeeded_count:(await ctx.db.mcpOperationCounts(op.id)).succeeded}};}
      if(!TERMINAL.has(op.status))fail('BUSY','原操作仍在执行',{},true);
      if(op.detail_expires_at && op.detail_expires_at<stamp() || !op.input_json)fail('OPERATION_EXPIRED','重试输入已过期');
      if(op.kind==='import_retry') {
        const sourceId=parse(op.result_summary_json,{}).source_operation_id;
        if(!sourceId)fail('OPERATION_EXPIRED','重试来源检查点不可用');
        op=(await accessOperation(ctx.db,actor,sourceId)).op;
      }
      if(op.tool==='import_articles') {
        const summary=parse(op.result_summary_json,{});
        const failed=summary.failed||[];const unprocessed=summary.unprocessed||[];
        const selected=input.retry_scope==='failed'?failed:input.retry_scope==='unprocessed'?unprocessed:[...failed,...unprocessed];
        const keys=[...new Set(selected.map(r=>r.key))];const counts=await ctx.db.mcpOperationCounts(op.id);
        if(!keys.length)return {data:{operation:operationDto(op,counts),changed:false,parent_operation_id:op.id,reused:true,skipped_succeeded_count:counts.succeeded}};
        const descriptor=(ctx.getWriteTools?ctx.getWriteTools():require('./mcp-write').createWriteTools(ctx)).find(t=>t.name==='import_articles');
        const retryInput=await descriptor.retryInput(parse(op.input_json),keys,actor,parse(op.checkpoint_json,{}));
        const q=await queue(ctx,'retry_operation',input,actor,parse(op.project_ids_json,[]),'import_retry',
          [{key:'import',input:{import_input:retryInput}}],{},op.id);
        return {data:{operation:operationDto(q.op,await ctx.db.mcpOperationCounts(q.op.id)),parent_operation_id:op.id,
          reused:q.reused,skipped_succeeded_count:counts.succeeded}};
      }
      if (!['sync','titles','export'].includes(op.kind)) fail('DEPENDENCY_UNAVAILABLE','此类型尚未提供持久重试');
      const states=input.retry_scope==='both'?['failed','queued','running']:input.retry_scope==='failed'?['failed']:['queued','running'];
      const rows=await ctx.db.mcpOperationItems(op.id,1,101,states);
      if(rows.length>100)fail('RANGE_TOO_LARGE','重试单元超过 100，请缩小范围重新计划');
      const counts=await ctx.db.mcpOperationCounts(op.id);
      if(!rows.length)return {data:{operation:operationDto(op,counts),changed:false,parent_operation_id:op.id,reused:true,skipped_succeeded_count:counts.succeeded}};
      const business=parse(op.checkpoint_json,{}).original_input||parse(op.input_json);
      if(op.kind==='sync') {
        const project=await assertProject(ctx.db,actor,business.project_id);
        if(rows.some(r=>parse(r.input_json,{}).config_revision!==project.config_revision))fail('CONFLICT','同步配置已变化，请重新计划');
      }
      if(op.kind==='titles')for(const row of rows) {
        const saved=parse(row.input_json,{});const current=await ctx.db.getArticleForTitle(saved.article_id,business.article_type);
        if(!current || current.url!==saved.url || current.revision!==saved.revision)fail('CONFLICT','标题重试目标修订已变化，请重新提交');
      }
      let checkpoint={...parse(op.checkpoint_json,{}),original_input:business};
      if(op.kind==='export') {
        const vector=parse(op.checkpoint_json,{}).vector||[];
        const fresh=vector.length?await ctx.db.mcpProjectVector(vector.map(p=>p.id)):[];
        if(canonicalJson(fresh)!==canonicalJson(vector))fail('CONFLICT','报表数据修订已变化，请重新导出');
        checkpoint={vector,page:1,rows:0,bytes:0,original_input:business};
      }
      const q=await queue(ctx,'retry_operation',input,actor,parse(op.project_ids_json,[]),op.kind,
        rows.map(r=>({key:r.item_key,input:parse(r.input_json),revision:r.expected_revision})),checkpoint,op.id);
      return {data:{operation:operationDto(q.op,await ctx.db.mcpOperationCounts(q.op.id)),parent_operation_id:op.id,reused:q.reused,skipped_succeeded_count:counts.succeeded}};
    }),
    tool('T36','fetch_article_titles','抓取已登记文章的标题','X',withKey(titleSchema),async(input,actor)=>{
      enabled(ctx);const previous=await replayQueued(ctx,'fetch_article_titles',input,actor);
      if(previous)return {data:previous.receipt?minimalReceipt(previous.op,previous.counts)
        :{operation:operationDto(previous.op,previous.counts),accepted_count:previous.op.progress_total,
          skipped_manual_count:parse(previous.op.checkpoint_json,{}).skipped_manual_count||0,reused:true}};
      const plan=await titlePlan(ctx.db,input,actor);
      const q=await queue(ctx,'fetch_article_titles',input,actor,[input.project_id],'titles',plan.rows,{skipped_manual_count:plan.skippedManual});
      return {data:{operation:operationDto(q.op,await ctx.db.mcpOperationCounts(q.op.id)),accepted_count:q.op.progress_total,
        skipped_manual_count:plan.skippedManual,reused:q.reused}};
    }),
    tool('T37','export_report','生成持久化有界报告文件','E',z.object({report_type:z.enum(['internal_articles','external_platforms','project_report']),
      filters:z.record(z.string(),z.unknown()),format:z.enum(['csv','tsv','xlsx']),include_details:z.boolean().default(false),idempotency_key:keySchema}).strict(),async(input,actor)=>{
      enabled(ctx);const previous=await replayQueued(ctx,'export_report',input,actor);
      if(previous)return {data:previous.receipt?minimalReceipt(previous.op,previous.counts)
        :{operation:operationDto(previous.op,previous.counts),estimated_rows:null,estimated_bytes:null,result_expiry:previous.op.detail_expires_at||null}};
      const checked=exportFilter(ctx,input);const ids=await exportProjects(ctx,checked.filters,actor);
      const vector=ids.length?await ctx.db.mcpProjectVector(ids):[];
      const q=await queue(ctx,'export_report',input,actor,ids,'export',[{key:'report',input:{}}],{vector,page:1,rows:0,bytes:0});
      return {data:{operation:operationDto(q.op,await ctx.db.mcpOperationCounts(q.op.id)),estimated_rows:null,estimated_bytes:null,result_expiry:null}};
    }),
  ];
}

function flatRow(value) {
  const result={};
  for(const [key,item]of Object.entries(value||{})) {
    if(key==='metrics' && Array.isArray(item))for(const metric of item){result[metric.key]=metric.value;result[`${metric.key}_status`]=metric.status;}
    else result[key]=item && typeof item==='object'?JSON.stringify(item):item;
  }
  return result;
}
function fileFor(input,rows,metadata) {
  const flat=rows.map(flatRow);const headers=[...new Set(flat.flatMap(r=>Object.keys(r)))];
  const table=[headers,...flat.map(r=>headers.map(h=>r[h]??null))];
  if(input.format==='xlsx')return {bytes:buildXlsx([{name:'数据',rows:table},{name:'筛选与口径',rows:[['字段','值'],...Object.entries(metadata).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):v])]}]),mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
  const separator=input.format==='tsv'?'\t':',';
  const encode=(value)=>{if(value==null)return '';const text=typeof value==='number'?String(value):sanitizeText(String(value));return /["\r\n,\t]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;};
  return {bytes:Buffer.from('\ufeff'+table.map(r=>r.map(encode).join(separator)).join('\r\n')+'\r\n'),mime:input.format==='tsv'?'text/tab-separated-values; charset=utf-8':'text/csv; charset=utf-8'};
}
async function exportStep(ctx,op,lease,input,actor) {
  const checkpoint=parse(op.checkpoint_json,{});const vector=checkpoint.vector||[];
  const ids=vector.map(p=>p.id);const fresh=ids.length?await ctx.db.mcpProjectVector(ids):[];
  if(canonicalJson(fresh)!==canonicalJson(vector))fail('CONFLICT','导出数据修订已变化，请重新生成');
  const artifactId=`artifact:${op.id}`;
  if(!checkpoint.read_complete) {
    const checked=exportFilter(ctx,input);
    // 未传 project_ids 也必须沿用排队时的范围，不能把之后新增或新授权的项目混入快照。
    const args=input.report_type==='project_report'?checked.filters:{...checked.filters,project_ids:ids,page:checkpoint.page||1,page_size:100};
    const result=ids.length || input.report_type==='project_report'
      ? await checked.descriptor.handler(args,actor)
      : {data:{rows:[],summary:{}},meta:{pagination:{has_more:false}}};
    const rows=input.report_type==='project_report'?[result.data]:(result.data.rows||result.data.items||[]);
    const serialized=Buffer.byteLength(JSON.stringify(rows));const count=(checkpoint.rows||0)+rows.length;
    const payloadBytes=(checkpoint.bytes||0)+serialized;
    if(count>10000 || payloadBytes>MAX_BYTES)fail('BUDGET_EXCEEDED','导出超过 10,000 行或 5 MiB，请缩小范围');
    if(!Number((await ctx.db.mcpCreatePendingArtifact(artifactId,op.id,lease)).changes))
      fail('BUDGET_EXCEEDED','导出临时存储额度不足或执行租约已失效');
    if(!await ctx.db.mcpLeaseOwned(op.id,lease))fail('CONFLICT','导出租约已失效');
    await ctx.db.mcpSaveExportChunk(artifactId,(checkpoint.page||1)-1,Buffer.alloc(0),rows,op.id,lease);
    const hasMore=input.report_type!=='project_report' && (result.meta?.pagination?.has_more || result.data.pagination?.has_more);
    const metadata={...result.meta,summary:result.data.summary,requested_period:result.data.requested_period,
      effective_period:result.data.effective_period,sources:result.data.sources,coverage:result.data.coverage,
      definitions_version:result.data.definitions_version};
    Object.assign(checkpoint,{page:(checkpoint.page||1)+1,rows:count,bytes:payloadBytes,metadata,read_complete:!hasMore});
    // Checkpoint the read results so file assembly can resume after interruption.
    await ctx.db.mcpCheckpointOperation(op.id,lease,checkpoint);return {pending:true};
  }
  const chunks=await ctx.db.mcpExportChunks(artifactId);const all=chunks.flatMap(c=>parse(c.rows_json,[]));
  const payloadBytes=checkpoint.bytes;
  const metadata={filters:input.filters,...checkpoint.metadata,definitions_version:checkpoint.metadata?.definitions_version||'mcp-v1',include_details:input.include_details,
    attribution:input.report_type==='external_platforms'?'platform_total':null};
  const file=fileFor(input,all,metadata);
  if(file.bytes.length+payloadBytes>MAX_BYTES)fail('BUDGET_EXCEEDED','文件与结构化结果合计超过 5 MiB，请缩小范围');
  const usage=await ctx.db.mcpExportUsage(actor.user_id,artifactId);
  if(Number(usage.total)+file.bytes.length+payloadBytes>50*1024*1024 || Number(usage.user_total)+file.bytes.length+payloadBytes>20*1024*1024)
    fail('BUDGET_EXCEEDED','待取回导出结果存储额度不足');
  // Bounded binary chunks keep assembly memory bounded; publish only after the final vector guard.
  const start=checkpoint.binary_offset||0;const end=Math.min(file.bytes.length,start+10*48*1024);
  for(let offset=start;offset<end;offset+=48*1024)await ctx.db.mcpSaveExportChunk(artifactId,1000+offset/(48*1024),
    file.bytes.subarray(offset,Math.min(offset+48*1024,end)),[],op.id,lease);
  if(end<file.bytes.length){await ctx.db.mcpCheckpointOperation(op.id,lease,{...checkpoint,binary_offset:end});return {pending:true};}
  const artifact={id:artifactId,name:`${input.report_type}-${businessDate()}.${input.format}`,mime_type:file.mime,bytes:file.bytes.length,
    payload_bytes:payloadBytes,checksum:createHash('sha256').update(file.bytes).digest('hex'),summary:{row_count:all.length,metadata}};
  if(!await ctx.db.mcpPublishExport(op,lease,artifact,vector))fail('CONFLICT','最终发布时权限、token 或数据修订已变化');
  return {published:true};
}
async function executeUnit(ctx,op,lease,item,input,actor) {
  const unit=parse(item.input_json,{});
  if(op.kind==='import_retry') {
    const descriptor=(ctx.getWriteTools?ctx.getWriteTools():require('./mcp-write').createWriteTools(ctx)).find(t=>t.name==='import_articles');
    const response=await descriptor.handler(descriptor.inputSchema.parse({...unit.import_input,idempotency_key:op.idempotency_key}),actor);
    const source=await ctx.db.mcpGetOperation(response.data.operation_id);
    return {result:{...response.data,source_operation_id:source.id,source_status:source.status}};
  }
  if(op.kind==='titles') {
    const article=await ctx.db.getArticleForTitle(unit.article_id,input.article_type);
    if(!article || Number(article.project_id)!==input.project_id || article.url!==unit.url || article.revision!==unit.revision)
      fail('CONFLICT','文章地址或标题修订已变化');
    if(article.status!=='active' || (article.title_source==='manual' && !(input.mode==='force' && input.overwrite_manual)))fail('CONFLICT','文章状态或人工标题已变化');
    const project=await assertProject(ctx.db,actor,input.project_id);
    const url=new URL(article.url,project.website||undefined).href;
    const outcome=await (ctx.fetchTitle||fetchArticleTitle)(url,{requirePublicDns:true,resolveHost:ctx.resolveTitleHost});
    await currentActor(ctx.db,op);
    if(!await ctx.db.mcpLeaseOwned(op.id,lease))fail('CONFLICT','执行租约已失效');
    if(outcome.error) {
      const retryable=/^(timeout|network|http_429|http_5\d\d)$/.test(outcome.error);
      if(retryable && item.attempts<2)return {error:{code:'SOURCE_ERROR',message:outcome.error},retryAfter:Math.max(2**item.attempts*2,outcome.retry_after_seconds||0)};
    }
    if(!await ctx.db.mcpCommitFetchedTitle(op,lease,item,article,input.article_type,outcome))fail('CONFLICT','抓取期间文章或租约已变化');
    return outcome.error?{error:{code:'SOURCE_ERROR',message:outcome.error}}:{result:{article_id:article.id,title:outcome.title,effects:['title_fetched']}};
  }
  if(op.kind==='sync') {
    const project=await assertProject(ctx.db,actor,input.project_id);
    if(project.config_revision!==unit.config_revision)fail('CONFLICT','同步配置已变化，请重新计划');
    if(unit.kind==='missing_publication') {
      const article=await ctx.db.getArticleForTitle(unit.article_id,'internal');
      if(!article || article.fetch_revision!==unit.fetch_revision)fail('CONFLICT','文章取数修订已变化，请重新计划');
      return {error:{code:'VALIDATION_ERROR',message:'文章缺少有效发布日期，请补填后重新同步'},result:{article_id:unit.article_id}};
    }
    if(!ctx.google.createScoped)fail('DEPENDENCY_UNAVAILABLE','同步引擎未提供原子操作守卫');
    const itemResult={month:unit.month,source:unit.source,...(unit.article_id?{article_id:unit.article_id}:{}),
      ...(unit.domain?{domain:unit.domain,start:unit.start,end:unit.end}:{}),kind:unit.kind};
    const scopedGoogle=(assertions={})=>ctx.google.createScoped(require('./mcp-operation-db').operationScopedDb(ctx.db,op,lease,
      {...unit,...assertions,item_key:item.item_key,item_result:itemResult}));
    let google=scopedGoogle();
    let result;
    if(input.scope==='internal' && unit.kind!=='internal_finalize') {
      const article=await ctx.db.getArticleForTitle(unit.article_id,'internal');
      if(!article || article.fetch_revision!==unit.fetch_revision)fail('CONFLICT','文章取数修订已变化，请重新计划');
      if(!google.fetchArticleMetricsUnit)fail('DEPENDENCY_UNAVAILABLE','站内安全执行单元尚未就绪');
      const options={articleId:unit.article_id,month:unit.month,source:unit.source,
        fetchRevision:unit.fetch_revision,current:unit.kind==='current',force:input.force};
      try {result=await google.fetchArticleMetricsUnit(project,options);}
      catch(error) {
        const retryable=/timeout|network|fetch failed|ECONN|http_429|http_5\d\d/i.test(error.message||'') || error.status===429 || error.status>=500;
        if(error.code==='SOURCE_ERROR' && retryable && item.attempts<2)return {error:publicFailure(error),retryAfter:Math.max(2**(item.attempts+1),error.retry_after_seconds||0)};
        if(error.code==='SOURCE_ERROR' && google.markArticleMetricsUnitError)await google.markArticleMetricsUnitError(project,{...options,error:publicFailure(error).message});
        throw error;
      }
    } else if(unit.kind==='external_days') {
      if(!google.fetchExternalDailyUnit)fail('DEPENDENCY_UNAVAILABLE','外链安全执行单元尚未就绪');
      try {result=await google.fetchExternalDailyUnit(project,{domain:unit.domain,source:unit.source,month:unit.month,start:unit.start,end:unit.end});}
      catch(error){if(error.code==='SOURCE_ERROR' && error.retryable && item.attempts<2)return {error:publicFailure(error),retryAfter:Math.max(2**(item.attempts+1),error.retry_after_seconds||0)};throw error;}
    } else {
      const dependencies=await ctx.db.mcpSyncDependencies(op.id,unit.dependencies);
      if(dependencies.length!==unit.dependencies.length)fail('CONFLICT','来源检查点不完整，请重新计划');
      if(dependencies.some(d=>['queued','running','unprocessed'].includes(d.state)))fail('BUSY','来源安全单元尚未完成',{},true);
      const succeeded=dependencies.every(d=>d.state==='succeeded');
      // A retry can depend on successful source checkpoints from its parent operation.
      google=scopedGoogle(succeeded?{dependency_assertions:dependencies.map(d=>({operation_id:d.operation_id,item_key:d.item_key}))}
        :{dependencies:[],dependency_assertions:[]});
      if(unit.kind==='internal_finalize') {
        if(!succeeded)return {error:{code:'SOURCE_ERROR',message:'部分来源安全单元失败，保留文章 dirty 状态'}};
        if(!google.finalizeArticleMetricsUnit)fail('DEPENDENCY_UNAVAILABLE','站内安全状态收敛单元尚未就绪');
        result=await google.finalizeArticleMetricsUnit(project,{articleId:unit.article_id,fetchRevision:unit.fetch_revision});
      } else {
      if(!google.finalizeExternalDailyUnit)fail('DEPENDENCY_UNAVAILABLE','外链来源状态收敛单元尚未就绪');
      result=await google.finalizeExternalDailyUnit(project,{domain:unit.domain,source:unit.source,month:unit.month,
        start:unit.start,end:unit.end,status:succeeded?'complete':'error',fetchedAt:stamp()});
      if(!succeeded)return {result,error:{code:'SOURCE_ERROR',message:'部分日数据安全单元失败，保留上次完整成功事实'}};
      }
    }
    if(result.status==='busy')return {error:{code:'BUSY',message:'同步引擎忙碌'},retryAfter:4};
    if(result.status==='error'||result.status==='range-exceeded'||result.failed?.length || result.unprocessed?.length)
      return {error:{code:'SOURCE_ERROR',message:result.error||result.reason||'同步范围未完整完成',details:{failed:result.failed,unprocessed:result.unprocessed}},result};
    return {result};
  }
  fail('DEPENDENCY_UNAVAILABLE','该操作类型没有执行器');
}
async function advanceOperation(ctx,id) {
  enabled(ctx);let op=await ctx.db.mcpGetOperation(id);if(!op||TERMINAL.has(op.status))return {changed:false};
  if(op.kind==='mutation')return {changed:false};
  if(op.status==='cancel_requested'){await ctx.db.mcpSettleOperationCancel(id);return {cancelled:true};}
  const lease=await ctx.db.mcpClaimOperation(id);if(!lease)return {busy:true};
  op=await ctx.db.mcpGetOperation(id);
  try {
    const actor=await currentActor(ctx.db,op);const checkpoint=parse(op.checkpoint_json,{});
    const input=checkpoint.original_input||parse(op.input_json,{});
    if(op.kind==='export')return await exportStep(ctx,op,lease,input,actor);
    const item=await ctx.db.mcpNextOperationItem(id);
    if(!item){
      const counts=await ctx.db.mcpOperationCounts(id);
      if(counts.unprocessed){await ctx.db.mcpCheckpointOperation(id,lease,checkpoint);return {pending:true};}
      let status=counts.failed?(counts.succeeded?'partial':'failed'):'succeeded';
      const summary={succeeded_count:counts.succeeded,failed_count:counts.failed,unprocessed_count:counts.unprocessed};
      if(op.kind==='import_retry') {
        const rows=await ctx.db.mcpOperationItems(id,1,1);const child=parse(rows[0]?.result_json,{});
        if(child.source_status)status=child.source_status;summary.source_operation_id=child.source_operation_id;
      }
      await ctx.db.mcpCompleteOperation(id,lease,status,summary);
      return {status};
    }
    let outcome;
    try{outcome=await executeUnit(ctx,op,lease,item,input,actor);}catch(error){outcome={error:publicFailure(error)};}
    if(outcome.retryAfter && item.attempts>=2)delete outcome.retryAfter;
    await ctx.db.mcpFinishOperationItem(id,lease,item.item_key,outcome.result,outcome.error,outcome.retryAfter);
    return {pending:true};
  }catch(error){
    const failure=publicFailure(error);await ctx.db.mcpCompleteOperation(id,lease,'failed',null,failure);
    return {failed:true,error:failure};
  }
}
async function runOperationScheduler(ctx,{limit=1}={}) {
  if(!ctx.config?.MCP_BACKGROUND_ENABLED)return {enabled:false,processed:0};
  const metered=await collectQueryMetrics(async()=>{
    const pending=await ctx.db.mcpRunnableOperations(Math.min(limit,1));
    // 空轮询只读队列，避免空闲期间反复写入数据库。
    if(!pending.length)return {enabled:true,processed:0,idle:true};
    // 连续恢复失败的租约先终结，再把本轮执行槽交给后续就绪任务。
    const abandoned=await ctx.db.mcpFailAbandonedOperations();
    const operations=Number(abandoned.changes)>0 ? await ctx.db.mcpRunnableOperations(Math.min(limit,1)) : pending;
    for(const op of operations)await advanceOperation(ctx,op.id);
    return {enabled:true,processed:operations.length};
  });
  return {...(metered.value||{enabled:true,processed:0,error:publicFailure(metered.error)}),
    usage:{queries:metered.metrics.queries}};
}
async function runOperationMaintenance(db) {
  await db.mcpSettleStaleMutations();
  await db.mcpPruneOperationDetails();
  await db.db.prepare('DELETE FROM business_audit_events WHERE id IN (SELECT id FROM business_audit_events WHERE expires_at<=? LIMIT 100)').run(stamp());
  await db.db.prepare('DELETE FROM mcp_request_leases WHERE id IN (SELECT id FROM mcp_request_leases WHERE expires_at<=? LIMIT 100)').run(stamp());
}
async function downloadExport(ctx,id,actor) {
  const {op}=await accessOperation(ctx.db,actor,id);
  if(op.status!=='succeeded')fail('BUSY','导出未成功完成');
  const artifact=await ctx.db.mcpGetExportArtifact(id);
  if(!artifact||artifact.expires_at<stamp())fail('OPERATION_EXPIRED','导出文件已过期');
  const chunks=await ctx.db.mcpExportChunks(artifact.id);
  const bytes=Buffer.concat(chunks.filter(c=>c.payload?.length).map(c=>Buffer.from(c.payload)));
  if(bytes.length!==artifact.bytes || createHash('sha256').update(bytes).digest('hex')!==artifact.checksum)fail('DATA_UNAVAILABLE','导出校验失败，请重新生成');
  return {artifact,bytes};
}
module.exports={createOperationTools,advanceOperation,runOperationScheduler,runOperationMaintenance,downloadExport,syncSchema,titleSchema,keySchema,fileFor};
