// projects.js —— 项目与项目访问权限
// 项目成员 = owner + 文案师名单（project_copywriters，在册）——2026-09-28 起协作者身份废弃，
// 访问校验和列表可见性都只认名单（旧 project_collaborators 表留档到任务15）。

// 旧列保留在存量数据库中，当前业务接口只提供需要维护的项目资料。
const retiredFields = new Set(['client_name', 'industry', 'monthly_fee', 'contract_start', 'contract_end']);
const projectData = row => row && Object.fromEntries(Object.entries(row).filter(([key]) => !retiredFields.has(key)));
const { withAtomicGuard } = require('../../lib/atomic-guard');
module.exports = (db) => ({
  transferProjectOwner: async (id, ownerId, actorId) => db.batchAtomic(withAtomicGuard(db, [
    db.prepare('UPDATE projects SET owner_user_id=? WHERE id=?').bind(ownerId, id),
  ], `SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL AND role='admin')
    AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)`, [actorId, ownerId])),
  // 普通用户看自己 owner 的 + 在册文案师的，admin 看全部
  listProjects: async ({ ownerUserId, isAdmin } = {}) => {
    if (isAdmin) return (await db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all()).map(projectData);
    return (await db.prepare(
      `SELECT * FROM projects
       WHERE owner_user_id = @uid
          OR id IN (SELECT project_id FROM project_copywriters WHERE user_id = @uid AND revoked_at IS NULL)
       ORDER BY created_at DESC`
    ).all({ uid: ownerUserId })).map(projectData);
  },
  getProject: async (id) => projectData(await db.prepare('SELECT * FROM projects WHERE id = ?').get(id)),

  // 删除项目及其名下全部数据。语句相互独立、不需要中间结果，合成一个原子 batch
  // 子表先删，覆盖没有级联外键的早期表。
  deleteProject: async (id) => {
    await db.batch([
      db.prepare('DELETE FROM tasks WHERE project_id = ?').bind(id),
      db.prepare('DELETE FROM links WHERE project_id = ?').bind(id),
      db.prepare('DELETE FROM gsc_snapshot_queries WHERE snapshot_id IN (SELECT id FROM gsc_snapshots WHERE project_id = ?)').bind(id),
      db.prepare('DELETE FROM gsc_snapshot_urls WHERE snapshot_id IN (SELECT id FROM gsc_snapshots WHERE project_id = ?)').bind(id),
      db.prepare('DELETE FROM gsc_snapshots WHERE project_id = ?').bind(id),
      db.prepare('DELETE FROM url_metrics WHERE project_id = ?').bind(id),
      db.prepare('DELETE FROM ga4_metrics WHERE project_id = ?').bind(id),
      db.prepare('DELETE FROM urls WHERE project_id = ?').bind(id),
      db.prepare('DELETE FROM external_links WHERE project_id = ?').bind(id),
      db.prepare('DELETE FROM project_collaborators WHERE project_id = ?').bind(id),
      // 新表：子表 → 文章 → 名单/同步状态（子表没有 project_id，经 article_id 关联）
      db.prepare('DELETE FROM project_article_monthly_metrics WHERE article_id IN (SELECT id FROM project_articles WHERE project_id = ?)').bind(id),
      db.prepare('DELETE FROM project_article_url_history WHERE article_id IN (SELECT id FROM project_articles WHERE project_id = ?)').bind(id),
      db.prepare('DELETE FROM project_articles WHERE project_id = ?').bind(id),
      db.prepare('DELETE FROM project_copywriters WHERE project_id = ?').bind(id),
      db.prepare('DELETE FROM project_monitor_sync_state WHERE project_id = ?').bind(id),
      // 外链新表（任务10）：子表先删，不留孤儿
      db.prepare('DELETE FROM project_external_article_freezes WHERE project_id = ?').bind(id),
      db.prepare('DELETE FROM project_external_daily_metrics WHERE project_id = ?').bind(id),
      db.prepare('DELETE FROM project_external_month_state WHERE project_id = ?').bind(id),
      db.prepare('DELETE FROM project_external_articles WHERE project_id = ?').bind(id),
      db.prepare('DELETE FROM projects WHERE id = ?').bind(id),
    ]);
    return true;
  },

  // 是否有权访问该项目：owner 本人、在册文案师、或 admin（isAdmin 由调用方传入）
  canAccessProject: async (projectId, userId, isAdmin) => {
    if (isAdmin) return true;
    const p = await db.prepare('SELECT owner_user_id FROM projects WHERE id = ?').get(projectId);
    if (!p) return false;
    if (p.owner_user_id === userId) return true;
    const row = await db.prepare(
      'SELECT 1 FROM project_copywriters WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL'
    ).get(projectId, userId);
    return Boolean(row);
  },
});
