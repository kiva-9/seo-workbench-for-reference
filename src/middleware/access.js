// access.js —— 项目访问校验（多个路由共用）

// 项目访问校验：owner 本人 / 协作者 / admin 之一才能通过。找不到项目 404，无权限 403。
// 通过后把项目对象挂到 req.project，避免调用方重复查一遍。
// 返回项目对象；不通过时已经写好响应，返回 null。调用方需要 await。
module.exports = function createProjectGuard(db) {
  return async function assertProjectAccess(req, res, projectId) {
    const project = await db.getProject(projectId);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return null; }
    const isAdmin = req.user.role === 'admin';
    if (!(await db.canAccessProject(projectId, req.user.id, isAdmin))) {
      res.status(403).json({ error: '无权访问该项目' });
      return null;
    }
    req.project = project;
    return project;
  };
};
