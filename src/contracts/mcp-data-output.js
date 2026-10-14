const { z } = require('zod');
const Id = z.number().int().positive();
const Count = z.number().int().nonnegative();
const Text = z.string();
const NullableText = Text.nullable();
const NumberOrNull = z.number().nullable();
const Revision = Id;
const JsonObject = z.record(z.string(), z.unknown());
const List = schema => z.array(schema);
const Obj = shape => z.object(shape).strict();
const Ref = Obj({project_id:Id,article_type:z.enum(['internal','external']),article_id:Id});
const ProjectSummary = Obj({id:Id,name:Text,website:Text,status:z.enum(['active','paused','ended']),revision:Revision});
const ProjectDetail = ProjectSummary.extend({notes:Text,owner_user_id:Id});
const Member = Obj({membership_id:Id,project_id:Id,user_id:Id,name:NullableText,email:Text,is_active:z.boolean(),article_count:Count,external_article_count:Count,revision:Revision});
const History = Obj({url:Text,changed_at:Text});
const Article = Obj({ref:Ref,url:Text,title:NullableText,title_source:z.enum(['manual','fetched']).nullable(),published_at:NullableText,registered_at:Text,status:z.enum(['active','inactive']),copywriter_user_id:Id.nullable(),membership_id:Id.nullable(),notes:Text,revision:Revision,keyword:Text.optional(),anchor_text:Text.optional(),domain:Text.optional(),url_history:List(History).optional()});
const Task = Obj({id:Id,project_id:Id.nullable(),owner_user_id:Id,title:Text,description:Text,status:z.enum(['todo','done']),priority:z.enum(['high','medium','low']),due_date:NullableText,overdue:z.boolean(),revision:Revision});
const Link = Obj({id:Id,project_id:Id.nullable(),owner_user_id:Id,title:Text,url:Text,tags:List(Text),notes:Text,revision:Revision});
const MetricCell = Obj({key:Text,value:NumberOrNull,status:z.enum(['complete','partial','pending','unconfigured','stale','error']),unit:Text,coverage_unit:z.enum(['article_month','article_current','platform_day']),known_count:Count,expected_count:Count.nullable(),coverage_start:NullableText,coverage_end:NullableText,last_success_at:NullableText,latest_attempt_at:NullableText,latest_attempt_status:NullableText,reason:NullableText});
const Attainment = Obj({status:z.enum(['attained','not-attained','observation','pending','syncing','data-issue','pending-key-events']),label:Text,reasons:List(Text),evidence:List(Text),basis:z.literal('current_cumulative'),evaluated_on:Text,rule_version:Text,numerator:Count.nullable(),denominator:Count.nullable(),ageDays:z.number().optional()});
const Platform = Obj({project_id:Id,domain:Text,matched_article_count:Count,registered_article_count:Count,active_article_count:Count,users_daily_sum:MetricCell,key_events:MetricCell,attribution:z.literal('platform_total'),sync_status:z.enum(['unconfigured','issue','pending','ok'])});
const Coverage = Obj({start:NullableText,end:NullableText,known_count:Count,expected_count:Count.nullable()});
const HealthSource = Obj({project_id:Id,domain:Text.optional(),source:Text,coverage:Coverage,last_success_at:NullableText,latest_attempt_at:NullableText,latest_attempt_status:NullableText});
const HealthIssue = Obj({code:Text,severity:z.enum(['info','warning','error']),project_id:Id,article_ref:Ref.nullable(),domain:NullableText,source:Text,months:List(Text),last_success_at:NullableText,latest_attempt_at:NullableText,impact:Text,suggested_action:Text});
const HealthSummary = Obj({projects_checked:Count,articles_checked:Count,platforms_checked:Count,issue_counts:z.record(Text,Count),analysis_blockers:Count});
const Pagination = Obj({page:Id,page_size:Id,returned_count:Count,total:Count.nullable(),has_more:z.boolean(),total_status:z.literal('not_computed').optional()});
const Freeze = Obj({article_ref:Ref,from:Text,to:Text,share:z.number(),metrics:Obj({users_daily_sum:NumberOrNull,key_events:NumberOrNull}),status:Obj({users:Text,events:Text}),revoked_at:Text});
const ReferenceArticle = Obj({article:Article,window:Obj({from:Text,to:NullableText,fallback:z.boolean()}).nullable(),share:NumberOrNull,active_segment:Obj({from:Text,to:Text}).nullable(),reference_metrics:List(MetricCell),reference_complete:z.boolean(),reference_allocatable:z.boolean(),reason:Text.optional()});
const AnalysisMeta = {requested_period:JsonObject,effective_period:JsonObject,coverage:JsonObject,aggregation_scope:Text};
const TaskSummary = Obj({total:Count,todo:Count,done:Count,overdue:Count});
const MetricRow = Obj({group_key:Text,group_label:Text,article_count:Count,metrics:List(MetricCell),article:Article.optional(),current_attainment:Attainment.optional(),current_attainment_summary:z.record(Text,Count).optional()});
const MetricSummary = Obj({matched_article_count:Count,metrics:List(MetricCell),attainment_rate:Obj({rate:NumberOrNull,numerator:Count,denominator:Count})});
const SourceMetric = MetricCell.extend({project_id:Id,source:Text});
const ExternalSource = Obj({project_id:Id,domain:Text,source:Text,coverage_start:NullableText,coverage_end:NullableText,last_success_at:NullableText,latest_attempt_at:NullableText,latest_attempt_status:NullableText});
const SourceConfig = Obj({account_id:Id.nullable(),configured:z.boolean(),site:NullableText.optional(),property_id:NullableText.optional()});
const Operation = Obj({id:Text,kind:Text,status:z.enum(['queued','running','succeeded','partial','failed','cancel_requested','cancelled']),created_by:Id,project_ids:List(Id),created_at:Text,updated_at:Text,progress:Obj({completed:Count,total:Count.nullable(),unit:Text}),data_through:JsonObject.nullable(),errors:List(JsonObject),result_available:z.boolean(),retry_after_seconds:Count.nullable()});
const Receipt = Obj({receipt_only:z.literal(true),operation_id:Text,status:Text,committed_count:Count,failed_count:Count.optional(),changed:z.boolean().optional(),key:Text.optional(),rollback_performed:z.literal(false).optional(),results:List(JsonObject).optional(),succeeded:List(JsonObject).optional(),failed:List(JsonObject).optional(),unprocessed:List(z.union([Text,JsonObject])).optional(),rejected:List(z.unknown()).optional(),freeze_count:Count.optional(),metrics_invalidated_count:Count.optional(),deleted_monthly_count:Count.optional(),deleted_history_count:Count.optional(),cleaned_platforms:List(Text).optional(),changed_count:Count.optional(),noop_count:Count.optional()});
const Preview = z.object({generated_at:Text,input_hash:Text,affected_count:Count.nullable(),changes:List(JsonObject),warnings:List(JsonObject),estimated_cost:JsonObject,input_revisions:List(JsonObject)}).passthrough();
// 扩展字段因业务动作而异；item 始终使用明确的公开 DTO，不能回传数据库整行。
const PublicItem = z.union([Article,Task,Link,ProjectDetail]);
const WriteEntry = z.object({changed:z.boolean(),item:PublicItem.nullable().optional(),key:Text.optional(),id:Id.nullable().optional(),revision:Revision.nullable().optional(),before_revision:Revision.nullable().optional(),after_revision:Revision.nullable().optional(),effects:List(Text).optional()}).passthrough();
const Write = z.union([
  WriteEntry.extend({operation_id:Text}),
  z.object({operation_id:Text,changed:z.boolean(),results:List(WriteEntry),succeeded:List(WriteEntry),failed:List(JsonObject),unprocessed:List(z.union([Text,JsonObject])),rejected:List(z.unknown())}).passthrough(),
  Receipt,
]);
const schemas = {
  T01:Obj({items:List(ProjectSummary)}),
  T02:Obj({project:ProjectDetail,order_revision:Revision,availability:z.record(Text,Text),counts:Obj({internal_active:Count,internal_inactive:Count,external_active:Count,external_inactive:Count,open_tasks:Count,overdue_tasks:Count,links:Count}).optional(),members:List(Member).optional(),members_count:Count.optional(),members_read_tool:Text.optional(),data_status:Obj({business_start_basis:z.literal('publication_date'),sources:Obj({gsc:SourceConfig,ga4:SourceConfig}),active_operation_ids:List(Text)}).optional()}),
  T03:Obj({items:List(Article)}),
  T04:Obj({article:Article,monthly:List(Obj({month:Text,metrics:List(MetricCell),provisional:z.boolean(),coverage:JsonObject})).optional(),current_metrics:Obj({metrics:List(MetricCell),basis:z.literal('current_cumulative')}).optional(),current_attainment:Attainment.optional(),url_history:List(History).optional(),external_reference:ReferenceArticle.extend({platform:Platform,freeze_segments:List(Freeze),freeze_pagination:Pagination.optional()}).optional()}),
  T05:Obj({rows:List(MetricRow),summary:MetricSummary,current_attainment_basis:z.literal('current_cumulative'),...AnalysisMeta,sources:List(SourceMetric)}),
  T06:Obj({items:List(Platform),summary:Obj({platform_count:Count,matched_project_count:Count,matched_article_count:Count,registered_article_count:Count,users_daily_sum:MetricCell,key_events:MetricCell}),filter_attribution:z.literal('matched_platform_whole_data'),...AnalysisMeta,sources:List(ExternalSource)}),
  T07:Obj({platform:Platform,...AnalysisMeta,sources:List(MetricCell),articles:List(ReferenceArticle).optional(),article_pagination:Pagination.optional(),freeze_segments:List(Freeze).optional(),freeze_pagination:Pagination.optional(),trend:List(Obj({date:Text.optional(),month:Text.optional(),users_daily_sum:MetricCell,key_events:MetricCell,coverage:JsonObject})).optional()}),
  T08:Obj({summary:HealthSummary,issues:List(HealthIssue),sources:List(HealthSource)}),
  T09:Obj({user:Obj({id:Id,name:NullableText,email:Text,role:z.enum(['admin','member'])}),business_date:Text,timezone:z.literal('Asia/Shanghai'),enabled_rounds:List(z.number().int().min(1).max(3)),tool_catalog_version:Text}),
  T10:Obj({items:List(Task),summary:TaskSummary}),T11:Obj({item:Task,project_name:Text.optional()}),
  T12:Obj({items:List(Link),tags:List(Text).optional(),tags_complete:z.boolean().optional(),matched_tag_count:Count.optional()}),T13:Obj({item:Link}),
  T14:Obj({items:List(Member)}),T15:Obj({items:List(Obj({user_id:Id,name:NullableText,email:Text,on_roster:z.boolean()}))}),
  T16:Obj({project_revision:Revision,config_revision:Revision,business_start_basis:z.literal('publication_date'),gsc:SourceConfig,ga4:SourceConfig,key_event_names:List(Text),discovery_required:List(Text),available_accounts:List(Obj({id:Id,email:NullableText,note:NullableText})).optional()}),
  T17:Obj({definitions:List(Obj({key:Text,label:Text,unit:Text,aggregation:Text,unknown_semantics:Text,coverage_requirements:Text})),attainment_rules:Obj({observation_days:Count,thresholds:Obj({gsc_clicks:z.number(),ga4_views:z.number(),key_event_ratio:z.number()}),basis:Text,copywriter_basis:Text,rate_denominator:Text}).optional(),status_definitions:z.record(Text,Text),calculation_version:Text,timezone:z.literal('Asia/Shanghai')}),
  T18:Obj({items:List(Obj({kind:z.enum(['overdue_task','due_soon','missing_date','unassigned','data_issue','unconfigured']),severity:z.enum(['info','warning','error']),project_id:Id.nullable(),entity_ref:JsonObject,title:Text,reason:Text,due_date:NullableText,suggested_tool:Text})),summary:Obj({by_kind:z.record(Text,Count),by_project:z.record(Text,Count),personal_count:Count})}),
  T19:Obj({project:ProjectDetail,period:JsonObject,comparison_period:JsonObject.optional(),sections:List(Obj({name:z.enum(['overview','internal','external','tasks','health']),status:z.enum(['complete','partial','unavailable']),summary:JsonObject.nullable(),top_items:List(JsonObject),coverage:z.unknown(),warnings:List(JsonObject)})),definitions_version:Text}),
  T20:z.union([Obj({operation:Operation,succeeded_count:Count,failed_count:Count,unprocessed_count:Count,legacy_job_id:Text.optional()}),Receipt]),
  T21:z.union([Obj({summary:JsonObject}),Obj({items:List(Obj({key:Text,state:Text,result:JsonObject.nullable(),error:JsonObject.nullable()}))}),Obj({report_rows:List(JsonObject)}),Obj({artifact:Obj({name:Text,mime_type:Text,bytes:Count,expires_at:Text,download_path:Text,auth_required:z.literal(true),checksum:NullableText})}),Receipt]),
  T29:Preview,T31:Preview,T32:Preview,
  T33:z.union([Obj({operation:Operation,reused:z.boolean(),accepted_scope:JsonObject,remaining_scope:List(z.unknown()),poll_after_seconds:Count}),Receipt]),
  T34:z.union([Obj({operation:Operation,changed:z.boolean(),already_committed_count:Count,remaining_count:Count,rollback_performed:z.literal(false),key:Text.optional()}),Receipt]),
  T35:z.union([Obj({operation:Operation,parent_operation_id:Text,reused:z.boolean(),skipped_succeeded_count:Count,changed:z.boolean().optional()}),Receipt]),
  T36:z.union([Obj({operation:Operation,accepted_count:Count,skipped_manual_count:Count,reused:z.boolean()}),Receipt]),
  T37:z.union([Obj({operation:Operation,estimated_rows:Count.nullable(),estimated_bytes:Count.nullable(),result_expiry:NullableText}),Receipt]),
  T52:Obj({items:List(Obj({id:Id,name:NullableText,email:Text,role:z.enum(['admin','member']),revision:Revision}))}),
};
for (const id of ['T22','T23','T24','T25','T26','T27','T28','T30','T38','T39','T40','T41','T42','T43','T47','T48','T49','T51']) schemas[id]=Write;
const forbidden = new Set(['refresh_token','access_token','client_secret','token_hash','password','authorization','lease_id','lease_expires_at','token','refreshtoken','accesstoken','clientsecret','config_fingerprint','gsc_config_fingerprint','ga4_config_fingerprint','input_json','checkpoint_json','project_ids_json','errors_json']);
function forbiddenPath(value,path='data') {
  if (!value || typeof value !== 'object') return null;
  for (const [key,child] of Object.entries(value)) {
    const next=`${path}.${key}`;
    if (forbidden.has(key.toLowerCase())) return next;
    const nested=forbiddenPath(child,next);if(nested)return nested;
  }
  return null;
}
function validateToolData(id,data) {
  const forbiddenField=forbiddenPath(data);
  if (forbiddenField) return {success:false,issues:[{path:forbiddenField,message:'私有字段不属于公开契约'}]};
  const schema=schemas[id];
  if (!schema) return {success:false,issues:[{path:'data',message:'工具没有公开输出契约'}]};
  const parsed=schema.safeParse(data);
  return parsed.success?{success:true}:{success:false,issues:parsed.error.issues.map(i=>({path:i.path.join('.'),message:i.message}))};
}
function dataOutputSchema(id) {
  const schema=schemas[id];if(!schema)throw Error('未知工具输出契约');
  return z.toJSONSchema(schema,{io:'output',unrepresentable:'any'});
}
module.exports={schemas,dataOutputSchema,validateToolData,ProjectSummary,ProjectDetail,Article,Task,Link,MetricCell,Operation};
