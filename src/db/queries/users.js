// users.js —— 用户（团队模式下身份来自 Cloudflare Access，单用户模式下只有一个本机用户）

const { now } = require('../helpers');

module.exports = (db) => ({
  getUser: async (id) => db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id),
  getUserByEmail: async (email) => db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL').get(email),
  listUsers: async () => db.prepare('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC').all(),
  setUserRole: async (id, role) => {
    const info = await db.prepare('UPDATE users SET role = ? WHERE id = ? AND deleted_at IS NULL').run(role, id);
    return info.changes;
  },
  // 显示名（账号-名字关联，任务05修订）：空串/纯空格按 NULL 处理，回落显示邮箱
  setUserName: async (id, name) => {
    const info = await db.prepare('UPDATE users SET name = ? WHERE id = ? AND deleted_at IS NULL').run(String(name ?? '').trim() || null, id);
    return info.changes;
  },

  // 邮箱第一次出现：建号。全库第一个用户自动是 admin，并且认领此前所有
  // owner_user_id IS NULL 的存量数据（启用团队模式前建的项目，就是这么变成"我的"）——
  // 这个认领只在"库里一个用户都还没有"这一刻发生一次，之后新用户不会认领任何东西。
  // 建号和认领必须是原子的（batch）。认领语句里的新用户 id 用 email 子查询取——
  // email 有 UNIQUE 约束，后续语句用子查询取得同一事务内新建的账号。
  getOrCreateUser: async (email) => {
    email = String(email).trim().toLowerCase();
    const found = await db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE ORDER BY deleted_at IS NULL LIMIT 1').get(email);
    if (found) {
      if (found.deleted_at) return null;
      // 最近活跃按五分钟更新；权限仍每次读取，避免只读页面的每个请求都写数据库。
      const t = now();
      const cutoff = new Date(Date.parse(t) - 5 * 60_000).toISOString();
      if (!found.last_seen_at || found.last_seen_at < cutoff) {
        await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ? AND deleted_at IS NULL AND (last_seen_at IS NULL OR last_seen_at < ?)').run(t, found.id, cutoff);
        return (await db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(found.id)) || null;
      }
      return found;
    }
    const countRow = await db.prepare('SELECT COUNT(*) AS n FROM users').get();
    const isFirst = countRow.n === 0;
    const t = now();
    const statements = [db.prepare(
      'INSERT INTO users (email, role, created_at, last_seen_at) VALUES (?, ?, ?, ?)'
    ).bind(email, isFirst ? 'admin' : 'member', t, t)];
    if (isFirst) {
      for (const table of ['projects', 'tasks', 'links', 'google_accounts']) {
        statements.push(db.prepare(
          `UPDATE ${table} SET owner_user_id = (SELECT id FROM users WHERE email = ?) WHERE owner_user_id IS NULL`
        ).bind(email));
      }
    }
    await db.batch(statements);
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  },
});
