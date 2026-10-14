// article-title-fetch.js —— 标题抓取的数据库访问（URL 缓存租约 + 文章状态位）
//
// 契约：
//   - 同一 URL 全局只抓一次：article_title_fetches 是缓存；租约防并发重复出网。
//   - 文章行的写入永远带守卫：只有「标题为空、非人工、status=pending」的行会被写，
//     所以人工清空/人工标题/改址后的旧任务都不会覆盖新状态。
//   - 失败只记原因并累加尝试次数；达到 3 次转终态 failed（不再自动重试，
//     但单篇「获取标题」与项目按钮可显式重新武装）。

const { now } = require('../helpers');

const MAX_ATTEMPTS = 3;
const CLAIM_LEASE_MINUTES = 1;

const TABLES = {
  internal: { table: 'project_articles', revision: 'fetch_revision' },
  external: { table: 'project_external_articles', revision: 'registry_revision' },
};

function invalidKind(kind) {
  return new Error('kind 必须是 internal 或 external');
}

module.exports = (db) => ({
  // ============ URL 缓存与租约 ============

  getTitleCache: async (url) => db.prepare('SELECT * FROM article_title_fetches WHERE url = ?').get(url),

  // 认领一个 URL 的抓取权。返回 token；抢不到（已有进行中的认领或已缓存）返回 null。
  claimTitleUrl: async (url, token) => {
    const info = await db.prepare(
      `INSERT INTO article_title_fetches (url, claim_token, claimed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET claim_token = excluded.claim_token, claimed_at = excluded.claimed_at
       WHERE article_title_fetches.title IS NULL
         AND (article_title_fetches.claim_token IS NULL
              OR julianday(article_title_fetches.claimed_at) < julianday('now', '-1 minute'))`
    ).run(url, token, now());
    return Number(info.changes || 0) > 0 ? token : null;
  },

  // 只有当前租约持有人可完成缓存，过期请求不能清掉新租约。
  saveTitleCache: async (url, title, token) => {
    const info = await db.prepare(
      `UPDATE article_title_fetches SET title = ?, claim_token = NULL, claimed_at = NULL, updated_at = ?
       WHERE url = ? AND claim_token = ?`
    ).run(title, now(), url, token);
    return Number(info.changes || 0);
  },

  releaseTitleClaim: async (url, token) => {
    const info = await db.prepare(
      'UPDATE article_title_fetches SET claim_token = NULL, claimed_at = NULL, updated_at = ? WHERE url = ? AND claim_token = ?'
    ).run(now(), url, token);
    return Number(info.changes || 0);
  },

  // ============ 文章行状态 ============

  // 该项目该类型「待抓标题」的文章：启用 + 标题为空 + 非人工 + 未终态失败 + 尝试未耗尽
  listTitlePendingArticles: async (projectId, kind) => {
    const t = TABLES[kind];
    if (!t) throw invalidKind(kind);
    return db.prepare(
      `SELECT id, url FROM ${t.table}
       WHERE project_id = ? AND status = 'active'
         AND (title IS NULL OR TRIM(title) = '')
         AND title_source IS NOT 'manual'
         AND (title_fetch_status IS NULL OR title_fetch_status = 'pending')
         AND title_fetch_attempts < ?`
    ).all(projectId, MAX_ATTEMPTS);
  },

  // 武装待抓行：清人工来源标记、置 pending、清上次错误。
  // attempts 不动——重试预算跨点击累计，
  // 只有显式的「继续获取/单篇重试」才归零（rearmTitleFetch）。
  armTitleFetch: async (articleIds, kind) => {
    const t = TABLES[kind];
    if (!t) throw invalidKind(kind);
    if (!articleIds.length) return 0;
    const ph = articleIds.map(() => '?').join(',');
    const info = await db.prepare(
      `UPDATE ${t.table}
       SET title_source = NULL, title_fetch_status = 'pending',
           title_fetch_error = NULL, updated_at = ?
       WHERE id IN (${ph}) AND status = 'active' AND (title IS NULL OR TRIM(title) = '') AND title_source IS NOT 'manual'`
    ).run(now(), ...articleIds);
    return Number(info.changes || 0);
  },

  getArticleForTitle: async (articleId, kind) => {
    const t = TABLES[kind];
    if (!t) throw invalidKind(kind);
    return db.prepare(`SELECT * FROM ${t.table} WHERE id = ?`).get(articleId);
  },

  // 抓取结果绑定读取时的文章快照，改址、停用和人工编辑之后的旧结果全部丢弃。
  writeFetchedTitle: async (article, kind, title) => {
    const t = TABLES[kind];
    if (!t) throw invalidKind(kind);
    const info = await db.prepare(
      `UPDATE ${t.table}
       SET title = ?, title_source = 'fetched', title_fetch_status = 'ok', title_fetch_error = NULL,
           title_fetched_at = ?, updated_at = ?
       WHERE id = ? AND url = ? AND ${t.revision} = ? AND updated_at IS ?
         AND status = 'active' AND title_fetch_status = 'pending'
         AND (title IS NULL OR TRIM(title) = '') AND title_source IS NOT 'manual'`
    ).run(title, now(), now(), article.id, article.url, article[t.revision], article.updated_at);
    return Number(info.changes || 0);
  },

  writeTitleFailure: async (article, kind, reason) => {
    const t = TABLES[kind];
    if (!t) throw invalidKind(kind);
    const at = now();
    const info = await db.prepare(
      `UPDATE ${t.table}
       SET title_fetch_attempts = MIN(title_fetch_attempts + 1, ?),
           title_fetch_status = CASE WHEN title_fetch_attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
           title_fetch_error = ?, title_fetched_at = ?, updated_at = ?
       WHERE id = ? AND url = ? AND ${t.revision} = ? AND updated_at IS ?
         AND status = 'active' AND title_fetch_status = 'pending'
         AND (title IS NULL OR TRIM(title) = '') AND title_source IS NOT 'manual'`
    ).run(MAX_ATTEMPTS, MAX_ATTEMPTS, reason, at, at, article.id, article.url, article[t.revision], article.updated_at);
    return Number(info.changes || 0);
  },

  // 单篇重试：重新武装（attempts 归零）后由调用方立即抓。
  // 守卫用「读取文章时的快照」（title_source + updated_at）：排队后发生的人工修改/
  // 人工清空/停用/删除/改 URL 优先于这次重试；只摆平需要重摆的行（已 pending 的不动）。
  rearmTitleFetch: async (articleId, kind, snapshot = {}) => {
    const t = TABLES[kind];
    if (!t) throw invalidKind(kind);
    const info = await db.prepare(
      `UPDATE ${t.table}
       SET title_source = NULL, title_fetch_status = 'pending', title_fetch_attempts = 0,
           title_fetch_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'active' AND (title IS NULL OR TRIM(title) = '')
         AND title_source IS ? AND updated_at IS ?
         AND (title_fetch_status IS NOT 'pending' OR title_source IS 'manual')`
    ).run(now(), articleId, snapshot.titleSource ?? null, snapshot.updatedAt ?? null);
    return Number(info.changes || 0);
  },
});

module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
module.exports.CLAIM_LEASE_MINUTES = CLAIM_LEASE_MINUTES;
