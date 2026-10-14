const CANDIDATE_LIMIT = 1000;
const ARTICLES_SQL = `SELECT id,url,title,fetch_revision,status,sort_order,published_at
  FROM project_articles WHERE project_id=? AND status='active'
  ORDER BY id LIMIT ${CANDIDATE_LIMIT}`;
const ARTICLE_GUARD_SQL = `SELECT json_object('count',
  (SELECT COUNT(*) FROM project_articles WHERE project_id=? AND status='active'),
  'articles',json((SELECT json_group_array(json_object('id',id,'url',url,'title',title,
    'fetch_revision',fetch_revision,'status',status,'sort_order',sort_order,'published_at',published_at))
    FROM (${ARTICLES_SQL}))))`;

// Only credential presence enters the plan; neither tokens nor account email are copied into evidence.
const AUTHORIZATION_SQL = `SELECT json_object('account',json((SELECT json_object(
  'id',a.id,'auth_revision',a.auth_revision,'owner_user_id',a.owner_user_id,
  'authorized',CASE WHEN length(COALESCE(a.refresh_token,''))>0 THEN 1 ELSE 0 END)
  FROM google_accounts a WHERE a.id=@account)),
  'resource',json((SELECT json_object('id',r.id,'account_id',r.account_id,'source',r.source,
    'resource_key',r.resource_key,'revision',r.revision,'state',r.state,
    'permission_level',r.permission_level,'generation',r.generation)
    FROM google_resources r WHERE r.account_id=@account AND r.source='gsc' AND r.resource_key=@property)),
  'grant',json((SELECT json_object('created_at',g.created_at,'granted_by',g.granted_by,
    'revoked_at',g.revoked_at) FROM project_resource_grants g WHERE g.project_id=@project
    AND g.source='gsc' AND g.account_id=@account AND g.resource_key=@property)),
  'policy',json((SELECT json_object('mode',mode,'updated_by',updated_by,'updated_at',updated_at)
    FROM project_source_policies WHERE project_id=@project AND source='gsc')),
  'actor',json((SELECT json_object('id',u.id,'role',u.role,'deleted_at',u.deleted_at)
    FROM users u WHERE u.id=@actor)))`;

module.exports = backend => ({
  aiIndexingArticles: projectId => backend.prepare(ARTICLES_SQL).all(projectId),
  aiIndexingArticleGuard: (projectId,articleId=null) => articleId===null
    ?{sql:ARTICLE_GUARD_SQL,args:[projectId,projectId]}
    :{sql:ARTICLE_GUARD_SQL.replaceAll("AND status='active'","AND status='active' AND id=?"),args:[projectId,articleId,projectId,articleId]},
  aiIndexingAuthorizationGuard: (projectId,accountId,property,actorId) => {
    const values={project:projectId,account:accountId,property,actor:actorId},args=[];
    const sql=AUTHORIZATION_SQL.replace(/@(project|account|property|actor)\b/g,(_,key)=>{args.push(values[key]);return '?';});
    return {sql,args};
  },
  aiIndexingHistories: (projectId,articleIds) => backend.prepare(`SELECT * FROM (
    SELECT s.*,s.rowid snapshot_order,ROW_NUMBER() OVER(PARTITION BY article_id ORDER BY checked_at DESC,s.rowid DESC) attempt_rank,
      SUM(valid) OVER(PARTITION BY article_id ORDER BY checked_at DESC,s.rowid DESC) valid_rank
    FROM ai_index_snapshots s WHERE project_id=? AND article_id IN (SELECT value FROM json_each(?))
  ) WHERE attempt_rank<=20 OR (valid=1 AND valid_rank<=100)
    ORDER BY article_id,checked_at DESC,snapshot_order DESC`).all(projectId,JSON.stringify(articleIds)),
  aiIndexingRunSnapshot: (runId,url) => backend.prepare(
    'SELECT * FROM ai_index_snapshots WHERE run_id=? AND url=?'
  ).get(runId,url),
  aiIndexingDailySnapshot: (projectId,articleId,url,property,fetchRevision,authorizationKey,provenance,start,end) => backend.prepare(`
    SELECT * FROM ai_index_snapshots WHERE project_id=? AND article_id=? AND url=? AND property=?
      AND json_extract(data_json,'$.fetch_revision')=? AND json_extract(data_json,'$.authorization_key')=?
      AND json_extract(data_json,'$.provenance')=? AND checked_at>=? AND checked_at<?
    ORDER BY checked_at DESC,rowid DESC LIMIT 1`).get(projectId,articleId,url,property,fetchRevision,authorizationKey,provenance,start,end),
  aiIndexingSnapshotStatement: snapshot => backend.prepare(`INSERT INTO ai_index_snapshots
    (id,project_id,run_id,article_id,url,property,checked_at,valid,status,data_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(snapshot.id,snapshot.project_id,snapshot.run_id,
      snapshot.article_id,snapshot.url,snapshot.property,snapshot.checked_at,
      snapshot.valid?1:0,snapshot.status,JSON.stringify(snapshot)),
});
module.exports.CANDIDATE_LIMIT = CANDIDATE_LIMIT;
