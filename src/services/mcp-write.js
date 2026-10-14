// MCP 写入与可选预览共用业务计划。协议参数不能绕过字段、名单或版本校验。
const { z } = require('zod');
const { fail, assertProject, assertAdmin, validateDate, validateMonth, businessDate } = require('./mcp-common');
const createQueries = require('../db/queries/mcp-write');
const { normalizeArticleUrl, projectDomainOf, parseImportText, previewImport } = require('../lib/article-import');
const { normalizeDomain } = require('../lib/domain');
const { normalizeTags } = require('../db/helpers');
const { parseKeyEventNames } = require('../google/project-config');
const { createHash } = require('node:crypto');
const { canonicalJson } = require('./mcp-common');

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = (max) => z.string().trim().max(max);
const nullableDate = text(10).nullable().refine((v) => v === null || validDate(v), '必须是有效的 YYYY-MM-DD 日期');
const key = z.string().min(16).max(128);
const revision = z.number().int().positive();
const mutation = { idempotency_key: key, expected_revision: revision };
const title = (max) => text(max).min(1);
const taskFields = { project_id: id.nullable().optional(), title: title(300), description: text(10000).optional(), status: z.enum(['todo','done']).optional(), priority: z.enum(['high','medium','low']).optional(), due_date: nullableDate.optional() };
const tags = z.array(text(40).refine((s) => !/[,\u0000-\u001f\u007f]/.test(s), '标签不能包含逗号或控制字符')).max(20);
const linkFields = { project_id: id.nullable().optional(), title: title(300), url: title(2048), tags: tags.optional(), notes: text(10000).optional() };
const projectFields = { name: title(200), website: text(2048).transform(v=>v&&!/^https?:\/\//i.test(v)?'https://'+v:v).refine(v=>!v||Boolean(externalUrl(v)),'项目域名或网址无效').optional(), status: z.enum(['active','paused','ended']).optional(), notes: text(10000).optional() };
const articleFields = { project_id: id, article_type: z.enum(['internal','external']), url: title(2048), title: text(1000).optional(), published_at: nullableDate.optional(), copywriter_user_id: id.nullable().optional(), notes: text(10000).optional(), keyword: text(1000).optional(), anchor_text: text(1000).optional() };
const articleRef = { project_id: id, article_type: z.enum(['internal','external']), article_id: id };
const items = z.array(z.object({ article_id: id, expected_revision: revision }).strict()).min(1).max(100).refine((a) => new Set(a.map((r) => r.article_id)).size === a.length, '文章 ID 不能重复');
const patch = (fields) => z.object(fields).partial().strict().refine((v) => Object.keys(v).length > 0, 'patch 至少包含一个字段');
const importRow = z.object({ row_key: title(64), url: title(2048), title: text(1000).optional(), keyword: text(1000).optional(), anchor_text: text(1000).optional(), published_at: nullableDate.optional(), copywriter_user_id: id.nullable().optional(), notes: text(10000).optional() }).strict();
const importInput = z.discriminatedUnion('format', [z.object({ format: z.literal('json'), rows: z.array(importRow).min(1).max(100) }).strict(), z.object({ format: z.enum(['csv','tsv']), text: z.string().min(1) }).strict()]);
const importPolicy = z.object({ conflicts: z.enum(['skip','overwrite_provided']).default('skip'), restore_inactive: z.boolean().default(false) }).strict().default({ conflicts: 'skip', restore_inactive: false });
const importFields = { project_id: id, article_type: z.enum(['internal','external']), input: importInput, policy: importPolicy };
const configFields = { gsc_account_id: id.nullable().optional(), gsc_site: text(2048).nullable().optional(), ga4_account_id: id.nullable().optional(), ga4_property_id: text(200).nullable().optional(), key_event_names: z.array(title(120).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), '事件名不能包含控制字符')).max(50).optional() };
function validDate(v) { return validateDate(v); }
function validMonth(v) { return validateMonth(v); }
function guard(sql, args, code='CONFLICT', message='提交前数据发生变化，请重新读取后重试') { return { sql, args, code, message }; }
function issue(reason, message, code='VALIDATION_ERROR') { fail(code, message, { reason }); }
function projectDomain(p) { return projectDomainOf(p.website) || projectDomainOf(p.gsc_site); }
function hash(input) { return createHash('sha256').update(canonicalJson(input)).digest('hex'); }
function externalUrl(raw) { try { const u = new URL(raw); if (!['http:','https:'].includes(u.protocol) || u.username || u.password || !u.hostname) return null; return String(raw).trim(); } catch { return null; } }
function comparable(a,b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
function meaningful(record,data) { return Object.fromEntries(Object.entries(data).filter(([k,v]) => !comparable(record[k], v))); }

function manualDomain(value) { const raw=String(value||'').trim();if(!raw||raw.length>253||/[\s/@?#]/.test(raw))return null;const domain=normalizeDomain('https://'+raw);return domain&&/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(domain)?domain:null; }
function createWriteTools(ctx) {
  const { db } = ctx;
  const backend = db.db;
  const q = createQueries(backend);
  const descriptors = [];
  function register(toolId, name, label, phase, effect, schema, plan) {
    descriptors.push({ id: toolId, name, title: label, description: label + '；普通业务操作直接执行，幂等键与版本由客户端维护。', phase, effect, inputSchema: schema,
      handler: async (input, actor) => {
        const out = await ctx.mutate({ tool: name, input, actor, prepare: () => plan(input,actor) });
        const data = out?.data ?? out;
        const batch = ['assign_articles','set_article_status','import_articles','delete_articles'].includes(name);
        if (!batch && data.results?.length === 1) return { data: { ...data.results[0], operation_id: data.operation_id } };
        const totals = {};
        for (const field of ['freeze_count','metrics_invalidated_count','deleted_monthly_count','deleted_history_count']) totals[field] = (data.results || []).reduce((n,r) => n + (r[field] || 0),0);
        totals.cleaned_platforms = [...new Set((data.results || []).flatMap((r) => r.cleaned_platforms || []))];
        return { data: { ...data, ...totals, changed_count: data.results?.filter((r) => r.changed).length || 0, noop_count: data.results?.filter((r) => !r.changed).length || 0 } };
      },
      preview: async (input,actor) => {
        const built = await plan(input,actor);
        return { generated_at: new Date().toISOString(), input_hash: hash(input), affected_count: built.units.length,
          changes: built.units.map((u) => ({ key:u.key, ...u.result })), warnings: [], estimated_cost: { statements: built.units.reduce((n,u) => n+u.statements.length+u.guards.length,0) }, input_revisions: built.units.flatMap((u) => u.inputRevisions || []) };
      },
    });
  }
  async function project(actor,pid) { return assertProject(db, actor, pid); }
  async function record(type, recordId, actor, pid=null) {
    const r = await q.mcpWriteRow(type,recordId);
    if (!r || (pid !== null && Number(r.project_id) !== pid)) fail('NOT_FOUND','记录不存在');
    if (r.project_id) { if (pid === null) await project(actor,r.project_id); }
    else if (type !== 'project' && actor.current_role !== 'admin' && Number(r.owner_user_id)!==actor.user_id) fail('FORBIDDEN','无权访问此个人记录');
    return r;
  }
  function personalGuard(r, actor) { return !r.project_id ? [guard('SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL AND (role=\'admin\' OR id=?)) AS ok',[actor.user_id,r.owner_user_id],'FORBIDDEN','无权访问此个人记录')] : []; }
  function adminGuard(actor) { return guard("SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL AND role='admin') AS ok",[actor.user_id],'FORBIDDEN','此工具仅管理员可调用'); }
  async function roster(actor,pid,userId) {
    if (userId == null) return { copywriter_id:null, guards:[] };
    const r = await db.findProjectCopywriterByUser(pid,userId);
    if (!r || r.revoked_at) issue('TARGET_NOT_ON_ROSTER','目标文案师不在当前项目名单');
    return { copywriter_id:r.id, guards:[guard('SELECT EXISTS(SELECT 1 FROM project_copywriters WHERE id=? AND project_id=? AND user_id=? AND revoked_at IS NULL) AS ok',[r.id,pid,userId],'FORBIDDEN','目标文案师已移出名单')] };
  }
  function noop(type,r,keyValue=String(r.id),extra={}) { return { key:keyValue,guards:[q.mcpWriteRevisionGuard(type,r.id,r.revision)],statements:[],result:{ changed:false,item:null,id:r.id,revision:r.revision,before_revision:r.revision,after_revision:r.revision,effects:[],...extra },resultSql:q.mcpWriteResultSql(type,'a.id=?',[r.id],{changed:false,before_revision:r.revision,after_revision:r.revision,effects:[],...extra}) }; }
  function version(r,expected) { if (r.revision !== expected) fail('CONFLICT','记录版本已变化',{current_revision:r.revision}); }
  function configGuard(p) { return guard('SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND config_revision=?) AS ok',[p.id,p.config_revision]); }
  async function baseArticle(i,actor) { const p=await project(actor,i.project_id); const a=await record(i.article_type,i.article_id,actor,i.project_id); version(a,i.expected_revision); return {p,a}; }
  async function selected(i,actor) {
    const p=await project(actor,i.project_id);
    const table=i.article_type==='internal'?'project_articles':'project_external_articles';
    const rows=await backend.prepare(`SELECT * FROM ${table} WHERE project_id=? AND id IN (SELECT value FROM json_each(?))`).all(i.project_id,JSON.stringify(i.items.map((r)=>r.article_id)));
    const byId=new Map(rows.map((r)=>[r.id,r]));
    if(i.items.some((r)=>!byId.has(r.article_id)))fail('NOT_FOUND','部分文章不存在或不属于本项目');
    return {p,rows:i.items.map((r)=>({...byId.get(r.article_id),expected_revision:r.expected_revision}))};
  }

  for (const [type,createId,updateId,createName,updateName,fields] of [['task','T22','T23','create_task','update_task',taskFields],['link','T24','T25','create_link','update_link',linkFields]]) {
    register(createId,createName,type==='task'?'创建任务':'创建链接',2,'W',z.object({...fields,idempotency_key:key}).strict(),async(i,actor)=>{
      if(i.project_id) await project(actor,i.project_id);
      const data = type==='task' ? {project_id:i.project_id??null,title:i.title,description:i.description??'',status:i.status??'todo',priority:i.priority??'medium',due_date:i.due_date??null,owner_user_id:actor.user_id} : {project_id:i.project_id??null,title:i.title,url:i.url,tags:i.tags??[],notes:i.notes??'',owner_user_id:actor.user_id};
      return {projectIds:i.project_id?[i.project_id]:[],units:[q.mcpWriteUnit(type,null,data,{insert:true})]};
    });
    const idField=type+'_id';
    register(updateId,updateName,type==='task'?'修改任务':'修改链接',2,'M',z.object({[idField]:id,patch:patch(fields),...mutation}).strict(),async(i,actor)=>{
      const r=await record(type,i[idField],actor);version(r,i.expected_revision);
      if(i.patch.project_id) await project(actor,i.patch.project_id);
      const normalized={...i.patch};if(type==='link' && 'tags' in normalized) normalized.tags=normalizeTags(normalized.tags);
      const changes=meaningful(r,normalized);const effects=[];if('project_id' in changes)effects.push('moved_project');if('status' in changes)effects.push('status_changed');
      const u=Object.keys(changes).length?q.mcpWriteUnit(type,r,changes,{guards:personalGuard(r,actor),result:{effects}}):noop(type,r);
      u.guards.push(...personalGuard(r,actor));return {projectIds:[...new Set([r.project_id,i.patch.project_id].filter(Boolean))],units:[u]};
    });
  }
  async function createArticlePlan(i,actor) {
    const p=await project(actor,i.project_id);if((i.article_type==='internal'&&i.anchor_text!==undefined)||(i.article_type==='external'&&i.keyword!==undefined))issue('FIELD_NOT_APPLICABLE','文章字段与类型不匹配');
    const url=i.article_type==='internal'?normalizeArticleUrl(i.url,projectDomain(p)):externalUrl(i.url);if(!url)issue('INVALID_ARTICLE_URL','文章 URL 无效或不属于项目域名');
    const table=i.article_type==='internal'?'project_articles':'project_external_articles';const clash=await backend.prepare(`SELECT id FROM ${table} WHERE project_id=? AND url=?`).get(i.project_id,url);if(clash)issue('DUPLICATE_URL','该地址已登记，停用记录也不能重复创建','CONFLICT');
    const assigned=await roster(actor,i.project_id,i.copywriter_user_id);const guards=[configGuard(p),...assigned.guards,guard(`SELECT NOT EXISTS(SELECT 1 FROM ${table} WHERE project_id=? AND url=?) AS ok`,[i.project_id,url],'CONFLICT','地址已被其他请求登记')];
    if(i.article_type==='internal')guards.push(guard("SELECT COUNT(*)<1000 AS ok FROM project_articles WHERE project_id=? AND status='active'",[i.project_id],'VALIDATION_ERROR','CAPACITY_EXCEEDED：每项目最多启用 1000 篇站内文章'));
    const data={url,title:i.title??'',published_at:i.published_at??null,notes:i.notes??'',copywriter_id:assigned.copywriter_id,...(i.article_type==='internal'?{keyword:i.keyword??''}:{anchor_text:i.anchor_text??'',domain:normalizeDomain(url),domain_source:'auto'})};
    return {projectIds:[i.project_id],units:[q.mcpArticleCreateUnit(i.article_type,i.project_id,data,guards)]};
  }
  register('T26','create_article','登记文章',2,'W',z.object({...articleFields,idempotency_key:key}).strict(),createArticlePlan);
  register('T27','update_article','修改文章元数据',2,'M',z.object({...articleRef,patch:patch({title:text(1000),keyword:text(1000),anchor_text:text(1000),notes:text(10000),published_at:nullableDate}),...mutation}).strict(),async(i,actor)=>{
    const {a}=await baseArticle(i,actor);if((i.article_type==='internal'&&'anchor_text'in i.patch)||(i.article_type==='external'&&'keyword'in i.patch))issue('FIELD_NOT_APPLICABLE','文章字段与类型不匹配');
    const normalizedPatch={...i.patch};if(i.article_type==='external')for(const f of ['title','anchor_text','notes'])if(normalizedPatch[f]==='')normalizedPatch[f]=null;
    const changes=meaningful(a,normalizedPatch);if('title'in i.patch&&(Object.keys(changes).length||a.title_source!=='manual'))Object.assign(changes,{title:normalizedPatch.title,title_source:'manual',title_fetch_status:null,title_fetch_error:null});
    return {projectIds:[i.project_id],units:[Object.keys(changes).length?q.mcpWriteUnit(i.article_type,a,changes):noop(i.article_type,a)]};
  });
  register('T28','assign_articles','指派文章文案师',2,'M',z.object({project_id:id,article_type:z.enum(['internal','external']),items,copywriter_user_id:id.nullable(),mode:z.enum(['all_selected','only_unassigned']).default('all_selected'),idempotency_key:key}).strict(),async(i,actor)=>{
    const {rows}=await selected(i,actor);const assigned=await roster(actor,i.project_id,i.copywriter_user_id);
    const units=rows.map((a)=>{version(a,a.expected_revision);return ((i.mode==='only_unassigned'&&a.copywriter_id!==null)||a.copywriter_id===assigned.copywriter_id)?noop(i.article_type,a):q.mcpWriteUnit(i.article_type,a,{copywriter_id:assigned.copywriter_id},{guards:assigned.guards,result:{effects:['copywriter_assigned']}});});return {projectIds:[i.project_id],units};
  });

  register('T42','create_project','创建项目',3,'W',z.object({...projectFields,idempotency_key:key}).strict(),async(i,actor)=>{assertAdmin(actor);const data={name:i.name,website:i.website??'',status:i.status??'active',notes:i.notes??'',owner_user_id:actor.user_id};return {projectIds:[],units:[q.mcpWriteUnit('project',null,data,{insert:true,guards:[adminGuard(actor)]})]};});
  register('T43','update_project','修改项目资料',3,'M',z.object({project_id:id,patch:patch(projectFields),...mutation}).strict(),async(i,actor)=>{assertAdmin(actor);const p=await project(actor,i.project_id);version(p,i.expected_revision);const changes=meaningful(p,i.patch);const u=Object.keys(changes).length?q.mcpWriteUnit('project',p,changes,{guards:[adminGuard(actor)],result:{effects:'website'in changes?['article_url_validation_domain_changed']:[]}}):noop('project',p);u.guards.push(adminGuard(actor));return {projectIds:[i.project_id],units:[u]};});

  for (const [toolId,type,name,label] of [['T47','task','delete_task','删除任务'],['T48','link','delete_link','删除链接']]) register(toolId,name,label,3,'M',z.object({[type+'_id']:id,...mutation}).strict(),async(i,actor)=>{const r=await record(type,i[type+'_id'],actor);version(r,i.expected_revision);return {projectIds:r.project_id?[r.project_id]:[],units:[q.mcpWriteUnit(type,r,{}, {remove:true,guards:personalGuard(r,actor),result:{['deleted_'+type+'_id']:r.id,effects:['deleted']}})]};});

  async function statusUnit(type,a,status,p) {
    if(a.status===status)return noop(type,a);
    if(type==='internal') {
      const guards=status==='active'?[guard("SELECT COUNT(*)<1000 AS ok FROM project_articles WHERE project_id=? AND status='active'",[a.project_id],'VALIDATION_ERROR','CAPACITY_EXCEEDED：每项目最多启用 1000 篇站内文章')]:[];
      return q.mcpWriteUnit(type,a,{status,fetch_revision:a.fetch_revision+1,metrics_dirty:1},{guards,result:{effects:['status_changed','metrics_invalidated'],metrics_invalidated_count:1,freeze_count:0}});
    }
    if(status==='active')return q.mcpWriteUnit(type,a,{status,active_segment_started_at:businessDate(),segment_revision:a.segment_revision+1,metrics_dirty:1},{guards:[configGuard(p)],result:{effects:['status_changed','segment_opened','metrics_invalidated'],freeze_count:0,metrics_invalidated_count:1}});
    const built=await db.buildDisableUnit(a.id,{today:businessDate()});if(!built.ok)issue('FREEZE_UNAVAILABLE',built.reason);
    const effects=['status_changed',...(built.meta.unknownRange?[]:['segment_frozen'])];
    const freezeCount=built.meta.unknownRange?0:1;
    return {key:String(a.id),guards:[q.mcpWriteRevisionGuard(type,a.id,a.revision),configGuard(p),guard('SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND data_revision=?) AS ok',[p.id,p.data_revision])],statements:built.statements,
      result:{changed:true,id:a.id,effects,freeze_count:freezeCount,metrics_invalidated_count:0},resultSql:q.mcpWriteResultSql(type,'a.id=?',[a.id],{changed:true,before_revision:a.revision,effects,freeze_count:freezeCount,metrics_invalidated_count:0})};
  }
  register('T39','set_article_status','启用或停用文章',3,'M',z.object({project_id:id,article_type:z.enum(['internal','external']),items,status:z.enum(['active','inactive']),idempotency_key:key}).strict(),async(i,actor)=>{
    const {p,rows}=await selected(i,actor);const units=[];for(const a of rows){version(a,a.expected_revision);units.push(await statusUnit(i.article_type,a,i.status,p));}return {projectIds:[i.project_id],units};
  });

  async function domainUnit(a,p,newDomain,domainSource,newUrl=null) {
    if (newUrl !== null) {
      const built = await db.buildExternalUrlChangeUnit(a.id,newUrl,new Date().toISOString(),{today:businessDate()});
      if (!built.ok) issue('INVALID_ARTICLE_URL',built.reason);
      const result = {changed:built.changed,before_revision:a.revision,previous_domain:a.domain,new_domain:newDomain,frozen_segments:built.frozenSegments||0,opened_segment:Boolean(built.platformChanged),platform_changed:Boolean(built.platformChanged),metrics_invalidated:Boolean(built.platformChanged),effects:['url_changed',...(built.platformChanged?['platform_changed','metrics_invalidated']:[]),...(built.frozenSegments?['segment_frozen']:[])]};
      return {key:String(a.id),guards:[q.mcpWriteRevisionGuard('external',a.id,a.revision),configGuard(p),...(built.platformChanged?[guard('SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND data_revision=?) AS ok',[p.id,p.data_revision])]:[])],statements:built.statements||[],result,resultSql:q.mcpWriteResultSql('external','a.id=?',[a.id],result)};
    }
    if(a.domain===newDomain) {
      const patchData={};if(a.domain_source!==domainSource)patchData.domain_source=domainSource;
      if(!Object.keys(patchData).length)return noop('external',a,String(a.id),{previous_domain:a.domain,new_domain:newDomain,frozen_segments:0,opened_segment:false});
      return q.mcpWriteUnit('external',a,patchData,{guards:[configGuard(p)],result:{previous_domain:a.domain,new_domain:newDomain,frozen_segments:0,opened_segment:false,effects:['domain_mode_changed'],platform_changed:false,metrics_invalidated:false}});
    }
    const built=await db.buildExternalDomainChangeUnit(a.id,newDomain,{today:businessDate(),domainSource});if(!built.ok)issue('FREEZE_UNAVAILABLE',built.reason);

    const result={changed:true,before_revision:a.revision,previous_domain:a.domain,new_domain:newDomain,frozen_segments:built.frozenSegments,opened_segment:true,platform_changed:true,metrics_invalidated:true,effects:['platform_changed','segment_opened','metrics_invalidated',...(built.frozenSegments?['segment_frozen']:[])]};
    return {key:String(a.id),guards:[q.mcpWriteRevisionGuard('external',a.id,a.revision),configGuard(p),guard('SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND data_revision=?) AS ok',[p.id,p.data_revision])],statements:built.statements,result,resultSql:q.mcpWriteResultSql('external','a.id=?',[a.id],result)};
  }
  register('T40','change_external_domain','更改外链平台域名',3,'M',z.object({project_id:id,article_id:id,domain_mode:z.enum(['auto','manual']),domain:text(253).optional(),...mutation}).strict().refine((i)=>i.domain_mode==='manual'?Boolean(i.domain):i.domain===undefined,'manual 必须提供 domain，auto 禁止 domain'),async(i,actor)=>{
    const {p,a}=await baseArticle({...i,article_type:'external'},actor);const domain=i.domain_mode==='auto'?normalizeDomain(a.url):manualDomain(i.domain);if(!domain)issue('INVALID_DOMAIN','平台域名无效');return {projectIds:[i.project_id],units:[await domainUnit(a,p,domain,i.domain_mode)]};
  });

  register('T38','change_article_url','修改文章地址',3,'M',z.object({...articleRef,new_url:title(2048),...mutation}).strict(),async(i,actor)=>{
    const {p,a}=await baseArticle(i,actor);const url=i.article_type==='internal'?normalizeArticleUrl(i.new_url,projectDomain(p)):externalUrl(i.new_url);if(!url)issue('INVALID_ARTICLE_URL','新 URL 无效或不属于项目域名');if(url===a.url)return {projectIds:[i.project_id],units:[noop(i.article_type,a)]};
    const table=i.article_type==='internal'?'project_articles':'project_external_articles';if(await backend.prepare(`SELECT id FROM ${table} WHERE project_id=? AND url=? AND id<>?`).get(i.project_id,url,a.id))issue('DUPLICATE_URL','地址已被其他文章登记','CONFLICT');
    let unit;
    if(i.article_type==='external')unit=await domainUnit(a,p,a.domain_source==='auto'?normalizeDomain(url):a.domain,a.domain_source,url);
    else {
      const built=await db.buildArticleUrlChangeUnit(a.id,url,new Date().toISOString(),projectDomain(p));if(!built.ok)issue('INVALID_ARTICLE_URL',built.reason);
      const result={changed:true,before_revision:a.revision,effects:['url_changed','history_changed','metrics_invalidated'],affected_articles:[a.id,...built.claimedFrom].map((article_id)=>({project_id:i.project_id,article_type:'internal',article_id})),history_changes:built.historyChanges,platform_changed:false,metrics_invalidated:true};
      unit={key:String(a.id),guards:[q.mcpWriteRevisionGuard('internal',a.id,a.revision),configGuard(p),...built.relatedRevisions.map((r)=>q.mcpWriteRevisionGuard('internal',r.article_id,r.revision))],statements:built.statements,result,resultSql:q.mcpWriteResultSql('internal','a.id=?',[a.id],result)};
    }
    unit.guards.push(guard(`SELECT NOT EXISTS(SELECT 1 FROM ${table} WHERE project_id=? AND url=? AND id<>?) AS ok`,[i.project_id,url,a.id]));return {projectIds:[i.project_id],units:[unit]};
  });
  register('T49','delete_articles','删除文章及关联数据',3,'M',z.object({project_id:id,article_type:z.enum(['internal','external']),items,idempotency_key:key}).strict(),async(i,actor)=>{
    const {rows}=await selected(i,actor);const units=[];
    for(const a of rows){version(a,a.expected_revision);let statements;let stats;
      if(i.article_type==='internal'){
        const counts=await backend.prepare('SELECT (SELECT COUNT(*) FROM project_article_monthly_metrics WHERE article_id=?) AS monthly,(SELECT COUNT(*) FROM project_article_url_history WHERE article_id=?) AS history').get(a.id,a.id);
        statements=['project_article_monthly_metrics','project_article_url_history'].map((table)=>backend.prepare(`DELETE FROM ${table} WHERE article_id=?`).bind(a.id));statements.push(backend.prepare('DELETE FROM project_articles WHERE id=?').bind(a.id));stats={deleted_monthly_count:counts.monthly,deleted_history_count:counts.history,cleaned_platforms:[]};
      }else{
        statements=[backend.prepare('DELETE FROM project_external_article_freezes WHERE article_id=?').bind(a.id),backend.prepare('DELETE FROM project_external_articles WHERE id=?').bind(a.id),...['project_external_daily_metrics','project_external_month_state'].map((table)=>backend.prepare(`DELETE FROM ${table} WHERE project_id=? AND domain=? AND NOT EXISTS(SELECT 1 FROM project_external_articles WHERE project_id=? AND domain=?)`).bind(i.project_id,a.domain,i.project_id,a.domain))];stats={deleted_monthly_count:0,deleted_history_count:0,cleaned_platforms:[]};
      }
      const result={changed:true,item:null,id:a.id,revision:null,before_revision:a.revision,after_revision:null,effects:['deleted'],...stats};const u={key:String(a.id),guards:[q.mcpWriteRevisionGuard(i.article_type,a.id,a.revision)],statements,result};
      if(i.article_type==='external')u.resultSql={sql:`SELECT json_patch(?,json_object('cleaned_platforms',json(CASE WHEN EXISTS(SELECT 1 FROM project_external_articles WHERE project_id=? AND domain=?) THEN '[]' ELSE json_array(?) END))) AS result_json`,args:[JSON.stringify(result),i.project_id,a.domain,a.domain]};
      units.push(u);
    }
    return {projectIds:[i.project_id],units};
  });
  register('T51','reorder_articles','调整站内文章顺序',3,'M',z.object({project_id:id,article_type:z.literal('internal'),article_ids:z.array(id).min(1).max(100).refine((a)=>new Set(a).size===a.length,'文章 ID 不能重复'),expected_order_revision:revision,idempotency_key:key}).strict(),async(i,actor)=>{
    const p=await project(actor,i.project_id);if(p.order_revision!==i.expected_order_revision)fail('CONFLICT','文章顺序版本已变化',{current_order_revision:p.order_revision});
    const selectedRows=await backend.prepare('SELECT * FROM project_articles WHERE project_id=? AND id IN (SELECT value FROM json_each(?))').all(i.project_id,JSON.stringify(i.article_ids));
    if(selectedRows.length!==i.article_ids.length)fail('NOT_FOUND','部分文章不存在或不属于本项目');
    const min=Math.min(...selectedRows.map((a)=>a.sort_order??a.id));const max=Math.max(...selectedRows.map((a)=>a.sort_order??a.id));const segment=await backend.prepare('SELECT id,COALESCE(sort_order,id) AS position FROM project_articles WHERE project_id=? AND COALESCE(sort_order,id)>=? AND COALESCE(sort_order,id)<=? ORDER BY position,id LIMIT 101').all(i.project_id,min,max);
    if(segment.length!==i.article_ids.length||segment.some((a)=>!i.article_ids.includes(a.id)))issue('RANGE_TOO_LARGE','请提供完整的连续顺序段，最多 100 篇文章');
    let positions=segment.map((a)=>a.position);const unchanged=segment.every((a,index)=>a.id===i.article_ids[index]);
    if(!unchanged && new Set(positions).size!==positions.length) {
      const bounds=await backend.prepare(`SELECT
        (SELECT MAX(COALESCE(sort_order,id)) FROM project_articles WHERE project_id=? AND COALESCE(sort_order,id)<?) AS low,
        (SELECT MIN(COALESCE(sort_order,id)) FROM project_articles WHERE project_id=? AND COALESCE(sort_order,id)>?) AS high`).get(i.project_id,min,i.project_id,max);
      const low=bounds.low??min-1;const high=bounds.high??max+1;
      // 历史并列位置用相邻段之间的数值消除并列，不改动段外文章的顺序或版本。
      positions=positions.map((_,index)=>low+(high-low)*(index+1)/(positions.length+1));
      if(new Set(positions).size!==positions.length || positions.some(p=>!Number.isFinite(p)||p<=low||p>=high))issue('RANGE_TOO_LARGE','顺序段之间的空间不足，请选择更完整的连续段');
    }
    const ordering=JSON.stringify(i.article_ids.map((aid,index)=>({id:aid,position:positions[index]})));
    const statements=unchanged?[]:[backend.prepare(`UPDATE project_articles SET sort_order=(SELECT json_extract(j.value,'$.position')
      FROM json_each(@ordering) j WHERE json_extract(j.value,'$.id')=project_articles.id),updated_at=@at
      WHERE project_id=@pid AND id IN (SELECT json_extract(value,'$.id') FROM json_each(@ordering))`)
      .bind({ordering,at:new Date().toISOString(),pid:i.project_id})];
    return {projectIds:[i.project_id],units:[{key:'order',guards:[guard('SELECT order_revision=? AS ok FROM projects WHERE id=?',[i.expected_order_revision,i.project_id])],statements,result:{changed:!unchanged,item:null,before_revision:p.revision,after_revision:p.revision,effects:unchanged?[]:['order_changed'],ordered_ids:i.article_ids},resultSql:{sql:'SELECT json_patch(?,json_object(\'order_revision\',order_revision,\'after_revision\',revision)) AS result_json FROM projects WHERE id=?',args:[JSON.stringify({changed:!unchanged,item:null,before_revision:p.revision,effects:unchanged?[]:['order_changed'],ordered_ids:i.article_ids}),i.project_id]}}]};
  });
  register('T41','update_project_configuration','保存项目监控配置',3,'M',z.object({project_id:id,patch:patch(configFields),expected_config_revision:revision,...mutation}).strict(),async(i,actor)=>{
    assertAdmin(actor);const p=await project(actor,i.project_id);version(p,i.expected_revision);if(p.config_revision!==i.expected_config_revision)fail('CONFLICT','项目配置版本已变化',{current_config_revision:p.config_revision});
    const {buildProjectConfiguration}=require('./project-configuration');const built=await buildProjectConfiguration(db,p,i.patch,actor);const result={changed:built.changed,item:null,before_revision:p.revision,after_revision:p.revision,effects:built.changed?['configuration_changed','metrics_invalidated']:[],invalidated_internal_count:built.internalCount,invalidated_external_count:built.externalCount,requires_sync:built.changed,changed_sources:built.changedSources};
    const accountGuards=[];for(const field of ['gsc_account_id','ga4_account_id'])if(i.patch[field])accountGuards.push(guard('SELECT EXISTS(SELECT 1 FROM google_accounts WHERE id=?) AS ok',[i.patch[field]],'FORBIDDEN','Google 账号已被移除'));
    return {projectIds:[i.project_id],units:[{key:String(i.project_id),guards:[adminGuard(actor),q.mcpWriteRevisionGuard('project',p.id,p.revision),configGuard(p),...accountGuards],statements:built.statements,result,resultSql:{sql:'SELECT json_patch(?,json_object(\'config_revision\',config_revision,\'after_revision\',revision)) AS result_json FROM projects WHERE id=?',args:[JSON.stringify(result),p.id]}}]};
  });

  async function normalizeImport(i,actor) {
    const p=await project(actor,i.project_id);if(Buffer.byteLength(JSON.stringify(i.input))>256*1024)issue('INPUT_TOO_LARGE','导入内容不能超过 256 KiB');
    let sourceRows,parsed;
    if(i.input.format==='json'){
      sourceRows=i.input.rows;if(new Set(sourceRows.map((r)=>r.row_key)).size!==sourceRows.length)issue('DUPLICATE_ROW_KEY','row_key 不能重复');
      if(sourceRows.some((r)=>(i.article_type==='internal'&&r.anchor_text!==undefined)||(i.article_type==='external'&&r.keyword!==undefined)))issue('FIELD_NOT_APPLICABLE','导入字段与文章类型不匹配');
    }else{
      parsed=parseImportText(i.input.text,{domain:i.article_type==='external'});if(parsed.truncated||parsed.rows.length>100)issue('RANGE_TOO_LARGE','单次最多导入 100 行');if(!parsed.rows.length)issue('NO_ROWS','没有可导入的内容');
      if(parsed.columns.includes('domain'))issue('FIELD_NOT_SUPPORTED','MCP 导入不接受平台域名列，请用 change_external_domain 修改平台');
    }
    const userIds=sourceRows?[...new Set(sourceRows.map((r)=>r.copywriter_user_id).filter(Boolean))]:[];
    const emails=parsed?[...new Set(parsed.rows.map((r)=>{const index=parsed.columns.indexOf('copywriter');return index<0?'':String(r.cells[index]||'').toLowerCase().trim();}).filter(Boolean))]:[];
    const rosterRows=[];for(const values of [userIds,emails]){if(!values.length)continue;for(let start=0;start<values.length;start+=98){const group=values.slice(start,start+98);const field=values===userIds?'u.id':'lower(u.email)';rosterRows.push(...await backend.prepare(`SELECT c.id,c.user_id,u.email FROM project_copywriters c JOIN users u ON u.id=c.user_id WHERE c.project_id=? AND c.revoked_at IS NULL AND ${field} IN (${group.map(()=>'?').join(',')})`).all(i.project_id,...group));}}
    const byUser=new Map(rosterRows.map((r)=>[r.user_id,r]));const byEmail=new Map(rosterRows.map((r)=>[r.email.toLowerCase(),{id:r.user_id}]));
    if(sourceRows){const columns=['url','title','keyword','notes','published_at','copywriter'];parsed={hasHeader:true,columns,rows:sourceRows.map((r,index)=>({lineNo:index+1,cells:[r.url,r.title??'',r.keyword??'',r.notes??'',r.published_at??'',r.copywriter_user_id?(byUser.get(r.copywriter_user_id)?.email||'__not_on_roster__'):'']})),truncated:false};}
    const preview=previewImport(parsed,{projectDomain:projectDomain(p),external:i.article_type==='external',today:businessDate(),userByEmail:byEmail,rosterByUser:new Map(rosterRows.map((r)=>[r.user_id,r.id]))});
    const urls=[...new Set(preview.items.filter((r)=>r.url).map((r)=>r.url))];const existingRows=[];const table=i.article_type==='internal'?'project_articles':'project_external_articles';for(let start=0;start<urls.length;start+=98){const values=urls.slice(start,start+98);existingRows.push(...await backend.prepare(`SELECT * FROM ${table} WHERE project_id=? AND url IN (${values.map(()=>'?').join(',')})`).all(i.project_id,...values));}
    const existingMap=new Map(existingRows.map((r)=>[r.url,r]));
    const final=previewImport(parsed,{projectDomain:projectDomain(p),external:i.article_type==='external',today:businessDate(),existingByUrl:existingMap,userByEmail:byEmail,rosterByUser:new Map(rosterRows.map((r)=>[r.user_id,r.id]))});
    const rows=final.items.map((r,index)=>{
      const original=sourceRows?.[index];let fields=original?Object.fromEntries(Object.entries(original).filter(([f])=>!['row_key','url','copywriter_user_id'].includes(f))):{...r.fields};
      if(!original)for(const f of Object.keys(fields))if(!parsed.columns.includes(f))delete fields[f];
      if(i.article_type==='external'){delete fields.keyword;if(original?.anchor_text!==undefined)fields.anchor_text=original.anchor_text;}
      let action=r.action==='restored'?'restore':r.action;const target=existingMap.get(r.url);
      if(r.copywriterIssue)action='invalid';if(i.article_type==='external'&&!externalUrl(r.url))action='invalid';
      if(action!=='invalid'&&target&&((target.status==='inactive'&&!i.policy.restore_inactive)||(target.status!=='inactive'&&i.policy.conflicts==='skip')))action='duplicate';
      if(action!=='invalid'&&r.action==='restored'&&target?.status==='inactive'&&i.policy.restore_inactive)action='restore';
      const cwUser=original && 'copywriter_user_id' in original ? original.copywriter_user_id : r.copywriter?.user_id;if(cwUser&&!byUser.has(cwUser))action='invalid';
      return {row_key:original?.row_key||String(r.lineNo),action,fields:{url:r.url,...fields,...(cwUser!==undefined?{copywriter_user_id:cwUser}:{})},existing_ref:target?{project_id:i.project_id,article_type:i.article_type,article_id:target.id}:null,expected_revision:target?.revision??null,conflicts:action==='invalid'?[r.copywriterIssue||r.reason||'URL 或人员无效']:[],target};
    });
    const counts={new:0,update:0,restore:0,duplicate:0,invalid:0};for(const r of rows)counts[r.action]++;
    if(i.article_type==='internal'){const active=await db.countActiveArticles(i.project_id);if(active+counts.new+counts.restore>1000)issue('CAPACITY_EXCEEDED','导入后启用文章将超过 1000 篇');}
    const normalizedHash=hash({project_id:i.project_id,article_type:i.article_type,rows:rows.map(({target,...r})=>r),policy:i.policy});return {p,rows,counts,normalizedHash,byUser};
  }
  const previewImportDescriptor={id:'T29',name:'preview_article_import',title:'预览文章导入',description:'可选的只读预检，返回规范化和冲突；不签发审批凭证。',phase:2,effect:'P',inputSchema:z.object(importFields).strict(),handler:async(i,actor)=>{
    const p=await normalizeImport(i,actor);return {data:{generated_at:new Date().toISOString(),input_hash:p.normalizedHash,affected_count:p.rows.length,normalized_rows:p.rows.map(({target,...r})=>r),counts:p.counts,changes:[],warnings:[],estimated_cost:{rows:p.rows.length},input_revisions:p.rows.filter((r)=>r.target).map((r)=>({ref:r.existing_ref,revision:r.expected_revision}))}};
  }};descriptors.push(previewImportDescriptor);
  register('T30','import_articles','导入文章',2,'M',z.object({...importFields,idempotency_key:key,expected_revisions:z.array(z.object({article_id:id,revision}).strict()).max(100).optional()}).strict(),async(i,actor)=>{
    const normalized=await normalizeImport(i,actor);if(normalized.counts.invalid)issue('INVALID_IMPORT_ROWS','导入存在无效行，整批未写入', 'VALIDATION_ERROR');
    const expected=new Map((i.expected_revisions||[]).map((r)=>[r.article_id,r.revision]));if(expected.size!==(i.expected_revisions||[]).length)issue('DUPLICATE_ARTICLE_ID','expected_revisions 不能重复');const relevant=new Set(normalized.rows.filter((r)=>r.target).map((r)=>r.target.id));if([...expected.keys()].some((aid)=>!relevant.has(aid)))issue('INVALID_ARTICLE_ID','expected_revisions 必须属于本次导入目标');
    const units=[];for(const r of normalized.rows){
      if(r.action==='duplicate'){units.push(r.target?noop(i.article_type,r.target,r.row_key,{effects:['duplicate_skipped']}):{key:r.row_key,guards:[],statements:[],result:{changed:false,id:null,revision:null,effects:['duplicate_skipped']}});continue;}
      const member=r.fields.copywriter_user_id?normalized.byUser.get(r.fields.copywriter_user_id):null;
      const assigned={copywriter_id:member?.id??null,guards:member?[guard('SELECT EXISTS(SELECT 1 FROM project_copywriters WHERE id=? AND project_id=? AND user_id=? AND revoked_at IS NULL) AS ok',[member.id,i.project_id,member.user_id],'FORBIDDEN','目标文案师已移出名单')]:[]};const fields={...r.fields};delete fields.copywriter_user_id;delete fields.url;
      if(r.action==='new'){
        const data={url:r.fields.url,title:fields.title??'',notes:fields.notes??'',published_at:fields.published_at||null,copywriter_id:assigned.copywriter_id,...(i.article_type==='internal'?{keyword:fields.keyword??''}:{anchor_text:fields.anchor_text??'',domain:normalizeDomain(r.fields.url),domain_source:'auto'})};
        const table=i.article_type==='internal'?'project_articles':'project_external_articles';const guards=[configGuard(normalized.p),...assigned.guards,guard(`SELECT NOT EXISTS(SELECT 1 FROM ${table} WHERE project_id=? AND url=?) AS ok`,[i.project_id,data.url])];if(i.article_type==='internal')guards.push(guard("SELECT COUNT(*)<1000 AS ok FROM project_articles WHERE project_id=? AND status='active'",[i.project_id]));const u=q.mcpArticleCreateUnit(i.article_type,i.project_id,data,guards);u.key=r.row_key;units.push(u);continue;
      }
      const a=r.target;version(a,expected.get(a.id)??a.revision);if(i.article_type==='external')for(const field of ['title','anchor_text','notes'])if(fields[field]==='')fields[field]=null;let changes=i.policy.conflicts==='overwrite_provided'?meaningful(a,fields):{};
      if('title'in changes)Object.assign(changes,{title_source:'manual',title_fetch_status:null,title_fetch_error:null});if(r.fields.copywriter_user_id!==undefined&&a.copywriter_id!==assigned.copywriter_id)changes.copywriter_id=assigned.copywriter_id;
      let u;if(r.action==='restore'){u=await statusUnit(i.article_type,a,'active',normalized.p);if(Object.keys(changes).length){const meta=q.mcpWriteUnit(i.article_type,a,changes,{guards:assigned.guards});u.guards.push(...assigned.guards);u.statements.push(...meta.statements);u.result.effects.push('metadata_updated');}u.result.effects.push('restored');u.resultSql=q.mcpWriteResultSql(i.article_type,'a.id=?',[a.id],u.result);}else u=Object.keys(changes).length?q.mcpWriteUnit(i.article_type,a,changes,{guards:assigned.guards,result:{effects:['updated']}}):noop(i.article_type,a);u.key=r.row_key;units.push(u);
    }
    return {projectIds:[i.project_id],units,result:{input_hash:normalized.normalizedHash},checkpoint:{project_id:i.project_id,article_type:i.article_type,policy:i.policy,rows:normalized.rows.map(({target,...r})=>r)}};
  });
  const importer = descriptors.find((t) => t.name === 'import_articles');
  importer.retryInput = async (original, selectedKeys, actor, checkpoint) => {
    if (!checkpoint?.rows) fail('OPERATION_EXPIRED','导入原意图检查点不可用，请重新提交明确未处理项');
    await project(actor,original.project_id);
    const chosen = new Set(selectedKeys.map(String));
    const rows = checkpoint.rows.filter((r) => chosen.has(String(r.row_key)));
    if (rows.length !== chosen.size) issue('UNKNOWN_OPERATION_ITEM','恢复项不属于原导入意图');
    const expected_revisions = [];
    for (const r of rows) {
      const table=original.article_type==='internal'?'project_articles':'project_external_articles';
      const now=await backend.prepare(`SELECT id,url FROM ${table} WHERE project_id=? AND url=?`).get(original.project_id,r.fields.url);
      if (r.action==='new' && now) fail('CONFLICT','原新增地址已被登记，请重新读取后决定处理方式');
      if (r.existing_ref) {
        if (!now || now.id!==r.existing_ref.article_id) fail('CONFLICT','原导入目标已删除或地址变化');
        expected_revisions.push({article_id:r.existing_ref.article_id,revision:r.expected_revision});
      }
    }
    return {project_id:original.project_id,article_type:original.article_type,policy:checkpoint.policy,input:{format:'json',rows:rows.map((r)=>({row_key:r.row_key,...r.fields}))},expected_revisions};
  };
  return descriptors;
}
function validateBusinessFields(type, input, { partial = false } = {}) {
  const fields = type === 'task' ? taskFields : type === 'link' ? linkFields : type === 'project' ? projectFields : null;
  if (!fields) throw new Error('未知业务字段类型');
  const schema = z.object(fields).strict();
  return (partial ? schema.partial() : schema).parse(input);
}
function validateArticleMeta(type,input) {
  const fields={title:text(1000),notes:text(10000),published_at:nullableDate,...(type==='internal'?{keyword:text(1000)}:{anchor_text:text(1000)})};
  return z.object(fields).partial().strict().parse(input);
}
module.exports={createWriteTools,validateBusinessFields,validateArticleMeta,normalizeExternalUrl:externalUrl,normalizePlatformDomain:manualDomain};
