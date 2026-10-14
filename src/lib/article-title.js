// article-title.js —— 从 HTML 提取文章标题（纯函数）
//
// 提取优先级：og:title → JSON-LD headline → <title>。品牌后缀剥离只作为兜底——
// 且只砍「可证明是品牌」的尾巴（尾部与 og:site_name / JSON-LD 出版者 / 域名归一化后相等），
// "Guide | Quality Control" 这类不可证的尾巴保留。
// 拒绝规则：过短/过长/挑战页/登录墙/错误页/站点名——每个拒绝码是稳定的失败原因桶。

const TITLE_MAX_LENGTH = 300;
const TITLE_MIN_LENGTH = 4;

const TITLE_FETCH_HEADERS = Object.freeze({
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  // 部分主机直接 403 非浏览器 UA——预览抓取要伪装成桌面浏览器
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});

// 整串相等才算这些泛用词（包含匹配会误杀 "How to Sign In With Apple" 这类真标题）
const TITLE_REJECT_EXACT_CHALLENGE = new Set(['just a moment...', 'just a moment…',
  'attention required! | cloudflare', 'checking your browser',
  '请稍候...', '请稍候…']);
const TITLE_REJECT_EXACT_LOGIN = new Set(['log in', 'login', 'sign in', 'sign in / log in',
  'log in / sign in', '登录', '请登录', '会员登录']);
const TITLE_REJECT_EXACT_ERROR = new Set(['access denied', '403', '403 forbidden', '404',
  '404 not found', 'not found', 'page not found', 'error', 'bad request', 'forbidden']);
// 机器文案才用包含匹配（没有真人会把它们写进文章标题）
const TITLE_REJECT_CONTAINS = ['checking your browser before accessing', 'ddos protection by',
  'performance & security by cloudflare', 'one more step |'];

// 属性值是 HTML 转义过的，标题不能是。命名实体集cover 常见排版/标点；
// 未知名实体原样保留，优于猜错解码。
const TITLE_NAMED_ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  raquo: '\u00bb', laquo: '\u00ab', mdash: '\u2014', ndash: '\u2013',
  hellip: '\u2026', middot: '\u00b7', bull: '\u2022', sect: '\u00a7',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c',
  trade: '\u2122', reg: '\u00ae', copy: '\u00a9', deg: '\u00b0',
  times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1', euro: '\u20ac',
  pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
}));

function decodeTitleEntities(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const body = entity.toLowerCase();
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
      return match;
    }
    return TITLE_NAMED_ENTITIES.get(body) ?? match;
  });
}

function collapseTitleWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// 品牌/后缀比较用的归一化键：小写、只留字母数字与 CJK——标点变体不影响相等判断
function normalizeTitleKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

// 品牌候选，可信度从高到低：og:site_name → JSON-LD 出版者/作者 → 域名本身
// （example-site.com → examplesite；TLD 丢掉，"com" 永远匹配不上尾巴）
function buildTitleBrandKeys({ siteName, jsonLdNames, url }) {
  const keys = new Set();
  for (const candidate of [siteName, ...(jsonLdNames || [])]) {
    const key = normalizeTitleKey(candidate);
    if (key.length >= 2) keys.add(key);
  }
  try {
    const host = String(new URL(url).hostname || '').toLowerCase().replace(/^www\./, '');
    const labels = host.split('.');
    const withoutTld = labels.length >= 2 ? labels.slice(0, -1).join('') : host;
    const hostKey = normalizeTitleKey(withoutTld);
    if (hostKey.length >= 2) keys.add(hostKey);
  } catch { /* url 上游已校验；解析失败只是候选少几个 */ }
  return keys;
}

const TITLE_SUFFIX_SEPARATORS = [' - ', ' | ', ' – ', ' — ', ' · ', ' • ', ' :: ', ' » '];

// 从右往左最多砍两个「品牌尾巴」。分隔符必须两侧带空格（连字符标题不会被误劈），
// 尾巴必须归一化后等于某个品牌键。前缀永远不碰——开头的品牌通常是故意的。
function stripTitleBrandSuffix(title, brandKeys) {
  let cleaned = title;
  for (let round = 0; round < 2; round += 1) {
    let cutIndex = -1;
    for (const separator of TITLE_SUFFIX_SEPARATORS) {
      const index = cleaned.lastIndexOf(separator);
      if (index <= 0) continue;
      const head = cleaned.slice(0, index).trim();
      const tail = cleaned.slice(index + separator.length).trim();
      if (!head || !tail) continue;
      if (brandKeys.has(normalizeTitleKey(tail)) && index > cutIndex) cutIndex = index;
    }
    if (cutIndex < 0) break;
    cleaned = cleaned.slice(0, cutIndex).trim();
  }
  return cleaned;
}

