// 一次读取可访问项目与名单，避免监控首屏按项目逐个请求。
module.exports = (db) => ({
  listMonitorOptions: async ({ userId, isAdmin }) => {
    const scope = isAdmin ? '1 = 1' : `(p.owner_user_id = @uid OR EXISTS (
      SELECT 1 FROM project_copywriters member
      WHERE member.project_id = p.id AND member.user_id = @uid AND member.revoked_at IS NULL
    ))`;
    const bind = (sql) => isAdmin ? db.prepare(sql).bind() : db.prepare(sql).bind({ uid: userId });
    const [projects, copywriters] = await db.batch([
      bind(`SELECT p.id, p.name FROM projects p WHERE ${scope} ORDER BY p.created_at DESC, p.id DESC`),
      bind(`SELECT c.id, c.project_id, c.user_id, u.email, u.name,
        CASE WHEN c.revoked_at IS NULL THEN 1 ELSE 0 END AS is_member
        FROM project_copywriters c JOIN projects p ON p.id = c.project_id JOIN users u ON u.id = c.user_id
        WHERE ${scope} ORDER BY c.id`),
    ]);
    return { projects: projects.results, copywriters: copywriters.results };
  },
});
