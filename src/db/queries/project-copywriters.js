// project-copywriters.js —— 项目文案师名单：账号引用、指派与授权（任务05，2026-09-28 修订）
//
// 产品模型（用户 2026-09-28 两次修订后）：
//   - 项目只有一个角色：文案师。名单即成员、成员即访问权限——没有「协作者」这个第二身份
//     （访问校验、列表可见性全部认 project_copywriters，协作者表已废弃）。
//   - 账号与名字关联：users.name 由 admin 配置，界面显示「名字（邮箱）」，回落邮箱。
//   - 指派文案师 = 授予与 owner 同等的项目权限：本应用 owner 与在册文案师业务权限完全
//     等价（admin 专属操作除外），所以「在册」本身就是权限，不需要额外的授权写入。
//   - 候选 = 全部已有登录账号（启用即入册）；不建号、不改角色、不改邮箱。
//   - revoked_at：NULL = 在册。移出时打 revoked_at（收回全部权限）；有历史文章引用的
//     行保留（外键指向它，署名不断），无引用的行直接删。重新启用 = 清除 revoked_at，
//     复用原行，历史引用不断。
//
// api.js 用展开符合并模块，方法不依赖 this——共用逻辑写成工厂内闭包函数。

const { runUnitBatch } = require('../../lib/unit-batch');
const { withAtomicGuard } = require('../../lib/atomic-guard');

