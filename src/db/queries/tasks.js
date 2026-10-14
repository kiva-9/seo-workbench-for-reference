// tasks.js —— 任务

module.exports = (db) => ({
  // project_id 指定时，能看到项目（owner/协作者/admin）就能看到项目下全部任务——
  // 调用方（路由）已经用 canAccessProject 校验过一次，这里不重复按 task.owner_user_id
  // 过滤，否则协作者建的任务会在 owner 自己的任务列表里神隐。
  // project_id 不指定（看板“全部任务”视图）时才需要 tasks.owner_user_id：
  // 覆盖「不挂项目的任务」这个 owner 字段唯一说了算的场景，同时把「我拥有/协作的项目」
  // 下的任务也并进来，凑成"我能看到的全部任务"。
  listTasks: async (projectId, { ownerUserId, isAdmin } = {}) => {
    const order = 'ORDER BY t.due_date IS NULL, t.due_date ASC, t.created_at DESC';
    if (projectId) {
      return db.prepare(`SELECT t.* FROM tasks t WHERE t.project_id = @pid ${order}`).all({ pid: projectId });
    }
    if (isAdmin) return db.prepare(`SELECT t.* FROM tasks t ${order}`).all();
    return db.prepare(`
      SELECT t.* FROM tasks t
      WHERE (t.project_id IS NULL AND t.owner_user_id = @uid)
         OR t.project_id IN (
              SELECT id FROM projects WHERE owner_user_id = @uid
              UNION
              SELECT project_id FROM project_copywriters WHERE user_id = @uid AND revoked_at IS NULL
            )
      ${order}`).all({ uid: ownerUserId });
  },
  getTask: async (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id),
});
