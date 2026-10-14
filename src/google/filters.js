// filters.js —— 服务端过滤：把「只要这些页面」的条件下推给 Google，而不是把整站拉回来再本地筛
//
// 这些正则只是预过滤器，不是匹配器：拿到结果后还是走 lib/url-match 那套容错匹配。
// 正则的唯一职责是「宁滥勿缺」——多放几行进来无所谓（本地匹配会筛掉），漏一行就是静默丢数据。
// 语法按 Google 用的 RE2 写。

const { splitUrl } = require('../lib/url-match');
const { GSC_FILTER_MAX, REGEX_OVERHEAD } = require('./constants');

const RE2_META = /[.*+?^${}()|[\]\\]/g;
const escapeRe = (s) => String(s).replace(RE2_META, '\\$&');

// 一条登记 URL 可能对应多种路径写法：原样、百分号编码、百分号解码。
// 中文路径尤其需要 —— 用户填 /中文页，GSC 里存的往往是 /%E4%B8%AD%E6%96%87%E9%A1%B5。
function pathVariants(rawUrl) {
  const { path } = splitUrl(rawUrl);
  let decoded = path;
  try { decoded = decodeURI(path); } catch { /* 畸形编码就保持原样 */ }
  let encoded = path;
  try { encoded = encodeURI(decoded); } catch { /* 同上 */ }
  const out = new Set([path, decoded, encoded]);
  return [...out].filter(Boolean).map((p) => p.replace(/^\//, ''));
}

// 由一批路径拼出一条正则。
// (?i) 大小写不敏感；主机通配；结尾斜杠可有可无；后面允许跟查询串或锚点。
function buildPathRegex(paths) {
  const alt = paths.map(escapeRe).join('|');
  return `(?i)^https?://[^/]*/?(?:${alt})/?(?:[?#].*)?$`;
}

function buildPagePathRegex(paths) {
  const alt = paths.map(escapeRe).join('|');
  return `(?i)^/(?:${alt})/?(?:[?#].*)?$`;
}

function chunkPathsForRegex(urls, budget = GSC_FILTER_MAX - REGEX_OVERHEAD) {
  const batches = [];
  let cur = [];
  let len = 0;
  for (const u of urls) {
    for (const p of pathVariants(u)) {
      const cost = escapeRe(p).length + 1;
      if (len + cost > budget && cur.length) {
        batches.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(p);
      len += cost;
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// 供对拍测试用：给定跟踪 URL 列表，返回「这一行会不会被服务端过滤放行」
function makeFilterPredicate(urls) {
  const regexes = chunkPathsForRegex(urls).map((paths) => {
    // Node 端复现 RE2 的 (?i)：JS 正则用 i 标志，其余语法两边一致
    const src = buildPathRegex(paths).replace(/^\(\?i\)/, '');
    return new RegExp(src, 'i');
  });
  return (pageUrl) => regexes.some((re) => re.test(String(pageUrl || '')));
}

module.exports = { pathVariants, buildPathRegex, buildPagePathRegex, chunkPathsForRegex, makeFilterPredicate };
