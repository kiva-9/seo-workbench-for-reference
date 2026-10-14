const { withAtomicGuard } = require('../../lib/atomic-guard');

module.exports = db => ({
  getDeletedUser: id => db.prepare('SELECT id, email, name, deleted_at FROM users WHERE id=? AND deleted_at IS NOT NULL').get(id),
  listDeletedUsers: () => db.prepare(`SELECT id, email, name, created_at, deleted_at FROM users
    WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC`).all(),

  restoreDeletedUser: async (id, actorId) => {
    // 只重新开放登录身份；归属、项目资格、已撤销 Token 和取消任务保留删除后的状态。
    const statements = [
      db.prepare("UPDATE users SET deleted_at=NULL, role='member', last_seen_at=NULL WHERE id=?").bind(id),
      db.prepare('SELECT * FROM users WHERE id=?').bind(id),
    ];
    const guard = `SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND deleted_at IS NULL)
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NOT NULL)`;
    const result = await db.batchAtomic(withAtomicGuard(db, statements, guard, [actorId, id]));
    return result[2].results[0];
  },
});
