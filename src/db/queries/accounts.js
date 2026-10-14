// accounts.js —— 已连接的谷歌账号（google_accounts）

module.exports = (db) => ({
  // 普通用户只看自己连的账号，admin 看全部
  listAccounts: async ({ ownerUserId, isAdmin } = {}) => {
    const where = isAdmin ? '' : 'WHERE owner_user_id = ?';
    const params = isAdmin ? [] : [ownerUserId];
    return db.prepare(
      `SELECT id, email, note, connected_at, owner_user_id,
        (SELECT COUNT(*) FROM google_resources r WHERE r.account_id=google_accounts.id AND r.source='gsc' AND r.state='available') AS gsc_count,
        (SELECT COUNT(*) FROM google_resources r WHERE r.account_id=google_accounts.id AND r.source='ga4' AND r.state='available') AS ga4_count,
        (SELECT status FROM google_resource_sync_jobs j WHERE j.account_id=google_accounts.id ORDER BY j.created_at DESC,j.id DESC LIMIT 1) AS resource_sync_status,
        (SELECT updated_at FROM google_resource_sync_jobs j WHERE j.account_id=google_accounts.id ORDER BY j.created_at DESC,j.id DESC LIMIT 1) AS resource_sync_at
        FROM google_accounts ${where} ORDER BY connected_at DESC`
    ).all(...params);
  },
  getAccount: async (id) => db.prepare('SELECT * FROM google_accounts WHERE id = ?').get(id),
  getAccountByEmail: async (email) => db.prepare('SELECT * FROM google_accounts WHERE email = ?').get(email),

  // OAuth 跳转期间身份与归属都可能变化，凭据写入必须按同一语句中的当前权限决定。
  renewAccountAuthorization: async (id, actorId, refreshToken, connectedAt) => {
    const info = await db.prepare(`UPDATE google_accounts
      SET refresh_token=?,connected_at=?,auth_revision=auth_revision+1
      WHERE id=? AND EXISTS (SELECT 1 FROM users actor
        WHERE actor.id=? AND actor.deleted_at IS NULL
          AND (actor.role='admin' OR google_accounts.owner_user_id=actor.id))`
    ).run(refreshToken, connectedAt, id, actorId);
    return Number(info.changes);
  },

  // 删除账号时解绑所有引用它的项目，避免留下悬空 ID
  detachAccountFromProjects: async (accountId) => {
    const info = await db.prepare(`
      UPDATE projects SET
        account_id     = CASE WHEN account_id     = @id THEN NULL ELSE account_id     END,
        gsc_account_id = CASE WHEN gsc_account_id = @id THEN NULL ELSE gsc_account_id END,
        ga4_account_id = CASE WHEN ga4_account_id = @id THEN NULL ELSE ga4_account_id END
      WHERE account_id = @id OR gsc_account_id = @id OR ga4_account_id = @id`).run({ id: accountId });
    return Number(info.changes || 0);
  },
});