module.exports = (db) => {
  // 指派前预检：文章是否都属于该项目、名单项是否在册。
  // 任一不过 → ok:false + rejected ids，路由整批零写（越权/无效目标不写第一行）。
  async function checkAssignment(projectId, articleIds, copywriterId) {
    const ids = [...new Set((articleIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return { ok: false, reason: '没有指定文章', rejected: [] };
    const named = { pid: projectId, ids: JSON.stringify(ids) };
    const own = await db.prepare(
      `SELECT id FROM project_articles WHERE project_id = @pid AND id IN (SELECT value FROM json_each(@ids))`
    ).all(named);
    const ownIds = new Set(own.map((r) => Number(r.id)));
    const missing = ids.filter((id) => !ownIds.has(id));
    if (missing.length) return { ok: false, reason: '这些文章不属于该项目', rejected: missing };

    if (copywriterId != null) {
      // 在册才可派：revoked 的历史项只读（保留署名，不再接收新指派）
      const active = await db.prepare(
        'SELECT 1 AS ok FROM project_copywriters WHERE project_id = @pid AND id = @cid AND revoked_at IS NULL'
      ).get({ pid: projectId, cid: copywriterId });
      if (!active) return { ok: false, reason: '文案师不在本项目名单里（或已移出）', rejected: [] };
    }
    return { ok: true, articleIds: ids };
  }

  return {
  // 名单 + 账号邮箱/名字 + 引用计数 + 在册状态（revoked 行标「已移出项目」）
  listProjectCopywriters: async (projectId) => db.prepare(
    'SELECT c.*, u.email, u.name, u.deleted_at AS account_deleted_at, ' +
    '(SELECT COUNT(*) FROM project_articles a WHERE a.project_id = c.project_id AND a.copywriter_id = c.id) AS article_count, ' +
    'CASE WHEN c.revoked_at IS NULL THEN 1 ELSE 0 END AS is_member ' +
    'FROM project_copywriters c JOIN users u ON u.id = c.user_id ' +
    'WHERE c.project_id = @pid ORDER BY c.id'
  ).all({ pid: projectId }),

  findProjectCopywriter: async (projectId, id) =>
    db.prepare('SELECT c.*, u.email, u.name FROM project_copywriters c JOIN users u ON u.id = c.user_id WHERE c.project_id = ? AND c.id = ?').get(projectId, id),

  findProjectCopywriterByUser: async (projectId, userId) =>
    db.prepare('SELECT * FROM project_copywriters WHERE project_id = ? AND user_id = ?').get(projectId, userId),

  // 候选 = 全部已有登录账号；on_roster = 在册（revoked 的人显示可重新启用）。
  // 只暴露 id/email/name；调用方已过项目访问校验。
  listCopywriterCandidates: async (projectId) => db.prepare(
    'SELECT u.id, u.email, u.name, ' +
    'EXISTS (SELECT 1 FROM project_copywriters c WHERE c.project_id = @pid AND c.user_id = u.id AND c.revoked_at IS NULL) AS on_roster ' +
    'FROM users u WHERE u.deleted_at IS NULL ORDER BY u.id'
  ).all({ pid: projectId }),

  countArticleReferences: async (projectId, copywriterId) =>
    Number((await db.prepare(
      'SELECT COUNT(*) AS n FROM project_articles WHERE project_id = ? AND copywriter_id = ?'
    ).get(projectId, copywriterId)).n),

  // 站内外共用引用检查（任务10）：外链文章的引用也挡移除
  countExternalArticleReferences: async (projectId, copywriterId) =>
    Number((await db.prepare(
      'SELECT COUNT(*) AS n FROM project_external_articles WHERE project_id = ? AND copywriter_id = ?'
    ).get(projectId, copywriterId)).n),

  // 启用（幂等）：入册即授权。三条语句同一原子单元——先看在册状态，再入册/复册，
  // 最后回读。并发双点也只会有一行；revoked 行被复用时清除 revoked_at。
  enableCopywriter: async (projectId, userId, at) => {
    const [, pre, upsert, sel] = await db.batchAtomic(withAtomicGuard(db, [
      db.prepare(
        'SELECT id, revoked_at FROM project_copywriters WHERE project_id = @pid AND user_id = @uid'
      ).bind({ pid: projectId, uid: userId }),
      db.prepare(
        'INSERT INTO project_copywriters (project_id, user_id, created_at) VALUES (@pid, @uid, @at) ' +
        'ON CONFLICT(project_id, user_id) DO UPDATE SET revoked_at = NULL ' +
        'WHERE project_copywriters.revoked_at IS NOT NULL'
      ).bind({ pid: projectId, uid: userId, at }),
      db.prepare('SELECT * FROM project_copywriters WHERE project_id = @pid AND user_id = @uid').bind({ pid: projectId, uid: userId }),
    ], 'SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)', [userId]));
    const existed = pre.results.length > 0;
    return {
      id: Number(sel.results[0].id),
      created: !existed,
      reactivated: existed && pre.results[0].revoked_at !== null,
    };
  },

  // 移出（= 收回权限）：先打 revoked_at，无历史引用的行顺势删掉。同一个原子单元。
  // 有引用的行保留（外键指向它），列表标「已移出项目」；绝不碰 users。
  removeCopywriter: async (projectId, copywriterId, at) => {
    const [refs, revoke, del] = await db.batchAtomic([
      // 站内外两类文章的引用一起数（任务10 起外链引用同样挡移除）
      db.prepare(
        'SELECT (SELECT COUNT(*) FROM project_articles WHERE project_id = @pid AND copywriter_id = @cid) + ' +
        '(SELECT COUNT(*) FROM project_external_articles WHERE project_id = @pid AND copywriter_id = @cid) AS n'
      ).bind({ pid: projectId, cid: copywriterId }),
      db.prepare(
        'UPDATE project_copywriters SET revoked_at = @at WHERE project_id = @pid AND id = @cid AND revoked_at IS NULL'
      ).bind({ pid: projectId, cid: copywriterId, at }),
      db.prepare(
        'DELETE FROM project_copywriters WHERE project_id = @pid AND id = @cid ' +
        'AND NOT EXISTS (SELECT 1 FROM project_articles WHERE project_id = @pid AND copywriter_id = @cid) ' +
        'AND NOT EXISTS (SELECT 1 FROM project_external_articles WHERE project_id = @pid AND copywriter_id = @cid)'
      ).bind({ pid: projectId, cid: copywriterId }),
    ]);
    return {
      removed: Number(del.changes) > 0,
      revoked: Number(revoke.changes) > 0,
      references: Number(refs.results[0].n),
    };
  },

  checkAssignment,

  // 集合 UPDATE 指派。mode='fill_empty'（默认）只填空置，'overwrite' 覆盖。
  // copywriter_id 传 null = 明确清空归属。全部文章作为一个原子业务单元提交，
  // 并报告成功/失败/未处理。调用前先过 checkAssignment。
  assignArticlesCopywriter: async (projectId, articleIds, copywriterId, mode = 'fill_empty', at = null) => {
    const check = await checkAssignment(projectId, articleIds, copywriterId);
    if (!check.ok) return { ok: false, reason: check.reason, rejected: check.rejected || [], updated: 0, succeeded: [], failed: [], unprocessed: [] };
    const fillOnly = mode !== 'overwrite';
    const named = { pid: projectId, cw: copywriterId ?? null, at, ids: JSON.stringify(check.articleIds) };
    const sql = `UPDATE project_articles SET copywriter_id = @cw, updated_at = @at
      WHERE project_id = @pid AND id IN (SELECT value FROM json_each(@ids))
        AND (@cw IS NULL
          OR EXISTS (SELECT 1 FROM project_copywriters c
                     WHERE c.project_id = @pid AND c.id = @cw AND c.revoked_at IS NULL))
      ${fillOnly ? 'AND copywriter_id IS NULL' : ''}`;
    const units = [{ ids: check.articleIds, statements: [db.prepare(sql).bind(named)] }];
    let updated = 0;
    const result = await runUnitBatch(units, async (u) => {
      const r = await db.batchAtomic(u.statements);
      updated += Number(r[0].changes || 0);
    });
    return { ok: result.failed.length === 0, updated, ...result };
  },
  };
};
