// Operations use conditional leases and checkpoints so polling never becomes an executor.
const { randomUUID } = require('node:crypto');
const terminal = "('succeeded','partial','failed','cancelled')";
const json = (v) => JSON.stringify(v ?? null);
const at = () => new Date().toISOString();
// 未发布的分块预留单份最大预算，防止多个未完成导出绕过只在发布时执行的配额。
const artifactCost = "CASE WHEN a.checksum='' THEN 5242880 ELSE a.bytes+a.payload_bytes END";

module.exports = (db) => {
  const leaseGuard = `EXISTS (SELECT 1 FROM business_operations o WHERE o.id = ? AND o.lease_id = ?
    AND o.lease_expires_at > ? AND o.status = 'running')`;
  const readyItem = `i.state IN ('queued','running') AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= ?)
    AND (COALESCE(json_extract(i.input_json,'$.kind'),'') NOT IN ('internal_finalize','external_finalize') OR NOT EXISTS (
      SELECT 1 FROM json_each(json_extract(i.input_json,'$.dependencies')) d JOIN business_operation_items child
        ON child.operation_id=i.operation_id AND child.item_key=d.value
        WHERE child.state IN ('queued','running','unprocessed')))`;
  const api = {
    mcpGetOperation: (id) => db.prepare('SELECT * FROM business_operations WHERE id = ?').get(id),
    mcpFindOperation: (uid, tool, key) => db.prepare('SELECT * FROM business_operations WHERE user_id = ? AND tool = ? AND idempotency_key = ?').get(uid, tool, key),
    mcpCreateQueuedOperation: async (op, items) => {
      const stamp = at();
      await db.batchAtomic([
        db.prepare(`INSERT OR IGNORE INTO business_operations
          (id,user_id,channel,token_id,tool,input_hash,idempotency_key,status,project_ids_json,input_json,
           kind,parent_operation_id,checkpoint_json,progress_total,progress_unit,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?)`).bind(op.id, op.user_id, op.channel, op.token_id ?? null,
          op.tool, op.input_hash, op.idempotency_key, json(op.project_ids), json(op.input), op.kind,
          op.parent_operation_id ?? null, json(op.checkpoint || {}), items.length, op.unit || 'item', stamp, stamp),
        db.prepare(`INSERT OR IGNORE INTO business_operation_items
          (operation_id,item_key,state,input_json,expected_revision,attempts,created_at,updated_at)
          SELECT ?,json_extract(value,'$.key'),'queued',json_extract(value,'$.input'),
            json_extract(value,'$.revision'),0,?,? FROM json_each(?)
          WHERE EXISTS (SELECT 1 FROM business_operations WHERE id = ?)`)
          .bind(op.id, stamp, stamp, json(items), op.id),
      ]);
      return api.mcpFindOperation(op.user_id, op.tool, op.idempotency_key);
    },
    mcpActiveSync: (pid) => db.prepare(`SELECT * FROM business_operations WHERE kind = 'sync'
      AND status IN ('queued','running','cancel_requested') AND json_extract(project_ids_json,'$[0]') = ? LIMIT 1`).get(pid),
    mcpOperationCounts: (id) => db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(state='succeeded'),0) AS succeeded,COALESCE(SUM(state='failed'),0) AS failed,
      COALESCE(SUM(state IN ('queued','running','unprocessed')),0) AS unprocessed
      FROM business_operation_items WHERE operation_id = ?`).get(id),
    mcpOperationItems: (id, page, size, states) => {
      const clause = states?.length ? ` AND state IN (${states.map(() => '?').join(',')})` : '';
      return db.prepare(`SELECT * FROM business_operation_items WHERE operation_id = ?${clause}
        ORDER BY item_key LIMIT ? OFFSET ?`).all(id, ...(states || []), size, (page - 1) * size);
    },
    mcpClaimOperation: async (id, seconds = 120) => {
      const now = at(); const lease = randomUUID();
      const until = new Date(Date.now() + seconds * 1000).toISOString();
      const result = await db.prepare(`UPDATE business_operations SET status='running',lease_id=?,lease_expires_at=?,
        recovery_attempts=recovery_attempts + CASE WHEN status='running' THEN 1 ELSE 0 END,updated_at=?
        WHERE id=? AND kind<>'mutation' AND status IN ('queued','running') AND (lease_id IS NULL OR lease_expires_at <= ?)
          AND recovery_attempts < 3`).run(lease, until, now, id, now);
      return result.changes ? lease : null;
    },
    mcpRunnableOperations: (limit = 5) => {
      const now = at();
      // 纯退避不占执行槽；导出、取消、完成和租约恢复不依赖到期的普通单元。
      return db.prepare(`SELECT o.id FROM business_operations o
        WHERE o.kind<>'mutation' AND o.status IN ('queued','running','cancel_requested')
          AND (o.lease_id IS NULL OR o.lease_expires_at <= ?)
          AND (o.status='cancel_requested' OR o.kind='export'
            OR (o.status='running' AND o.lease_id IS NOT NULL)
            OR NOT EXISTS (SELECT 1 FROM business_operation_items i WHERE i.operation_id=o.id
              AND i.state IN ('queued','running','unprocessed'))
            OR EXISTS (SELECT 1 FROM business_operation_items i WHERE i.operation_id=o.id AND ${readyItem}))
        ORDER BY o.created_at,o.id LIMIT ?`).all(now, now, Math.min(limit, 5));
    },
    mcpNextOperationItem: (id) => db.prepare(`SELECT i.* FROM business_operation_items i WHERE i.operation_id=?
      AND ${readyItem} ORDER BY i.item_key LIMIT 1`).get(id, at()),
    mcpSyncDependencies: (id,keys) => db.prepare(`WITH RECURSIVE ancestors(id,depth) AS (
      SELECT ?,0 UNION ALL SELECT o.parent_operation_id,a.depth+1 FROM business_operations o JOIN ancestors a ON o.id=a.id
        WHERE o.parent_operation_id IS NOT NULL AND a.depth<10), chosen AS (
        SELECT i.*,ROW_NUMBER() OVER (PARTITION BY i.item_key ORDER BY a.depth) AS preference
          FROM business_operation_items i JOIN ancestors a ON a.id=i.operation_id WHERE i.item_key IN (SELECT value FROM json_each(?)))
      SELECT operation_id,item_key,state,result_json,error_json FROM chosen WHERE preference=1 ORDER BY item_key`).all(id,json(keys)),
    mcpLeaseOwned: (id, lease) => db.prepare(`SELECT 1 AS owned FROM business_operations WHERE id=?
      AND lease_id=? AND lease_expires_at>? AND status='running'`).get(id, lease, at()),
    mcpCheckpointOperation: (id, lease, checkpoint) => db.prepare(`UPDATE business_operations SET checkpoint_json=?,updated_at=?,
      lease_id=NULL,lease_expires_at=NULL,recovery_attempts=0 WHERE id=? AND lease_id=? AND lease_expires_at>? AND status='running'`)
      .run(json(checkpoint),at(),id,lease,at()),
    mcpFinishOperationItem: async (id, lease, key, result, error, retryAfter) => {
      const stamp = at();
      const state = retryAfter ? 'queued' : error ? 'failed' : 'succeeded';
      const next = retryAfter ? new Date(Date.now() + retryAfter * 1000).toISOString() : null;
      await db.batchAtomic([
        db.prepare(`UPDATE business_operation_items SET state=?,result_json=?,error_json=?,attempts=attempts+1,
          next_attempt_at=?,updated_at=? WHERE operation_id=? AND item_key=? AND state NOT IN ('succeeded','failed') AND ${leaseGuard}`)
          .bind(state, json(result), json(error), next, stamp, id, key, id, lease, stamp),
        db.prepare(`UPDATE business_operations SET progress_completed=(SELECT COUNT(*) FROM business_operation_items
          WHERE operation_id=? AND state IN ('succeeded','failed')),updated_at=?,lease_id=NULL,lease_expires_at=NULL,
          recovery_attempts=0 WHERE id=? AND lease_id=? AND status='running' AND lease_expires_at>?`)
          .bind(id, stamp, id, lease, stamp),
      ]);
    },
    mcpCompleteOperation: async (id, lease, status, summary, error = null) => {
      const stamp = at(); const detail = new Date(Date.now() + 86400000).toISOString();
      return db.prepare(`UPDATE business_operations SET status=?,result_summary_json=?,error_json=?,updated_at=?,
        detail_expires_at=?,expires_at=?,lease_id=NULL,lease_expires_at=NULL WHERE id=? AND lease_id=?
        AND lease_expires_at>? AND status='running'`).run(status, json(summary), json(error), stamp, detail,
        new Date(Date.now() + 91 * 86400000).toISOString(), id, lease, stamp);
    },
    mcpRequestOperationCancel: (id) => db.prepare(`UPDATE business_operations SET status='cancel_requested',updated_at=?
      WHERE id=? AND status IN ('queued','running')`).run(at(), id),
    mcpSettleOperationCancel: (id) => db.prepare(`UPDATE business_operations SET status='cancelled',updated_at=?,
      detail_expires_at=?,expires_at=?,lease_id=NULL,lease_expires_at=NULL
      WHERE id=? AND status='cancel_requested' AND (lease_id IS NULL OR lease_expires_at<=?)`).run(at(),
      new Date(Date.now() + 86400000).toISOString(), new Date(Date.now() + 91 * 86400000).toISOString(), id, at()),
    mcpFailAbandonedOperations: () => db.prepare(`UPDATE business_operations SET status='failed',error_json=?,updated_at=?,
      detail_expires_at=?,expires_at=?,lease_id=NULL,lease_expires_at=NULL WHERE status='running'
      AND recovery_attempts>=3 AND lease_expires_at<=?`).run(json({code:'DEPENDENCY_UNAVAILABLE',message:'连续三次恢复无进展'}),at(),
      new Date(Date.now()+86400000).toISOString(),new Date(Date.now()+91*86400000).toISOString(),at()),
    mcpSettleStaleMutations: () => db.prepare(`UPDATE business_operations SET status=CASE WHEN progress_completed>0 THEN 'partial' ELSE 'failed' END,
      lease_id=NULL,lease_expires_at=NULL,updated_at=?,detail_expires_at=? WHERE id IN (SELECT id FROM business_operations
      WHERE kind='mutation' AND status='running' AND lease_expires_at<=? LIMIT 20)`)
      .run(at(),new Date(Date.now()+86400000).toISOString(),at()),
    mcpProjectVector: (ids) => db.prepare(`SELECT id,revision,data_revision,membership_revision,config_revision,order_revision
      FROM projects WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids),
    mcpOperationProjectAccessCount: (ids,uid) => db.prepare(`SELECT COUNT(*) AS count FROM projects p JOIN users u ON u.id=? AND u.deleted_at IS NULL
      WHERE p.id IN (SELECT value FROM json_each(?)) AND (u.role='admin' OR p.owner_user_id=u.id
        OR EXISTS (SELECT 1 FROM project_copywriters c WHERE c.project_id=p.id AND c.user_id=u.id AND c.revoked_at IS NULL))`).get(uid,json(ids)),
    mcpActiveSyncArticles: (pid) => db.prepare(`SELECT id,url,fetch_revision FROM project_articles WHERE project_id=? AND status='active' ORDER BY id`).all(pid),
    mcpTitleArticles: async (pid, kind, ids) => {
      const table=kind==='internal'?'project_articles':'project_external_articles';const rows=[];
      for(let offset=0;offset<ids.length;offset+=90){const group=ids.slice(offset,offset+90);
        rows.push(...await db.prepare(`SELECT * FROM ${table} WHERE project_id=? AND id IN (${group.map(()=>'?').join(',')})`).all(pid,...group));}
      return rows;
    },
    mcpExternalRegistrySignatures: (pid) => db.prepare(`SELECT domain,json_group_array(json_array(id,registry_revision)) AS signature
      FROM (SELECT id,domain,registry_revision FROM project_external_articles WHERE project_id=? ORDER BY id)
      GROUP BY domain`).all(pid),
    mcpExportUsage: (uid, excludeId = '') => db.prepare(`SELECT COALESCE(SUM(${artifactCost}),0) AS total,
      COALESCE(SUM(CASE WHEN o.user_id=? THEN ${artifactCost} ELSE 0 END),0) AS user_total
      FROM export_artifacts a JOIN business_operations o ON o.id=a.operation_id WHERE a.expires_at>? AND a.id<>?`).get(uid, at(), excludeId),
    mcpGetExportArtifact: (id) => db.prepare('SELECT * FROM export_artifacts WHERE operation_id=?').get(id),
    mcpExportChunks: (artifactId) => db.prepare('SELECT payload,rows_json FROM export_artifact_chunks WHERE artifact_id=? ORDER BY chunk_no').all(artifactId),
    mcpSaveExportChunk: (artifactId, chunkNo, payload, rows, operationId, lease) => db.prepare(`INSERT OR REPLACE INTO export_artifact_chunks
      (artifact_id,chunk_no,payload,rows_json) SELECT ?,?,?,? WHERE ${leaseGuard}`)
      .run(artifactId, chunkNo, payload, json(rows), operationId, lease, at()),
    mcpPublishExport: async (op, lease, artifact, vector) => {
      const stamp = at(); const expires = new Date(Date.now() + 86400000).toISOString();
      const vectorGuard=`NOT EXISTS (SELECT 1 FROM json_each(?) v WHERE NOT EXISTS (SELECT 1 FROM projects p
        WHERE p.id=json_extract(v.value,'$.id') AND p.revision=json_extract(v.value,'$.revision')
        AND p.data_revision=json_extract(v.value,'$.data_revision') AND p.membership_revision=json_extract(v.value,'$.membership_revision')
        AND p.config_revision=json_extract(v.value,'$.config_revision') AND p.order_revision=json_extract(v.value,'$.order_revision')
        AND EXISTS (SELECT 1 FROM users u WHERE u.id=? AND u.deleted_at IS NULL AND (u.role='admin' OR p.owner_user_id=u.id
          OR EXISTS (SELECT 1 FROM project_copywriters c WHERE c.project_id=p.id AND c.user_id=u.id AND c.revoked_at IS NULL)))))`;
      const tokenCheck = op.channel === 'mcp' ? ` AND EXISTS (SELECT 1 FROM mcp_tokens WHERE user_id=? AND token_id=? AND revoked_at IS NULL)` : '';
      await db.batchAtomic([
        db.prepare(`UPDATE business_operations SET status='succeeded',result_summary_json=?,updated_at=?,detail_expires_at=?,
          expires_at=?,lease_id=NULL,lease_expires_at=NULL WHERE id=? AND lease_id=? AND lease_expires_at>? AND status='running'
          AND ${vectorGuard}${tokenCheck}
          AND (SELECT COALESCE(SUM(${artifactCost}),0) FROM export_artifacts a WHERE a.expires_at>? AND a.id<>?) + ? <= 52428800
          AND (SELECT COALESCE(SUM(${artifactCost}),0) FROM export_artifacts a JOIN business_operations b ON b.id=a.operation_id
            WHERE b.user_id=? AND a.expires_at>? AND a.id<>?) + ? <= 20971520`).bind(json(artifact.summary),stamp,expires,
          new Date(Date.now()+91*86400000).toISOString(),op.id,lease,stamp,json(vector),op.user_id,...(op.channel==='mcp'?[op.user_id,op.token_id]:[]),
          stamp,artifact.id,artifact.bytes+artifact.payload_bytes,op.user_id,stamp,artifact.id,artifact.bytes+artifact.payload_bytes),
        db.prepare(`UPDATE export_artifacts SET name=?,mime_type=?,bytes=?,payload_bytes=?,checksum=?,expires_at=?
          WHERE id=? AND EXISTS (SELECT 1 FROM business_operations WHERE id=? AND status='succeeded')`)
          .bind(artifact.name,artifact.mime_type,artifact.bytes,artifact.payload_bytes,artifact.checksum,expires,artifact.id,op.id),
        db.prepare(`UPDATE business_operation_items SET state='succeeded',result_json=?,updated_at=?
          WHERE operation_id=? AND EXISTS (SELECT 1 FROM business_operations WHERE id=? AND status='succeeded')`)
          .bind(json(artifact.summary),stamp,op.id,op.id),
      ]);
      return (await api.mcpGetOperation(op.id)).status === 'succeeded';
    },
    mcpCreatePendingArtifact: (artifactId, operationId, lease) => db.prepare(`INSERT INTO export_artifacts
      (id,operation_id,name,mime_type,bytes,payload_bytes,checksum,expires_at)
      SELECT ?,?,'','',0,0,'',? WHERE ${leaseGuard}
        AND (SELECT COALESCE(SUM(${artifactCost}),0) FROM export_artifacts a WHERE a.expires_at>? AND a.id<>?) + 5242880 <= 52428800
        AND (SELECT COALESCE(SUM(${artifactCost}),0) FROM export_artifacts a JOIN business_operations o ON o.id=a.operation_id
          WHERE o.user_id=(SELECT user_id FROM business_operations WHERE id=?) AND a.expires_at>? AND a.id<>?) + 5242880 <= 20971520
      ON CONFLICT(id) DO UPDATE SET id=excluded.id`)
      .run(artifactId,operationId,new Date(Date.now()+86400000).toISOString(),operationId,lease,at(),at(),artifactId,operationId,at(),artifactId),
    mcpCommitFetchedTitle: async (op, lease, item, article, kind, outcome) => {
      const table = kind === 'internal' ? 'project_articles' : 'project_external_articles';
      const stamp = at();
      const write = outcome.title ? db.prepare(`UPDATE ${table} SET title=?,title_source='fetched',title_fetch_status='ok',
        title_fetch_error=NULL,title_fetched_at=?,updated_at=? WHERE id=? AND project_id=? AND url=? AND revision=?
        AND status='active' AND ${leaseGuard}`).bind(outcome.title,stamp,stamp,article.id,article.project_id,article.url,
        article.revision,op.id,lease,stamp) : db.prepare(`UPDATE ${table} SET title_fetch_error=?,title_fetch_attempts=MIN(title_fetch_attempts+1,3),
        title_fetch_status='failed',title_fetched_at=?,updated_at=? WHERE id=? AND project_id=? AND url=? AND revision=?
        AND status='active' AND ${leaseGuard}`).bind(outcome.error,stamp,stamp,article.id,article.project_id,article.url,
        article.revision,op.id,lease,stamp);
      const tokenGuard=op.channel==='mcp'?` AND EXISTS (SELECT 1 FROM mcp_tokens WHERE user_id=? AND token_id=? AND revoked_at IS NULL)`:'';
      const guardArgs=[op.id,`title:${item.item_key}`,op.id,lease,stamp,op.user_id,article.project_id,...(op.channel==='mcp'?[op.user_id,op.token_id]:[])];
      let result;
      try {
      const results = await db.batchAtomic([
        db.prepare(`INSERT OR REPLACE INTO business_mutation_guards(operation_id,guard_key,ok)
          SELECT ?,?,CASE WHEN ${leaseGuard}
          AND EXISTS (SELECT 1 FROM users u JOIN projects p ON p.id=? WHERE u.id=? AND u.deleted_at IS NULL AND (u.role='admin' OR p.owner_user_id=u.id
            OR EXISTS (SELECT 1 FROM project_copywriters c WHERE c.project_id=p.id AND c.user_id=u.id AND c.revoked_at IS NULL)))
          ${tokenGuard} THEN 1 ELSE 0 END`).bind(...[...guardArgs.slice(0,5),article.project_id,op.user_id,...guardArgs.slice(7)]),
        write,
        db.prepare(`UPDATE business_operation_items SET state=CASE WHEN changes()>0 THEN ? ELSE 'failed' END,
          result_json=?,error_json=CASE WHEN changes()>0 THEN ? ELSE ? END,attempts=attempts+1,updated_at=?
          ,input_json=CASE WHEN changes()>0 THEN json_set(input_json,'$.revision',(SELECT revision FROM ${table} WHERE id=?)) ELSE input_json END,
          expected_revision=CASE WHEN changes()>0 THEN (SELECT revision FROM ${table} WHERE id=?) ELSE expected_revision END
          WHERE operation_id=? AND item_key=? AND ${leaseGuard}`).bind(outcome.error?'failed':'succeeded',
          json(outcome.title?{article_id:article.id,title:outcome.title,effects:['title_fetched']}:null),
          json(outcome.error?{code:'SOURCE_ERROR',message:outcome.error}:null),json({code:'CONFLICT',message:'文章或租约已变化'}),
          stamp,article.id,article.id,op.id,item.item_key,op.id,lease,stamp),
        db.prepare(`INSERT INTO business_audit_events (operation_id,user_id,token_id,tool,item_key,effects_json,created_at,expires_at)
          SELECT ?,?,?,?,?,?,?,? WHERE ${leaseGuard}`).bind(op.id,op.user_id,op.token_id,op.tool,item.item_key,
          json(outcome.title?['title_fetched']:['title_fetch_failed']),stamp,new Date(Date.now()+30*86400000).toISOString(),op.id,lease,stamp),
        db.prepare('DELETE FROM business_mutation_guards WHERE operation_id=? AND guard_key=?').bind(op.id,`title:${item.item_key}`),
      ]);
      result=results[1];
      } catch(error) {
        if(/CHECK constraint failed/.test(error.message))return false;
        throw error;
      }
      return Number(result.changes || 0) > 0;
    },
    mcpPruneOperationDetails: async () => {
      // Detailed results expire separately; receipt rows remain for the idempotency window.
      await db.batchAtomic([
        db.prepare('DELETE FROM export_artifacts WHERE id IN (SELECT id FROM export_artifacts WHERE expires_at<=? LIMIT 20)').bind(at()),
        db.prepare(`UPDATE business_operation_items SET input_json=NULL,result_json=NULL,error_json=NULL WHERE operation_id IN
          (SELECT id FROM business_operations o WHERE status IN ${terminal} AND detail_expires_at<=?
            AND EXISTS(SELECT 1 FROM business_operation_items i WHERE i.operation_id=o.id
              AND (i.input_json IS NOT NULL OR i.result_json IS NOT NULL OR i.error_json IS NOT NULL)) LIMIT 20)`).bind(at()),
        db.prepare(`UPDATE business_operations SET input_json=NULL,checkpoint_json=NULL WHERE status IN ${terminal}
          AND id IN (SELECT id FROM business_operations WHERE detail_expires_at<=? AND input_json IS NOT NULL LIMIT 20)`).bind(at()),
        db.prepare(`UPDATE business_operations SET result_summary_json=json_object('status',status,
          'succeeded_count',(SELECT COUNT(*) FROM business_operation_items WHERE operation_id=business_operations.id AND state='succeeded'),
          'failed_count',(SELECT COUNT(*) FROM business_operation_items WHERE operation_id=business_operations.id AND state='failed')),
          error_json=NULL WHERE id IN (SELECT id FROM business_operations WHERE status IN ${terminal}
            AND updated_at<? AND result_summary_json IS NOT NULL AND (json_extract(result_summary_json,'$.succeeded_count') IS NULL
              OR (SELECT COUNT(*) FROM json_each(result_summary_json))>3) LIMIT 20)`)
          .bind(new Date(Date.now()-30*86400000).toISOString()),
        db.prepare(`DELETE FROM business_operations WHERE id IN (SELECT id FROM business_operations WHERE status IN ${terminal} AND created_at<? LIMIT 20)`).bind(new Date(Date.now()-91*86400000).toISOString()),
      ]);
    },
  };
  return api;
};
