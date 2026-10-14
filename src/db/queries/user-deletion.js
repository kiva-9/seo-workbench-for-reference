const { withAtomicGuard } = require('../../lib/atomic-guard');
const { now } = require('../helpers');

const ownershipTables = ['projects', 'tasks', 'links', 'google_accounts'];
const activeAdmin = "EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND deleted_at IS NULL)";
const canRemoveAdmin = "(role<>'admin' OR (SELECT COUNT(*) FROM users WHERE role='admin' AND deleted_at IS NULL)>1)";
const relatedProjects = `(SELECT project_id FROM project_copywriters WHERE user_id=? AND revoked_at IS NULL
  UNION SELECT project_id FROM tasks WHERE owner_user_id=? AND project_id IS NOT NULL
  UNION SELECT project_id FROM links WHERE owner_user_id=? AND project_id IS NOT NULL)`;

module.exports = (db) => ({
  userDeletionImpact: id => db.prepare(`SELECT ${ownershipTables.map(table =>
    `(SELECT COUNT(*) FROM ${table} WHERE owner_user_id=?) AS ${table}`).join(',')},
    (SELECT COUNT(*) FROM projects WHERE id IN ${relatedProjects} AND owner_user_id IS NOT ?) AS project_access`)
    .get(...ownershipTables.map(() => id), id, id, id, id),

  updateActiveUser: async (id, actorId, fields) => {
    const writes = [];
    if ('role' in fields) writes.push(db.prepare('UPDATE users SET role=? WHERE id=?').bind(fields.role, id));
    if ('name' in fields) writes.push(db.prepare('UPDATE users SET name=? WHERE id=?').bind(String(fields.name ?? '').trim() || null, id));
    // 删除与降级使用相同的实时管理员计数，两个请求不能合力移除最后一位管理员。
    const guard = `SELECT ${activeAdmin} AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL
      AND (?<>'member' OR ${canRemoveAdmin}))`;
    await db.batchAtomic(withAtomicGuard(db, writes, guard, [actorId, id, fields.role ?? '']));
  },

  deleteUserAndTransfer: async (id, recipientId, actorId) => {
    const at = now();
    const writes = ownershipTables.map(table => db.prepare(`UPDATE ${table} SET owner_user_id=? WHERE owner_user_id=?`).bind(recipientId, id));
    // 在转移个人记录的归属前取得相关项目范围，接收人才能继续维护项目中的任务和链接。
    writes.unshift(db.prepare(`INSERT INTO project_copywriters(project_id,user_id,created_at)
      SELECT p.id,?,? FROM projects p WHERE p.id IN ${relatedProjects} AND p.owner_user_id IS NOT ? AND p.owner_user_id IS NOT ?
      ON CONFLICT(project_id,user_id) DO UPDATE SET revoked_at=NULL WHERE project_copywriters.revoked_at IS NOT NULL`)
      .bind(recipientId, at, id, id, id, id, recipientId));
    writes.push(
      db.prepare('UPDATE project_copywriters SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(at, id),
      db.prepare('UPDATE mcp_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(at, id),
      db.prepare(`UPDATE business_operations SET status='cancelled',lease_id=NULL,lease_expires_at=NULL,
        error_json=?,updated_at=? WHERE user_id=? AND status IN ('queued','running','cancel_requested')`)
        .bind(JSON.stringify({ code: 'ACCOUNT_DELETED', message: '创建账号已删除' }), at, id),
      db.prepare(`UPDATE google_resource_sync_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,
        errors_json=?,updated_at=?,finished_at=? WHERE requested_by=? AND status IN ('queued','running')`)
        .bind(JSON.stringify([{ code: 'ACCOUNT_DELETED', message: '创建账号已删除' }]), at, at, id),
      db.prepare('UPDATE users SET deleted_at=?,deleted_by=?,transferred_to_user_id=? WHERE id=?').bind(at, actorId, recipientId, id)
    );
    // 守卫与所有归属变更在同一个事务内；接收人、操作者或目标的权限变化会整批回滚。
    const guard = `SELECT ${activeAdmin} AND ?<>? AND ?<>?
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL AND ${canRemoveAdmin})`;
    const result = await db.batchAtomic(withAtomicGuard(db, writes, guard,
      [actorId, id, actorId, id, recipientId, recipientId, id]));
    return { ...Object.fromEntries(ownershipTables.map((table, index) => [table, Number(result[index + 2].changes)])), project_access: Number(result[1].changes) };
  },
});
