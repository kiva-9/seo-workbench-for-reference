const { ACCESS } = require('./ai-insights');

// 每个来源在 UNION 前鉴权；任何未授权项目都使整笔业务操作不可见。
const SOURCES = `
  SELECT 'article-sync' type,j.job_id id,'internal' module,json_array(p.id) project_ids,NULL account_id,j.created_by actor_id,
    j.status,j.created_at,j.updated_at,j.started_at,j.finished_at
    FROM article_monitor_sync_jobs j JOIN projects p ON p.id=j.project_id WHERE ${ACCESS}
  UNION ALL
  SELECT 'ai',r.id,r.module,json_array(p.id),NULL,r.actor_id,r.status,r.created_at,
    COALESCE(r.finished_at,r.started_at,r.created_at),r.started_at,r.finished_at
    FROM ai_insight_runs r JOIN projects p ON p.id=r.project_id WHERE ${ACCESS}
  UNION ALL
  SELECT 'operation',o.id,o.kind,o.project_ids_json,NULL,o.user_id,o.status,o.created_at,o.updated_at,NULL,
    CASE WHEN o.status IN ('succeeded','partial','failed','cancelled') THEN o.updated_at END
    FROM business_operations o JOIN users actor ON actor.id=@actor AND actor.deleted_at IS NULL
    WHERE o.kind IN ('sync','titles','export','import_retry') AND (o.user_id=actor.id OR actor.role='admin')
      AND (o.expires_at IS NULL OR o.expires_at>@now)
      AND NOT EXISTS(SELECT 1 FROM json_each(o.project_ids_json) ids WHERE NOT EXISTS(
        SELECT 1 FROM projects p WHERE p.id=ids.value AND ${ACCESS}))
  UNION ALL
  SELECT 'resource-sync',j.id,'google-catalog','[]',a.id,j.requested_by,j.status,j.created_at,j.updated_at,NULL,j.finished_at
    FROM google_resource_sync_jobs j JOIN google_accounts a ON a.id=j.account_id
    JOIN users actor ON actor.id=@actor AND actor.deleted_at IS NULL WHERE actor.role='admin' OR a.owner_user_id=actor.id`;
const LABELS = `SELECT t.*,
  (SELECT group_concat(name,'、') FROM (SELECT p.name FROM projects p JOIN json_each(t.project_ids) ids ON p.id=ids.value ORDER BY p.id)) project_name,
  (SELECT COALESCE(NULLIF(note,''),email) FROM google_accounts WHERE id=t.account_id) account_name,
  (SELECT COALESCE(NULLIF(name,''),'用户 '||id) FROM users WHERE id=t.actor_id) actor_name FROM tasks t`;

module.exports = db => ({
  backgroundTasks: async (actor, { type = '', status = '', project = null, account = null, page = 1, pageSize = 25, asOf = new Date().toISOString() } = {}) => {
    const args = { actor, now: new Date().toISOString(), type, status, project, account, asOf };
    const where = `created_at<=@asOf AND (@type='' OR type=@type) AND (@status='' OR status=@status OR (@status='active' AND status IN ('queued','running','cancel_requested')))
      AND (@project IS NULL OR EXISTS(SELECT 1 FROM json_each(project_ids) WHERE value=@project)) AND (@account IS NULL OR account_id=@account)`;
    const base = `WITH authorized AS (${SOURCES}),tasks AS (SELECT * FROM authorized WHERE ${where})`;
    const total = Number((await db.prepare(`${base} SELECT COUNT(*) total FROM tasks`).get(args)).total);
    const rows = await db.prepare(`${base} ${LABELS} ORDER BY created_at DESC,type ASC,id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...args, limit: pageSize, offset: (page - 1) * pageSize });
    return { rows, total, page, pageSize, asOf };
  },
  backgroundTask: (actor, type, id) => db.prepare(`WITH authorized AS (${SOURCES}),tasks AS (SELECT * FROM authorized WHERE type=@type AND id=@id) ${LABELS}`)
    .get({ actor, type, id, now: new Date().toISOString() }),
});
