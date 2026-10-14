const {parseSettings,fail,indexingReviewDiagnostic}=require('../../insights/contracts');
const {readableNewsModel}=require('../../insights/news/presentation');
// The actor is resolved inside each SQL statement so cached roles cannot preserve revoked access.
const ACCESS=`EXISTS(SELECT 1 FROM users u WHERE u.id=@actor AND u.deleted_at IS NULL AND
  (u.role='admin' OR p.owner_user_id=u.id OR EXISTS(SELECT 1 FROM project_copywriters c WHERE c.project_id=p.id AND c.user_id=u.id AND c.revoked_at IS NULL)))`;
const articleScope=`(i.module='news' OR EXISTS(SELECT 1 FROM project_articles a WHERE a.project_id=p.id AND a.id=CAST(i.entity_key AS INTEGER) AND a.status='active'))`;
const runScope=`r.project_id=p.id AND r.module=i.module AND (r.module<>'indexing' OR r.selection_article_id IS NULL OR r.selection_article_id=CAST(i.entity_key AS INTEGER))`;
const columns=`i.*,p.name project_name,(SELECT r.id FROM ai_insight_runs r WHERE ${runScope} ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1) latest_run_id,(SELECT r.status FROM ai_insight_runs r WHERE ${runScope} ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1) latest_run_status,(SELECT url FROM project_articles WHERE project_id=p.id AND id=CAST(i.entity_key AS INTEGER)) current_article_url,(SELECT fetch_revision FROM project_articles WHERE project_id=p.id AND id=CAST(i.entity_key AS INTEGER)) current_article_revision,p.gsc_site current_property`;
function hydrate(row){
  const data=JSON.parse(row.data_json),identity=row.module==='performance'?data.evidence?.[0]:data.evidence?.find(e=>e.id===data.comparison?.current_id);
  const diagnostic=row.module==='indexing'&&indexingReviewDiagnostic(data.model?.explanation);
  if(diagnostic)data.model={...data.model,status:'failed',explanation:null,error_code:'MODEL_FACT',validation:diagnostic};
  if(row.module==='news')data.model=readableNewsModel(data);
  const identity_changed=Boolean(identity&&row.module!=='news'&&((identity.registered_url||identity.url)!==row.current_article_url||identity.fetch_revision!==row.current_article_revision||(row.module==='indexing'&&identity.property!==row.current_property)));
  return {...row,data,data_json:undefined,identity_changed,current_article_url:undefined,current_article_revision:undefined,current_property:undefined};
}
module.exports=backend=>({
  aiAccess:async(projectId,actorId)=>backend.prepare(`SELECT p.* FROM projects p WHERE p.id=@pid AND ${ACCESS}`).get({pid:projectId,actor:actorId}),
  aiProjects:async actorId=>backend.prepare(`SELECT p.id,p.name FROM projects p WHERE ${ACCESS} ORDER BY p.name,p.id`).all({actor:actorId}),
  aiSettings:async(projectId,actorId=null)=>{const row=await backend.prepare(`SELECT s.* FROM projects p LEFT JOIN ai_project_settings s ON s.project_id=p.id WHERE p.id=@pid AND (@actor IS NULL OR ${ACCESS})`).get({pid:projectId,actor:actorId});if(!row)fail('FORBIDDEN','无权访问该项目',403);return {version:row.version||0,config:parseSettings(row.config_json?JSON.parse(row.config_json):{}),updated_at:row.updated_at||null};},
  aiRun:async(id,projectId,actorId)=>backend.prepare(`SELECT r.* FROM ai_insight_runs r JOIN projects p ON p.id=r.project_id WHERE r.id=@id AND p.id=@pid AND ${ACCESS}`).get({id,pid:projectId,actor:actorId}),
  aiList:async(actorId,{module,projectId=null,offset=0,limit=10,category='',feedback='',date='',countsOnly=false}={})=>{
    const where=`${ACCESS} AND i.module=@module AND (i.module NOT IN ('news','performance') OR i.run_id=(SELECT latest.id FROM ai_insight_runs latest WHERE latest.project_id=p.id AND latest.module=i.module AND latest.result_json IS NOT NULL AND latest.status IN ('succeeded','partial','uncertain') ORDER BY latest.finished_at DESC,latest.rowid DESC LIMIT 1)) AND (i.module='news' OR EXISTS(SELECT 1 FROM project_articles a WHERE a.project_id=p.id AND a.id=CAST(i.entity_key AS INTEGER) AND a.status='active')) AND (@pid IS NULL OR p.id=@pid) AND (@category='' OR i.category=@category) AND (@feedback='' OR i.feedback=@feedback)`;
    const dateWhere=` AND (@date='' OR date(json_extract(i.data_json,'$.published_at'),'+8 hours')=@date)`;
    const args={actor:actorId,module,pid:projectId,category,feedback,date};
    const rows=countsOnly?[]:await backend.prepare(`SELECT ${columns} FROM ai_insights i JOIN projects p ON p.id=i.project_id WHERE ${where}${dateWhere} ORDER BY CASE WHEN i.module='news' THEN julianday(json_extract(i.data_json,'$.published_at')) END DESC,i.priority DESC,i.generated_at DESC,i.id LIMIT @limit OFFSET @offset`).all({...args,limit,offset});
    const counts=await backend.prepare(`SELECT i.category,COUNT(*) count FROM ai_insights i JOIN projects p ON p.id=i.project_id WHERE ${where}${dateWhere} GROUP BY i.category`).all(args);
    return {items:rows.map(hydrate),counts,total:counts.reduce((n,r)=>n+r.count,0),offset,limit};
  },
  aiDetail:async(id,projectId,actorId)=>{
    // Read notes and the card in one authorized statement so a later read cannot expose a revoked card.
    const row=await backend.prepare(`SELECT ${columns},(SELECT json_group_array(json_object('action',action,'note',note,'created_at',created_at,'actor_name',actor_name)) FROM (SELECT f.action,f.note,f.created_at,u.name actor_name FROM ai_insight_feedback f LEFT JOIN users u ON u.id=f.actor_id WHERE f.insight_id=i.id AND f.project_id=p.id ORDER BY f.created_at DESC,f.rowid DESC LIMIT 20)) feedback_history_json FROM ai_insights i JOIN projects p ON p.id=i.project_id WHERE i.id=@id AND p.id=@pid AND ${ACCESS} AND ${articleScope}`).get({id,pid:projectId,actor:actorId});
    return row&&{...hydrate(row),feedback_history:JSON.parse(row.feedback_history_json),feedback_history_json:undefined};
  },
});
module.exports.ACCESS=ACCESS;
