const { randomUUID, createHash } = require('node:crypto');
const { fail, BusinessError, canonicalJson, businessDate } = require('./mcp-common');
const { shiftDay } = require('../lib/business-dates');
const createResultQueries = require('../db/queries/mcp-mutation-results');

function validateIdempotencyKey(key, today = businessDate()) {
  if (typeof key !== 'string' || !/^\d{8}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    fail('VALIDATION_ERROR', 'idempotency_key 必须为 YYYYMMDD:<UUID>');
  }
  const d = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
  const { validateDate } = require('./mcp-common');
  if (!validateDate(d) || d > today) fail('VALIDATION_ERROR', '幂等键日期必须为首次提交的业务日，不能是未来日期');
  if (d < shiftDay(today, -90)) fail('OPERATION_EXPIRED', '幂等键已超过 90 天窗口，不能重新执行');
  return key;
}
const inputHash = input => createHash('sha256').update(canonicalJson(input)).digest('hex');
const parse = (value, fallback) => value ? JSON.parse(value) : fallback;

async function canExposeMutationItems(db, actor, items, projectIds = []) {
  const refs = new Map();
  for (const id of projectIds) refs.set(`project:${id}`, { kind: 'project', id });
  for (const row of items) {
    const result = row.result_json ? parse(row.result_json, {}) : row.result;
    for (const id of result?.operation?.project_ids || []) {
      if (Number.isSafeInteger(id) && id > 0) refs.set(`project:${id}`, { kind: 'project', id });
    }
    const item = result?.item;
    if (!item) continue;
    let kind, id;
    if (item.ref) { kind = item.ref.article_type; id = item.ref.article_id; }
    else if ('priority' in item && 'due_date' in item) { kind = 'task'; id = item.id; }
    else if (Array.isArray(item.tags)) { kind = 'link'; id = item.id; }
    else if ('website' in item && 'owner_user_id' in item) { kind = 'project'; id = item.id; }
    if (kind && Number.isSafeInteger(id) && id > 0) refs.set(`${kind}:${id}`, { kind, id });
  }
  if (!refs.size) return true;
  const visible = await createResultQueries(db.db).visibleResultCount([...refs.values()], actor.user_id);
  return Number(visible.count) === refs.size;
}