// null = 可接受。每个返回码是失败导出的稳定桶。
function rejectArticleTitleReason(rawTitle, { siteNameKey } = {}) {
  const normalized = collapseTitleWhitespace(rawTitle);
  if (!normalized) return 'no_title';
  if (normalized.length < TITLE_MIN_LENGTH) return 'too_short';
  if (normalized.length > TITLE_MAX_LENGTH) return 'too_long';
  const lowered = normalized.toLowerCase();
  if (TITLE_REJECT_EXACT_CHALLENGE.has(lowered)) return 'challenge';
  if (TITLE_REJECT_EXACT_LOGIN.has(lowered)) return 'login_wall';
  if (TITLE_REJECT_EXACT_ERROR.has(lowered)) return 'error_page';
  const leadingLabel = lowered.split(/ [|–—»•] | - /, 1)[0];
  if (TITLE_REJECT_EXACT_ERROR.has(leadingLabel)) return 'error_page';
  if (TITLE_REJECT_EXACT_LOGIN.has(leadingLabel)) return 'login_wall';
  if (TITLE_REJECT_CONTAINS.some((phrase) => lowered.includes(phrase))) return 'challenge';
  if (siteNameKey && normalizeTitleKey(normalized) === siteNameKey) return 'site_name';
  return null;
}

function parseTitleMetaTags(html) {
  const meta = new Map();
  const jsonLdNames = [];
  const lowerHtml = html.toLowerCase();
  const jsonLdBlocks = [];
  const tagNamePattern = /<\/?([a-z][\w:-]*)\b/iy;
  const attributePattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
  // 一次正向扫描，尊重引号内的 '>' 与 script/title 原始内容——未闭合标签不会让
  // 正则把剩下 128 KB 反复扫一遍。
  for (let cursor = 0; cursor < html.length;) {
    const start = html.indexOf('<', cursor);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      cursor = end < 0 ? html.length : end + 3;
      continue;
    }
    tagNamePattern.lastIndex = start;
    const tag = tagNamePattern.exec(html);
    if (!tag) { cursor = start + 1; continue; }
    let end = tagNamePattern.lastIndex;
    let quote = null;
    for (; end < html.length; end += 1) {
      const character = html[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>' || character === '<') break;
    }
    if (end >= html.length) break;
    if (html[end] === '<') { cursor = end; continue; }
    cursor = end + 1;
    if (html[start + 1] === '/') continue;
    const name = tag[1].toLowerCase();
    if (!['meta', 'script', 'title', 'style', 'textarea'].includes(name)) continue;
    const attributes = {};
    const attributeText = html.slice(tagNamePattern.lastIndex, end);
    for (let index = 0; index < attributeText.length;) {
      if (/\s/.test(attributeText[index])) { index += 1; continue; }
      attributePattern.lastIndex = index;
      const match = attributePattern.exec(attributeText);
      if (!match) { index += 1; continue; }
      attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
      index = attributePattern.lastIndex;
    }
    if (name === 'meta') {
      const key = String(attributes.property || attributes.name || '').toLowerCase();
      if (key && !meta.has(key)) meta.set(key, decodeTitleEntities(attributes.content || ''));
      continue;
    }
    const closing = lowerHtml.indexOf(`</${name}`, cursor);
    if (closing < 0) break;
    const content = html.slice(cursor, closing);
    cursor = closing;
    if (name === 'title' && !meta.has('html:title')) {
      meta.set('html:title', collapseTitleWhitespace(decodeTitleEntities(content)));
    } else if (name === 'script' && attributes.type?.toLowerCase() === 'application/ld+json') {
      jsonLdBlocks.push(content);
    }
  }
  // JSON-LD：headline 是没有 OG 标签站点的 og:title 等价物。走 @graph 与数组，深度封顶；
  // 坏块跳过，不致命。
  for (const block of jsonLdBlocks) {
    let parsed;
    try { parsed = JSON.parse(block); } catch { continue; }
    const collectNames = (node, depth) => {
      if (!node || depth > 6 || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) collectNames(item, depth + 1);
        return;
      }
      const headline = node.headline;
      if (typeof headline === 'string' && headline.trim() && !meta.has('json-ld:headline')) {
        meta.set('json-ld:headline', decodeTitleEntities(headline));
      } else if (Array.isArray(headline)) {
        const first = headline.find((item) => typeof item === 'string' && item.trim());
        if (first && !meta.has('json-ld:headline')) meta.set('json-ld:headline', decodeTitleEntities(first));
      }
      for (const name of ['publisher', 'author']) {
        const value = node[name];
        const nameText = typeof value === 'string' ? value
          : value && typeof value === 'object' && !Array.isArray(value) ? value.name : null;
        if (typeof nameText === 'string' && nameText.trim()) jsonLdNames.push(decodeTitleEntities(nameText));
      }
      collectNames(node['@graph'], depth + 1);
    };
    collectNames(parsed, 0);
  }
  return { meta, jsonLdNames };
}

