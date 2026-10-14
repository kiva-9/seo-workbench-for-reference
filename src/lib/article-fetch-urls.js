// article-fetch-urls.js —— 月度同步的 URL 解析与响应归集（纯函数，任务07）
//
// 契约（任务07 + 任务04 数据契约）：
//   - GSC 按原始完整 URL 精确计数：登记的是相对路径时按项目唯一站点解析成完整 URL；
//     站点无法唯一解析（domain property / 多站点）时拒绝猜测，由调用方提示补完整 URL。
//     一篇文章的地址全集 = 当前 + 曾用（改址不删历史指标），命中多个地址相加。
//   - 放宽的请求过滤只用于召回；响应里和登记地址不一致的变体（尾斜杠/大小写/query）
//     记 mismatch，不自动算入。
//   - GA4 按规范化路径归集：同一篇文章的多个曾用地址归一化成同一路径只累计一次；
//     跨主机同路径无法区分时标歧义（mismatch），不凭路径回退合并。
//   - CTR = 总点击/总曝光，排名按曝光加权；分母 0 → null。

const { splitUrl, normPathname, normPath } = require('./url-match');

// 项目 GSC 站点形态：URL 前缀属性（https://example.com/）或 domain property（sc-domain:example.com）
function parseGscSite(siteUrl) {
  const s = String(siteUrl || '').trim();
  if (!s) return null;
  const m = /^sc-domain:(.+)$/i.exec(s);
  if (m) return { kind: 'domain', host: m[1].toLowerCase() };
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return { kind: 'url-prefix', origin: u.origin, host: u.host.toLowerCase(), prefix: u.pathname };
    } catch { /* 落到下面 */ }
  }
  return { kind: 'unknown', raw: s };
}

// 把登记地址解析成 GSC 完整 URL。返回 { url } 或 { error }
// kind='url-prefix'：相对路径拼 origin；绝对地址原样（trim 后精确用）。
// kind='domain'：无法唯一推断主机（http/https、www 都可能），拒绝猜测。
function resolveGscUrl(registered, site) {
  const raw = String(registered ?? '').trim();
  if (!raw) return { error: 'empty' };
  if (/^https?:\/\//i.test(raw)) return { url: raw };
  if (!raw.startsWith('/')) return { error: 'not-a-path' };
  if (!site) return { error: 'no-site' };
  if (site.kind === 'url-prefix') {
    // 站点本身可能带子路径前缀（https://example.com/blog/）
    const prefix = site.prefix && site.prefix !== '/' ? site.prefix.replace(/\/$/, '') : '';
    return { url: site.origin + prefix + raw };
  }
  return { error: 'ambiguous-site', site: site.raw || site.host };
}

// 归集 GSC 响应：exact Map<完整URL, 指标> + variants（变体清单，供 mismatch 诊断）
// rows: [{ page, clicks, impressions, ctr, position }]
function aggregateGscRows(rows) {
  const exact = new Map();
  for (const r of rows) {
    const page = String(r.page || '').trim();
    if (!page) continue;
    const cur = exact.get(page) || { clicks: 0, impressions: 0, posSum: 0 };
    cur.clicks += Number(r.clicks || 0);
    cur.impressions += Number(r.impressions || 0);
    cur.posSum += Number(r.impressions || 0) * Number(r.position || 0);
    exact.set(page, cur);
  }
  return exact;
}

// 某篇文章在这一批 GSC 响应里的精确计数。articleUrls = 该文的地址全集
// （当前 + 曾用，改址不删历史指标），命中多个地址就把它们相加。
// miss = 请求完整成功但没有任何一个地址的行 → 0；
// variant = 响应里存在规范化后同路径但字符串不同的地址 → mismatch，不计入。
function gscValueForArticle(exact, articleUrls, site) {
  const urls = (Array.isArray(articleUrls) ? articleUrls : [articleUrls]).filter(Boolean);
  const registered = new Set();
  const paths = new Set();
  let clicks = 0;
  let impressions = 0;
  let posSum = 0;
  let hits = 0;
  for (const u of urls) {
    const resolved = resolveGscUrl(u, site);
    if (resolved.error) return { error: resolved.error };
    registered.add(resolved.url);
    paths.add(splitUrl(resolved.url).path);
  }
  for (const [page, v] of exact) {
    if (!registered.has(page)) continue;
    clicks += v.clicks;
    impressions += v.impressions;
    posSum += v.posSum;
    hits++;
  }
  if (hits) {
    return {
      clicks, impressions,
      ctr: impressions ? clicks / impressions : null,
      position: impressions ? posSum / impressions : null,
    };
  }
  // 找变体：任一条已登记地址的规范化路径在响应里出现了字符串不同的形态。
  // 大小写不敏感地比路径（GSC 的 page 大小写不同也能对上），但诊断里保留原始串。
  const lowerPaths = new Set([...paths].map((p) => p.toLowerCase()));
  const variants = [...exact.keys()].filter((k) => !registered.has(k) && lowerPaths.has(splitUrl(k).path.toLowerCase()));
  if (variants.length) {
    const observed = variants
      .map((k) => `${k}（${exact.get(k).clicks} 点击）`)
      .slice(0, 3)
      .join('；');
    return { variant: variants.slice(0, 3), observed };
  }
  return { clicks: 0, impressions: 0, ctr: null, position: null, miss: true };
}

// 文章的 GA4 查询路径集合：当前 + 曾用地址归一化，去重（同一路径只累计一次）
// 跨主机同路径标歧义：同一 path 出现在多个 host 下时无法区分，记 mismatch
function ga4PathsForArticle(urls) {
  const byPath = new Map(); // path -> Set<host|null>
  for (const u of urls || []) {
    const { host, path } = splitUrl(u);
    if (!byPath.has(path)) byPath.set(path, new Set());
    byPath.get(path).add(host);
  }
  const paths = [];
  const ambiguous = [];
  for (const [path, hosts] of byPath) {
    const real = [...hosts].filter(Boolean);
    if (real.length > 1) ambiguous.push(path);
    paths.push(path);
  }
  return { paths, ambiguous };
}

// 把 GA4 byDate（key 是规范化路径）按文章归集：多个曾用路径只取一次（byDate 天然按 path 去重）
function ga4ValueForArticle(byDate, path) {
  const acc = byDate.get(path);
  if (!acc) return { pageviews: 0, keyEvents: null, miss: true };
  let pageviews = 0;
  for (const v of acc.values()) pageviews += Number(v.pageviews || 0);
  return { pageviews, keyEvents: null, coveredDays: acc.size };
}

function ga4KeyEventsForArticle(byDate, path) {
  const acc = byDate.get(path);
  if (!acc) return null;
  let keyEvents = 0;
  for (const v of acc.values()) keyEvents += Number(v.keyEvents || 0);
  return keyEvents;
}

// 派生指标：CTR 与排名（分母 0 → null）；与任务04契约一致
function deriveGsc({ clicks, impressions, posSum }) {
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : null,
    position: impressions ? posSum / impressions : null,
  };
}

module.exports = {
  parseGscSite, resolveGscUrl, aggregateGscRows, gscValueForArticle,
  ga4PathsForArticle, ga4ValueForArticle, ga4KeyEventsForArticle, deriveGsc,
};