function createMutationService({ db }) {
  const sql = db.db;
  const resultQueries = createResultQueries(sql);
  const minimalReceipt = op => ({ operation_id: op.id, changed: Boolean(op.progress_completed), committed_count: op.progress_completed,
    status: op.status, receipt_only: true, results: [], succeeded: [], failed: [], unprocessed: [], rejected: [] });
  async function existing(tool, input, actor) {
    const op = await sql.prepare('SELECT * FROM business_operations WHERE user_id = ? AND tool = ? AND idempotency_key = ?')
      .get(actor.user_id, tool, input.idempotency_key);
    if (!op) return null;
    if (op.input_hash !== inputHash(input)) fail('IDEMPOTENCY_CONFLICT', '同一个幂等键已用于不同参数');
    const ids = parse(op.project_ids_json, []);
    if (ids.length && Number((await resultQueries.projectAccessCount(ids, actor.user_id)).count) !== ids.length) return minimalReceipt(op);
    if (op.detail_expires_at && op.detail_expires_at < new Date().toISOString()) {
      return minimalReceipt(op);
    }
    const items = await sql.prepare('SELECT item_key, state, result_json, error_json FROM business_operation_items WHERE operation_id = ? ORDER BY rowid').all(op.id);
    if (!await canExposeMutationItems(db, actor, items)) return minimalReceipt(op);
    return receipt(op.id, items, parse(op.result_summary_json, {}), op.status);
  }
  function receipt(id, items, summary = {}, status) {
    const results = items.filter(i => i.state === 'succeeded').map(i => ({ key: i.item_key, ...parse(i.result_json, {}) }));
    // 明细与终态摘要可以同时含失败项；按 key 合并，原子单元的明细是提交事实。
    const failed = new Map((summary.failed || []).map(i => [i.key, i]));
    for (const item of items.filter(i => i.state === 'failed')) failed.set(item.item_key, { key: item.item_key, ...parse(item.error_json, {}) });
    const reasons = new Map((summary.unprocessed || []).map(i => typeof i === 'string' ? [i, { key: i }] : [i.key, i]));
    const unprocessed = items.filter(i => ['queued','running','unprocessed'].includes(i.state))
      .map(i => reasons.get(i.item_key) || { key: i.item_key, reason: 'INCOMPLETE_OPERATION' });
    return { ...summary, ...(status ? { status } : {}), operation_id: id, changed: results.some(r => r.changed !== false), results,
      succeeded: results.map(r => ({ key: r.key, ...r })),
      failed: [...failed.values()], unprocessed, rejected: [] };
  }
  async function mutate({ tool, input, actor, prepare }) {
    validateIdempotencyKey(input.idempotency_key);
    const previous = await existing(tool, input, actor);
    if (previous) return previous;
    const plan = await prepare();
    const units = plan.units || [];
    if (!units.length) fail('VALIDATION_ERROR', '没有可提交的业务单元');
    if (units.length > 100) fail('RANGE_TOO_LARGE', '单次最多 100 个业务单元');
    const projectIds = [...new Set(plan.projectIds || [])];
    if (projectIds.length > 20) fail('RANGE_TOO_LARGE', '请按最多 20 个项目分批');
    const id = randomUUID(), lease = randomUUID(), now = new Date().toISOString();
    const leaseEnd = new Date(Date.parse(now) + 60_000).toISOString();
    const detailEnd = new Date(Date.parse(now) + 24 * 3600_000).toISOString();
    const auditEnd = new Date(Date.parse(now) + 30 * 86400_000).toISOString();
    // 墓碑覆盖按业务日接受旧键的整个 90 天窗口，审计事件仍按各自的 30 天期限清理。
    const tombstoneEnd = new Date(Date.parse(now) + 91 * 86400_000).toISOString();
    const keys = units.map((u, i) => String(u.key ?? i));
    if (new Set(keys).size !== keys.length) fail('VALIDATION_ERROR', '业务单元 key 不可重复');
    let claimed = false;
    const stored = [], unprocessed = [], failed = [];
    for (let index = 0; index < units.length; index++) {
      const unit = units[index], key = keys[index];
      const guards = [{ code: 'FORBIDDEN', message: '账号权限或 token 已变更，请重新读取',
        sql: `SELECT EXISTS(SELECT 1 FROM users u WHERE u.id = ? AND u.deleted_at IS NULL ${actor.token_id ? 'AND EXISTS(SELECT 1 FROM mcp_tokens t WHERE t.user_id=u.id AND t.token_id=? AND t.revoked_at IS NULL)' : ''})`,
        params: actor.token_id ? [actor.user_id, actor.token_id] : [actor.user_id] }];
      if (projectIds.length) guards.push({ code: 'FORBIDDEN', message: '项目权限已变更',
        sql: `SELECT COUNT(*) = ? FROM projects p WHERE p.id IN (${projectIds.map(() => '?').join(',')}) AND
          EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.deleted_at IS NULL AND (u.role='admin' OR p.owner_user_id=u.id
          OR EXISTS(SELECT 1 FROM project_copywriters c WHERE c.project_id=p.id AND c.user_id=u.id AND c.revoked_at IS NULL)))`,
        params: [projectIds.length, ...projectIds, actor.user_id] });
      guards.push(...(unit.guards || []));
      if (claimed) guards.push({ code: 'CONFLICT', message: '操作租约已过期或执行者已改变',
        sql: "SELECT EXISTS(SELECT 1 FROM business_operations WHERE id=? AND lease_id=? AND lease_expires_at>? AND status='running')", params: [id, lease, new Date().toISOString()] });
      const statements = [];
      if (!claimed) statements.push(sql.prepare(`INSERT INTO business_operations
        (id,user_id,channel,token_id,tool,input_hash,idempotency_key,status,project_ids_json,input_json,
        lease_id,lease_expires_at,progress_total,detail_expires_at,expires_at,created_at,updated_at,checkpoint_json)
        VALUES (?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?,?,?)`).bind(id,actor.user_id,actor.channel,actor.token_id || null,
        tool,inputHash(input),input.idempotency_key,JSON.stringify(projectIds),canonicalJson(input),lease,leaseEnd,units.length,detailEnd,tombstoneEnd,now,now,canonicalJson(plan.checkpoint || {})));
      if (!claimed) statements.push(sql.prepare(`INSERT INTO business_operation_items(operation_id,item_key,state,input_json,created_at,updated_at)
        SELECT ?,json_extract(value,'$.key'),'unprocessed',json_extract(value,'$.input'),?,? FROM json_each(?)`)
        .bind(id,now,now,JSON.stringify(units.map((u,i)=>({key:keys[i],input:u.input || null})))));
      guards.forEach((g, gi) => statements.push(sql.prepare(`INSERT INTO business_mutation_guards(operation_id,guard_key,ok)
        VALUES (?, ?, COALESCE((${g.sql}), 0))`).bind(id, `${key}:${gi}`, ...(g.params || g.args || []))));
      statements.push(...unit.statements);
      if (unit.resultSql) {
        const rs = unit.resultSql;
        statements.push(sql.prepare(`INSERT INTO business_operation_items(operation_id,item_key,state,result_json,created_at,updated_at)
          SELECT ?,?,'succeeded',r.result_json,?,? FROM (${rs.sql}) r WHERE 1
          ON CONFLICT(operation_id,item_key) DO UPDATE SET state='succeeded',result_json=excluded.result_json,updated_at=excluded.updated_at`).bind(id,key,now,now,...(rs.args || rs.params || [])));
      } else statements.push(sql.prepare(`INSERT INTO business_operation_items(operation_id,item_key,state,result_json,created_at,updated_at)
        VALUES (?,?,'succeeded',?,?,?) ON CONFLICT(operation_id,item_key) DO UPDATE SET state='succeeded',
        result_json=excluded.result_json,updated_at=excluded.updated_at`).bind(id,key,JSON.stringify(unit.result || {}),now,now));
      statements.push(sql.prepare(`INSERT INTO business_audit_events(operation_id,user_id,token_id,tool,item_key,effects_json,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?)`).bind(id,actor.user_id,actor.token_id || null,tool,key,JSON.stringify(unit.result?.effects || plan.effects || []),now,auditEnd));
      statements.push(sql.prepare(`UPDATE business_operations SET progress_completed=progress_completed+1, updated_at=? WHERE id=?`).bind(now,id));
      statements.push(sql.prepare('DELETE FROM business_mutation_guards WHERE operation_id=?').bind(id));
      try {
        await sql.batchAtomic(statements); claimed = true;
        stored.push(key);
      } catch (e) {
        if (!claimed && /UNIQUE constraint failed: business_operations/.test(e.message)) {
          return existing(tool, input, actor);
        }
        if (/CHECK constraint failed/.test(e.message)) {
          // 守卫失败不透露 SQL 或其它项目内容。
          const last = guards.find(g => g.code === 'CONFLICT') || guards[0];
          if (!claimed) throw new BusinessError(last.code, last.message || '版本或权限冲突，请重新读取');
          const current = await sql.prepare('SELECT status FROM business_operations WHERE id=?').get(id);
          if (['cancel_requested','cancelled'].includes(current?.status)) {
            unprocessed.push(...keys.slice(index).map(k => ({ key: k, reason: 'CANCELLED' }))); break;
          }
          failed.push({ key, code: last.code, message: last.message });
        } else {
          if (!claimed) throw e;
          failed.push({ key, code: 'DATA_UNAVAILABLE', message: '该单元未提交，请重新读取后重试' });
        }
        unprocessed.push(...keys.slice(index + 1).map(k => ({ key: k, reason: 'STOPPED_AFTER_FAILURE' }))); break;
      }
    }
    const status = failed.length || unprocessed.length ? 'partial' : 'succeeded';
    const summary = { status, unprocessed, failed, ...(plan.result || {}) };
    if (failed.length) await sql.prepare(`UPDATE business_operation_items SET state='failed',error_json=(SELECT value FROM json_each(?)
      WHERE json_extract(value,'$.key')=business_operation_items.item_key),updated_at=? WHERE operation_id=?
      AND item_key IN (SELECT json_extract(value,'$.key') FROM json_each(?))`).run(JSON.stringify(failed),now,id,JSON.stringify(failed));
    await sql.prepare(`UPDATE business_operations SET status=CASE WHEN status IN ('cancel_requested','cancelled') THEN 'cancelled' ELSE ? END,
      result_summary_json=json_set(?,'$.status',CASE WHEN status IN ('cancel_requested','cancelled') THEN 'cancelled' ELSE ? END),
      lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_id=?`)
      .run(status,JSON.stringify(summary),status,new Date().toISOString(),id,lease);
    const items = await sql.prepare(`SELECT i.item_key,i.state,i.result_json,i.error_json,o.status AS operation_status
      FROM business_operation_items i JOIN business_operations o ON o.id=i.operation_id WHERE i.operation_id=? ORDER BY i.rowid`).all(id);
    const finalStatus = items[0]?.operation_status || status;
    if (!await canExposeMutationItems(db, actor, items, projectIds)) return minimalReceipt({ id, status: finalStatus, progress_completed: stored.length });
    return receipt(id, items, summary, finalStatus);
  }
  return { mutate, run: (tool, input, actor, prepare) => mutate({ tool, input, actor, prepare }), existing };
}
module.exports = { createMutationService, validateIdempotencyKey, inputHash, canExposeMutationItems };