// 对 HTML 文档的纯提取。返回 {title, via} 或 {error}。
// 兜底规则同时作用在「剥离后」与「原始」候选上：剥离结果不可用，原始值还有一次机会。
function extractArticleTitle(html, { url } = {}) {
  const { meta, jsonLdNames } = parseTitleMetaTags(String(html || ''));
  const siteName = meta.get('og:site_name') || null;
  const siteNameKey = siteName ? normalizeTitleKey(siteName) : null;
  const brandKeys = buildTitleBrandKeys({ siteName, jsonLdNames, url: url || '' });
  const candidates = [
    ['og:title', 'og'],
    ['json-ld:headline', 'json-ld'],
    ['html:title', 'title'],
  ];
  let lastReason = 'no_title';
  for (const [key, via] of candidates) {
    const raw = collapseTitleWhitespace(meta.get(key) || '');
    if (!raw) continue;
    const rawReason = rejectArticleTitleReason(raw, { siteNameKey });
    if (rawReason) {
      lastReason = rawReason;
      continue;
    }
    const cleaned = stripTitleBrandSuffix(raw, brandKeys);
    const cleanedReason = rejectArticleTitleReason(cleaned, { siteNameKey });
    if (cleanedReason === 'too_short') {
      // 剥离砍掉了太多：保留原始值，别为过激的一刀丢掉真标题。
      // （site_name 不救：「站点 - 站点」剥成「站点」是主页，救回来等于写垃圾。）
      return { title: raw, via };
    }
    if (cleanedReason) {
      lastReason = cleanedReason;
      continue;
    }
    // 有些平台（Shopify 主题对 og_title 上 truncate:70）会发截断的 og:title，而完整标题
    // 还在 <title> 的品牌后缀后面。只有当剥离后的 <title> 以省略号或足够长的词中截断
    // 延展 og 值时，才认定截断并取更全的那个；单纯加个分类后缀不算证据。
    if (via === 'og') {
      const titleRaw = collapseTitleWhitespace(meta.get('html:title') || '');
      if (titleRaw && !rejectArticleTitleReason(titleRaw, { siteNameKey })) {
        const titleCleaned = stripTitleBrandSuffix(titleRaw, brandKeys);
        const prefix = cleaned.replace(/(?:\.{3}|…)$/, '').trimEnd();
        const hasEllipsis = prefix !== cleaned;
        const midWordCut = cleaned.length >= 40
          && /[\p{L}\p{N}]/u.test(cleaned.at(-1))
          && /[\p{L}\p{N}]/u.test(titleCleaned[cleaned.length] || '');
        if (!rejectArticleTitleReason(titleCleaned, { siteNameKey })
          && titleCleaned.length > prefix.length && titleCleaned.startsWith(prefix)
          && (hasEllipsis || midWordCut)) {
          return { title: titleCleaned, via: 'title' };
        }
      }
    }
    return { title: cleaned, via };
  }
  return { error: lastReason };
}

// 死链被 301 回主页时服务端返回 200 + 一个像模像样的主页标题——最强的信号是最终路径。
// 只有落到根路径才算；协议/主机升级、补尾斜杠保留路径，仍然算候选。
function redirectedTitleToRoot(requestUrl, responseUrl) {
  if (!requestUrl || !responseUrl) return false;
  try {
    const requested = new URL(requestUrl);
    const final = new URL(responseUrl);
    const finalPath = final.pathname.replace(/\/+$/, '');
    return finalPath === '' && requested.pathname.replace(/\/+$/, '') !== '';
  } catch { return false; }
}

// 按 header/meta charset 解码（都没写就 utf-8），未知标签回退 utf-8 预览
function decodeTitleHtmlBytes(bytes, contentType) {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const headerCharset = /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType || ''))?.[1];
  const asciiPeek = new TextDecoder('utf-8', { fatal: false }).decode(buffer.slice(0, 4096));
  const metaCharset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(asciiPeek)?.[1];
  for (const label of [headerCharset, metaCharset, 'utf-8']) {
    if (!label) continue;
    try { return new TextDecoder(label, { fatal: false }).decode(buffer); } catch { /* 未知标签 */ }
  }
  return asciiPeek;
}

module.exports = {
  TITLE_FETCH_HEADERS, TITLE_MAX_LENGTH, TITLE_MIN_LENGTH,
  rejectArticleTitleReason, extractArticleTitle, redirectedTitleToRoot,
};
