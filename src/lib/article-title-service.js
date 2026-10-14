// 标题抓取在用户请求内完成；URL 缓存共享，文章写回必须匹配抓取前的快照。
const { randomUUID } = require('node:crypto');
const { fetchArticleTitle } = require('./article-title-fetch');
const { MAX_ATTEMPTS } = require('../db/queries/article-title-fetch');

const MAX_URLS_PER_RUN = 30;
const RUN_DEADLINE_MS = 60_000;
const eligible = (article, url) => article && article.url === url && article.status === 'active'
  && !String(article.title || '').trim() && article.title_source !== 'manual' && article.title_fetch_status === 'pending';

// 返回真正写入的行数，人工编辑、改址或停用后的旧响应只计入 skipped。
async function writeOutcome(db, kind, articles, outcome) {
  let applied = 0;
  for (const article of articles) {
    applied += outcome.title != null
      ? await db.writeFetchedTitle(article, kind, outcome.title)
      : await db.writeTitleFailure(article, kind, outcome.error || 'unknown');
  }
  return applied;
}

async function fetchOneUrl(db, kind, url, articles, deadline) {
  const cached = await db.getTitleCache(url);
  if (cached?.title) return { title: cached.title, via: 'cache', applied: await writeOutcome(db, kind, articles, cached) };
  const token = randomUUID();
  const claimed = await db.claimTitleUrl(url, token);
  if (!claimed) {
    const fresh = await db.getTitleCache(url);
    if (fresh?.title) return { title: fresh.title, via: 'cache', applied: await writeOutcome(db, kind, articles, fresh) };
    return { busy: true, applied: 0 };
  }
  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { remaining: true, applied: 0 };
    const outcome = await fetchArticleTitle(url, { timeoutMs: remaining });
    // 租约已被接管时，旧请求既不能覆盖缓存，也不能改变文章的标题状态。
    const owned = outcome.title != null
      ? await db.saveTitleCache(url, outcome.title, token)
      : await db.releaseTitleClaim(url, token);
    if (!owned) return { superseded: true, applied: 0 };
    return { ...outcome, applied: await writeOutcome(db, kind, articles, outcome) };
  } finally {
    await db.releaseTitleClaim(url, token);
  }
}

async function runProjectTitleFetch(db, projectId, kind) {
  const started = Date.now();
  const summary = { ok: true, attempted: 0, fetched: 0, failed: 0, busy: 0, skipped: 0, remaining: 0, partial: false, errors: [], durationMs: 0 };
  const deadline = started + RUN_DEADLINE_MS;
  try {
    const pending = await db.listTitlePendingArticles(projectId, kind);
    if (!pending.length) { summary.reason = 'empty'; return summary; }
    const byUrl = new Map();
    for (const row of pending) {
      if (!byUrl.has(row.url)) byUrl.set(row.url, []);
      byUrl.get(row.url).push(Number(row.id));
    }
    const urls = [...byUrl.keys()].slice(0, MAX_URLS_PER_RUN);
    summary.remaining = byUrl.size - urls.length;
    await db.armTitleFetch(urls.flatMap((url) => byUrl.get(url)), kind);
    for (let i = 0; i < urls.length; i++) {
      if (Date.now() >= deadline) { summary.remaining += urls.length - i; break; }
      const url = urls[i];
      const rows = await Promise.all(byUrl.get(url).map((id) => db.getArticleForTitle(id, kind)));
      const articles = rows.filter((row) => eligible(row, url));
      summary.skipped += rows.length - articles.length;
      if (!articles.length) continue;
      summary.attempted++;
      const outcome = await fetchOneUrl(db, kind, url, articles, deadline);
      if (outcome.busy) { summary.busy++; continue; }
      if (outcome.remaining) { summary.remaining++; continue; }
      summary.skipped += articles.length - outcome.applied;
      if (outcome.title != null) summary.fetched += outcome.applied;
      else if (outcome.applied) {
        summary.failed += outcome.applied;
        summary.errors.push({ url, error: outcome.error || 'unknown' });
      }
    }
    summary.partial = summary.remaining > 0;
    summary.ok = summary.failed === 0;
    return summary;
  } catch (error) {
    summary.ok = false;
    summary.error = String(error.message || error);
    return summary;
  } finally { summary.durationMs = Date.now() - started; }
}

async function refetchArticleTitle(db, articleId, kind) {
  const initial = await db.getArticleForTitle(articleId, kind);
  if (!initial) return { ok: false, error: '文章不存在' };
  if (initial.status !== 'active') return { ok: false, error: '请先启用文章再获取标题' };
  if (initial.title_source === 'manual' && initial.title) {
    return { ok: false, error: '手动维护的标题不会被自动抓取覆盖，请直接编辑标题' };
  }
  if (String(initial.title || '').trim()) return { ok: true, title: initial.title, cached: true };
  await db.rearmTitleFetch(articleId, kind, { titleSource: initial.title_source ?? null, updatedAt: initial.updated_at ?? null });
  const article = await db.getArticleForTitle(articleId, kind);
  const superseded = { ok: false, superseded: true, error: '文章已被修改，本次标题结果未写入，请刷新后重试' };
  if (!eligible(article, initial.url)) return superseded;
  const outcome = await fetchOneUrl(db, kind, article.url, [article], Date.now() + RUN_DEADLINE_MS);
  if (outcome.busy) return { ok: false, busy: true, error: '正在获取中' };
  if (!outcome.applied) return superseded;
  if (outcome.title != null) return { ok: true, title: outcome.title, via: outcome.via };
  return { ok: false, error: outcome.error || 'unknown', attemptsLeft: Math.max(MAX_ATTEMPTS - (article.title_fetch_attempts || 0) - 1, 0) };
}

module.exports = { runProjectTitleFetch, refetchArticleTitle, MAX_URLS_PER_RUN, RUN_DEADLINE_MS };
