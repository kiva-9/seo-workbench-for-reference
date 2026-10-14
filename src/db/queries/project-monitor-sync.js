// project-monitor-sync.js —— 项目级同步状态的访问层（任务04交付结构；编排在任务07）
// 认领/释放都走「条件写 + 检查影响行数」：同项目重入返回正在刷新，
// 到期由下一次用户请求恢复，不写定时消费代码。
// run_id 与配置指纹/文章修订一起，是旧响应晚到的写入守卫（任务07的条件写复用同模式）。
//
// 迁移只给存量项目种子状态行；迁移后新建的项目靠这里的 UPSERT 自愈
// （缺行时首次认领/推进修订即补建，不会因为漏种子把守卫静默失效）。

module.exports = (db) => ({
  getMonitorSyncState: async (projectId) =>
    db.prepare('SELECT * FROM project_monitor_sync_state WHERE project_id = ?').get(projectId),

  // 认领：INSERT … ON CONFLICT 自愈缺行；仅当没有运行中的标识、或租约已过期才认下。
  // 返回 affected 行数（1=认领成功，0=正在刷新/租约未到期），调用方据此回「正在刷新」。
  // 整句一个原子语句，不先查再无条件写。
  claimMonitorSyncState: async (projectId, { runId, leaseUntil, at }) => {
    const info = await db.prepare(
      'INSERT INTO project_monitor_sync_state ' +
      '(project_id, run_id, lease_until, config_revision, registry_revision, last_attempt_at, updated_at) ' +
      'VALUES (@projectId, @runId, @leaseUntil, 1, 1, @at, @at) ' +
      'ON CONFLICT(project_id) DO UPDATE SET ' +
      'run_id = excluded.run_id, lease_until = excluded.lease_until, ' +
      'last_attempt_at = excluded.last_attempt_at, updated_at = excluded.updated_at ' +
      'WHERE project_monitor_sync_state.run_id IS NULL ' +
      '   OR project_monitor_sync_state.lease_until IS NULL ' +
      '   OR project_monitor_sync_state.lease_until < excluded.updated_at'
    ).run({ projectId, runId, leaseUntil, at });
    return Number(info.changes || 0);
  },

  // 释放：只有持锁者能清（旧执行者晚到不得清掉新变更）；成功释放才记 last_success_at
  releaseMonitorSyncState: async (projectId, { runId, at, lastError = null, markSuccess = true }) => {
    const info = await db.prepare(
      'UPDATE project_monitor_sync_state ' +
      'SET run_id = NULL, lease_until = NULL, last_error = @lastError, ' +
      'last_success_at = CASE WHEN @lastError IS NULL AND @markSuccess THEN @at ELSE last_success_at END, ' +
      'updated_at = @at WHERE project_id = @projectId AND run_id = @runId'
    ).run({ projectId, runId, at, lastError, markSuccess: markSuccess ? 1 : 0 });
    return Number(info.changes || 0);
  },

  // 登记修订推进：URL/启停等登记变更时 +1（缺行自愈），配置修订同理
  bumpRegistryRevision: async (projectId, at) => {
    const info = await db.prepare(
      'INSERT INTO project_monitor_sync_state (project_id, registry_revision, updated_at) ' +
      "VALUES (@projectId, 2, @at) " +
      'ON CONFLICT(project_id) DO UPDATE SET ' +
      'registry_revision = project_monitor_sync_state.registry_revision + 1, updated_at = @at'
    ).run({ projectId, at });
    return Number(info.changes || 0);
  },

  bumpConfigRevision: async (projectId, at) => {
    const info = await db.prepare(
      'INSERT INTO project_monitor_sync_state (project_id, config_revision, updated_at) ' +
      "VALUES (@projectId, 2, @at) " +
      'ON CONFLICT(project_id) DO UPDATE SET ' +
      'config_revision = project_monitor_sync_state.config_revision + 1, updated_at = @at'
    ).run({ projectId, at });
    return Number(info.changes || 0);
  },
});
