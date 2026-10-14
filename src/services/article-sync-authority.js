const createDbApi = require('../db/api');
const { withAtomicGuard } = require('../lib/atomic-guard');
const { fail } = require('./mcp-common');

// 权限、队列租约和提交时的取数修订须与每笔业务写入处于同一事务。
function articleSyncAuthority(db, job, state) {
  const backend = db.db;
  const sql = `SELECT EXISTS(SELECT 1 FROM article_monitor_sync_jobs j
    JOIN projects p ON p.id=j.project_id JOIN users u ON u.id=j.created_by AND u.deleted_at IS NULL
    WHERE j.job_id=? AND j.status='running' AND j.lease_id=? AND j.lease_until>?
      AND p.config_revision=?
      AND (u.role='admin' OR p.owner_user_id=u.id OR EXISTS(SELECT 1 FROM project_copywriters c
        WHERE c.project_id=p.id AND c.user_id=u.id AND c.revoked_at IS NULL))
      AND NOT EXISTS(SELECT 1 FROM json_each(?) snapshot WHERE NOT EXISTS(
        SELECT 1 FROM project_articles a WHERE a.id=json_extract(snapshot.value,'$.id')
          AND a.project_id=p.id AND a.status='active' AND a.fetch_revision=json_extract(snapshot.value,'$.revision'))))`;
  const args = () => [job.job_id, job.lease_id, new Date().toISOString(), state.configRevision, JSON.stringify(state.articles)];
  async function check() {
    if (!Number(Object.values(await backend.prepare(sql).get(...args()))[0]))
      fail('CONFLICT', '同步权限、文章或配置已变化，请核查后重新同步');
  }
  async function atomic(statements) {
    const result = await backend.batchAtomic(withAtomicGuard(backend, statements, sql, args()));
    return result.slice(1, -1);
  }
  const wrapped = {
    prepare(query) {
      const prepared = backend.prepare(query);
      return { ...prepared, run: async (...values) => (await atomic([prepared.bind(...values)]))[0] };
    },
    batch: atomic, batchAtomic: atomic,
    exec() { throw new Error('后台同步禁止未受守卫的脚本'); },
  };
  return { db: createDbApi(wrapped), check, atomic };
}
module.exports = { articleSyncAuthority };
