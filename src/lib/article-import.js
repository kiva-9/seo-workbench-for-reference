// article-import.js —— 站内文章批量导入：解析 / 预检（纯函数，任务06）
//
// 契约：
//   - 粘贴 TSV/CSV，一行一条 URL；表头在前 5 行内搜索（前几行可能是说明文字）；
//     没有表头时第一列当 URL；Excel 序列日期转 YYYY-MM-DD；一次最多 2000 行。
//   - URL 规范化（normalizeArticleUrl）：裸 /path 按项目域名补全；必须 http(s)://、
//     禁 user:pass；hostname 必须等于项目域名或其子域名；清空 search/hash（utm 等
//     追踪参数不该制造第二身份）；≤ 2000 字符。
//   - 文案师只用账号邮箱精确匹配（歧义/未知/非成员拒绝并列出），解析成 user_id；
//     命中名单的直接指派，不在名单的标「启用项目文案师」，确认时原子补建名单行。
//   - 预检只读不改库：新增/恢复/更新/重复/无效分类 + 每个单元格的落地字段；
//     空单元格默认保留已有字段（不覆盖），清空必须显式。
//   - 公式注入：源文本原样保留（首字符 = + - @ 不被永久改写），
//     防护发生在导出/电子表格边界（任务13）和 DOM 转义，不在这里改写用户数据。

const { isValidDay, businessToday } = require('./business-dates');
const { buildXlsx } = require('./xlsx');
const { readXlsxRows } = require('./xlsx-reader');
const { normalizeDomain } = require('./domain');

// 导入模板：「填写区」给用户填，
// 「填写说明」讲怎么填。标题列带表头才会被识别；空单元格不会清掉已有标题。
function buildArticleTemplateWorkbook(scopeLabel) {
  const fillRows = [
    ['URL', '发布日期', '文案师', '标题'],
    ['https://example.com/blog/example', '2026-08-01', '', '示例文章标题'],
    ['https://example.com/blog/no-date', '', '', ''],
  ];
  const noteRows = [
    ['说明'],
    ['URL 必须是完整的 http:// 或 https:// 地址，且属于项目自己的域名（含子域名）；也可以只填站内路径，例如 /blog/example，系统会自动补全域名。'],
    ['发布日期可以留空；推荐 YYYY-MM-DD 格式，也支持 2026/8/1、2026年8月1日 等常见写法和 Excel 日期格。'],
    ['文案师可以留空：留空时文章的文案师保持原样不变；填写时必须是该项目文案师名单里的名字（新名字会在确认导入时自动加入名单，预览中会列出）。'],
    ['标题可以留空：填写后文章列表与监控看板优先显示标题，留空则继续显示 URL；空单元格不会清掉已有标题。标题列需要带表头才会被识别。'],
    ['四列填完后直接保存本文件，点「上传 CSV / TXT / XLSX」选中它即可；也可以连表头一起复制，粘贴到导入框里。'],
  ];
  return [
    { name: '填写区', rows: [[`${scopeLabel}导入模板 · 填写区`], ['填 URL、发布日期、文案师和标题（发布日期、文案师、标题可留空）'], ...fillRows] },
    { name: '填写说明', rows: [[`${scopeLabel}导入模板 · 使用说明`], ...noteRows] },
  ];
}

function buildArticleTemplateBytes(scopeLabel) {
  return buildXlsx(buildArticleTemplateWorkbook(scopeLabel));
}

// 站外（外链）模板：多一列「来源域名」——域名留空时从 URL 自动推断，所以这一列一定是可空的。
// 站外不做域名归属校验，说明里要写清楚「任意网站都可以」。
function buildExternalArticleTemplateWorkbook(scopeLabel) {
  const fillRows = [
    ['URL', '发布日期', '文案师', '标题', '来源域名'],
    ['https://platform.example.com/guest-post', '2026-08-01', '', '示例文章标题', ''],
    ['https://another.example.net/blog/post', '', '', '', 'another.example.net'],
  ];
  const noteRows = [
    ['说明'],
    ['URL 必须是完整的 http:// 或 https:// 地址，可以是任意外部网站（不要求属于本项目域名）。'],
    ['发布日期可以留空；推荐 YYYY-MM-DD 格式，也支持 2026/8/1、2026年8月1日 等常见写法和 Excel 日期格。'],
    ['文案师可以留空：留空时文章的文案师保持原样不变；填写时必须是该项目文案师名单里的名字（新名字会在确认导入时自动加入名单）。'],
    ['来源域名可以留空：留空时从 URL 自动提取平台域名；已登记文章的空单元格不会清空已手工设置的域名。'],
    ['标题可以留空；留空时保持原样不变。'],
    ['五列填完后直接保存本文件，点「上传 CSV / TXT / XLSX」选中它即可；也可以连表头一起复制，粘贴到导入框里。'],
  ];
  return [
    { name: '填写区', rows: [[`${scopeLabel}导入模板 · 填写区`], ['填 URL、发布日期、文案师、标题和来源域名（均可留空）'], ...fillRows] },
    { name: '填写说明', rows: [[`${scopeLabel}导入模板 · 使用说明`], ...noteRows] },
  ];
}

function buildExternalArticleTemplateBytes(scopeLabel) {
  return buildXlsx(buildExternalArticleTemplateWorkbook(scopeLabel));
}

// .xlsx 字节 → 导入文本（取「填写区」工作表，转成制表符分隔的文本走同一条解析链）。
// 表头缺失/为空 → 抛错，让用户看到「模板结构不对」而不是静默导入 0 行。
function xlsxToImportText(bytes, { sheetName = '填写区' } = {}) {
  const rows = readXlsxRows(bytes, { sheetName });
  const meaningful = rows.filter((r) => r.some((c) => String(c || '').trim() !== ''));
  if (!meaningful.length) throw new Error('XLSX 里没有可导入的数据行');
  return meaningful.map((r) => r.join('\t')).join('\n');
}

// 一次导入的行上限
const IMPORT_ROW_LIMIT = 2000;
// 表头搜索窗口：前 5 行内能找到 URL 列表头才算有表头（兼容表头下方带说明行的粘贴）
const HEADER_SEARCH_LINES = 5;

const HEADER_TOKENS = [
  ['url', ['url', '链接', '地址', '页面']],
  ['title', ['title', '标题']],
  ['keyword', ['keyword', '关键词', '关键字']],
  ['notes', ['notes', 'note', '备注', '说明']],
  ['published_at', ['published', 'publish', 'date', '发布日期', '发表时间', '时间']],
  ['copywriter', ['copywriter', '文案', '作者', ' writer', 'writer']],
];

// 站外导入多一列「来源域名」：用户登记的平台域名可以和 URL 主机不一致（追踪短链场景）。
// 站内导入不认这一列——站内 URL 必须属于项目域名，没有平台歧义。
const DOMAIN_HEADER_TOKENS = ['来源域名', '平台域名', '域名', 'domain'];

// Excel 序列日期（1900 日期系统，含 1900-02-29 的 historic bug 用 1899-12-30 起点近似）
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const EXCEL_MIN = 1;        // 1900-01-01
const EXCEL_MAX = 80000;    // ~2119 年，之外的不当日期

function normalizeHeader(cell) {
  return String(cell || '').trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

function matchColumn(header) {
  const exact = matchColumnExact(header);
  if (exact) return exact;
  // 宽松包含匹配（"文章URL" / "发布日期(必填)" 这类）——只用于列识别，不用于找表头行
  const h = normalizeHeader(header);
  if (!h) return null;
  for (const [field, tokens] of HEADER_TOKENS) {
    if (tokens.some((t) => h.includes(t.replace(/[\s_\-]+/g, '')) && t.trim())) return field;
  }
  return null;
}

// 精确表头匹配（归一化后整个相等）。找表头行只能用这个——包含匹配会把说明文字
// （“… URL、发布日期 …”）误判成表头。
function matchColumnExact(header) {
  const h = normalizeHeader(header);
  if (!h) return null;
  for (const [field, tokens] of HEADER_TOKENS) {
    if (tokens.some((t) => h === t.replace(/[\s_\-]+/g, ''))) return field;
  }
  return null;
}

// 「来源域名」列的识别：同样只要精确表头，避免把正文里的词当列名
function matchColumnDomain(header) {
  const h = normalizeHeader(header);
  if (!h) return false;
  return DOMAIN_HEADER_TOKENS.some((t) => h === t.replace(/[\s_\-]+/g, ''));
}

// 站外平台域名归一化：允许直接填域名（example.com）或带 scheme 的地址，其余交给 normalizeDomain
function normalizeExternalDomain(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  return normalizeDomain(candidate);
}

// Excel 序列日期 → YYYY-MM-DD；不是合理序列返回 null
function excelSerialToDay(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < EXCEL_MIN || n > EXCEL_MAX) return null;
  const d = new Date(EXCEL_EPOCH_UTC + n * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// 拆一行：支持制表符（Excel 粘贴默认）和逗号；引号包围的字段按简单规则剥掉
function splitLine(line, sep) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
      continue;
    }
    if (ch === sep && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

// 选分隔符：制表符优先（Excel 复制粘贴的默认格式），否则逗号
function detectSep(lines) {
  const sample = lines.slice(0, 5).join('\n');
  return sample.includes('\t') ? '\t' : ',';
}

// 把原始文本解析成 { columns: {url,title,...}[], rows: [{ cells, lineNo }], rowLimit }
// 只做结构和表头识别，不碰数据库。超出行上限时截断并标记（路由据此报错）。
// domain: true 时额外识别「来源域名」列（站外导入用）。
function parseImportText(text, { domain = false } = {}) {
  // Excel/CSV 常带 BOM，不剥掉第一个表头单元格就匹配不上
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { hasHeader: false, columns: [], rows: [], truncated: false };
  const sep = detectSep(lines);
  // 表头可能不在第一行（粘贴内容上方带说明文字）：前 5 行内找 URL 列表头。
  // 判定用精确匹配——说明行里的「URL、发布日期」字样不算表头。
  let headerIndex = -1;
  for (let i = 0; i < Math.min(HEADER_SEARCH_LINES, lines.length); i++) {
    const cells = splitLine(lines[i], sep);
    if (cells.map(matchColumnExact).some(Boolean) && matchColumnExact(cells[0]) === 'url') { headerIndex = i; break; }
  }
  if (headerIndex === -1) {
    return {
      hasHeader: false,
      columns: ['url'],
      rows: lines.map((line, i) => ({ cells: splitLine(line, sep), lineNo: i + 1 })),
      truncated: false,
    };
  }
  // 表头里可能有没识别的列（忽略），URL 列必须存在
  const firstCells = splitLine(lines[headerIndex], sep);
  const mapped = firstCells.map(matchColumn);
  const columns = firstCells.map((h, i) => {
    if (mapped[i]) return mapped[i];
    if (domain && matchColumnDomain(h)) return 'domain';
    return `_skip${i}`;
  });
  const body = lines.slice(headerIndex + 1);
  const truncated = body.length > IMPORT_ROW_LIMIT;
  const rows = body.slice(0, IMPORT_ROW_LIMIT).map((line, i) => ({
    cells: splitLine(line, sep), lineNo: headerIndex + i + 2,
  }));
  return { hasHeader: true, columns, rows, truncated };
}

// 项目域名归一化：小写、去 www.、去尾点。website 为空时调用方传 gsc_site。
function projectDomainOf(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`);
    return u.hostname.replace(/^www\./, '').replace(/\.$/, '') || null;
  } catch {
    return s.split('/')[0].replace(/^www\./, '').replace(/\.$/, '') || null;
  }
}

// URL 规范化：
//   - 裸 /path 按项目域名补全（从 CMS/站点地图复制出来的常见形态）；
//   - 必须 http/https、禁 user:pass；
//   - hostname 必须等于项目域名或其子域名——拒绝把外站地址登记进项目；
//   - 清空 search/hash：同一篇文章带不同 utm 参数不该成为两篇；
//   - ≤ 2000 字符。
// 返回规范化 URL；任何一步不合法返回 null（调用方给中文原因）。
function normalizeArticleUrl(raw, projectDomain) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const domain = projectDomainOf(projectDomain);
  const candidate = trimmed.startsWith('/') && domain ? `https://${domain}${trimmed}` : trimmed;
  let parsed;
  try { parsed = new URL(candidate); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!domain || (hostname !== domain && !hostname.endsWith(`.${domain}`))) return null;
  parsed.search = '';
  parsed.hash = '';
  const normalized = parsed.toString();
  if (normalized.length > 2000) return null;
  return normalized;
}

// 预检上下文（由路由从数据库装配后传入）：
//   projectDomain: 项目域名（website，空则 gsc_site）——站内 URL 归属校验用
//   external: true = 站外导入（任意域名的绝对地址，不做项目域名归属校验）
//   existingByUrl: Map<url, article>（同项目当前 URL → 文章行）
//   userByEmail: Map<email, { id }>
//   rosterByUser: Map<userId, copywriterId | null>（null = 账号存在但不在名单）
//   today: 业务日（可注入，测试钉死）
// 返回 { items, summary }；items[i].action ∈ new/restored/update/duplicate/invalid
function previewImport(parsed, ctx = {}) {
  const existingByUrl = ctx.existingByUrl || new Map();
  const userByEmail = ctx.userByEmail || new Map();
  const rosterByUser = ctx.rosterByUser || new Map();
  const today = ctx.today || businessToday();
  const external = ctx.external === true;
  const items = [];
  const summary = {
    total: 0, new: 0, restored: 0, update: 0, duplicate: 0, invalid: 0,
    enableCopywriter: 0, copywriterOverwrite: 0, missingPublishedAt: 0,
  };

  const seen = new Map(); // 同一次导入内的 URL 去重（后者标 duplicate）
  const hasDomainColumn = external && parsed.columns.includes('domain');
  for (const row of parsed.rows) {
    const get = (field) => {
      const idx = parsed.columns.indexOf(field);
      return idx === -1 ? '' : String(row.cells[idx] ?? '').trim();
    };
    // 站外「来源域名」列：填了就用（manual），空则确认时从 URL 自动推断
    const domain = hasDomainColumn ? (normalizeExternalDomain(get('domain')) || '') : '';
    summary.total++;
    const rawUrl = get('url');
    // 站内：域名归属 + 去 query/hash；站外：任意域名的 http(s) 绝对地址（原样 trim）
    const url = external
      ? (/^https?:\/\//i.test(String(rawUrl || '').trim()) ? String(rawUrl || '').trim() : null)
      : normalizeArticleUrl(rawUrl, ctx.projectDomain);
    const base = { lineNo: row.lineNo, raw: row.cells, url };

    if (!url) {
      summary.invalid++;
      items.push({ ...base, action: 'invalid', reason: rawUrl
        ? (external ? '外链必须是 http(s):// 绝对地址' : 'URL 必须属于当前项目域名或其子域名（支持 / 开头的站内路径，需补全为完整地址）')
        : 'URL 为空' });
      continue;
    }
    // 发布日期：Excel 序列日期转日历日；非法值/未来日期标 invalid（不静默丢）
    const rawDate = get('published_at');
    let published_at = '';
    if (rawDate) {
      if (/^\d+$/.test(rawDate)) published_at = excelSerialToDay(rawDate) || '';
      else if (isValidDay(rawDate)) published_at = rawDate;
      if (!published_at) {
        summary.invalid++;
        items.push({ ...base, action: 'invalid', reason: `发布日期无法识别：${rawDate}` });
        continue;
      }
      if (published_at > today) {
        summary.invalid++;
        items.push({ ...base, action: 'invalid', reason: `发布日期不能晚于今天（${today}）：${published_at}` });
        continue;
      }
    } else {
      summary.missingPublishedAt++;
    }
    // 文案师：账号邮箱精确匹配；未知账号拒绝并列出（不按昵称猜、不代建号）
    const rawCw = get('copywriter');
    let copywriter = null;
    let copywriterIssue = null;
    if (rawCw) {
      const email = rawCw.trim().toLowerCase();
      const user = userByEmail.get(email);
      if (!user) {
        copywriterIssue = `账号不存在：${rawCw}`;
      } else {
        // 名单即成员模型：候选 = 全部已有账号。在册的直接派；不在册的标「启用项目文案师」，
        // 确认时同一原子单元补建名单行（复册则清 revoked_at）
        const cid = rosterByUser.has(user.id) ? rosterByUser.get(user.id) : null;
        copywriter = { user_id: user.id, copywriter_id: cid };
        if (cid === null) summary.enableCopywriter++;
      }
    }

    // 分类：invalid > duplicate（同项目当前 URL 或本次导入内重复）> restored/update > new
    if (seen.has(url)) {
      summary.duplicate++;
      items.push({ ...base, action: 'duplicate', reason: '本次导入内重复（以第一行为准）' });
      continue;
    }
    seen.set(url, true);
    const existing = existingByUrl.get(url);
    if (existing) {
      if (existing.status === 'inactive') {
        // 重复登记 inactive：恢复启用并标待刷新——
        // 预览里作为独立动作展示，确认后才真正恢复。
        summary.restored++;
        items.push({
          ...base, action: 'restored', article_id: existing.id,
          fields: { title: get('title'), keyword: get('keyword'), notes: get('notes'), published_at, ...(hasDomainColumn ? { domain } : {}) },
          copywriter, copywriterIssue,
          reason: '已存在且当前停用中（确认后恢复启用并标记待刷新）',
        });
        continue;
      }
      summary.update++;
      // 覆盖预警：这一行带了文案师而目标已有别的文案师（空单元格保留原值，只有真赋值才算覆盖）
      if (copywriter && existing.copywriter_id && existing.copywriter_id !== copywriter.copywriter_id) {
        summary.copywriterOverwrite++;
      }
      items.push({
        ...base, action: 'update', article_id: existing.id,
        fields: { title: get('title'), keyword: get('keyword'), notes: get('notes'), published_at, ...(hasDomainColumn ? { domain } : {}) },
        copywriter, copywriterIssue,
      });
      continue;
    }
    summary.new++;
    items.push({
      ...base, action: 'new',
      fields: { title: get('title'), keyword: get('keyword'), notes: get('notes'), published_at, ...(hasDomainColumn ? { domain } : {}) },
      copywriter, copywriterIssue,
    });
  }
  return { items, summary };
}

module.exports = {
  parseImportText, previewImport, normalizeArticleUrl, projectDomainOf,
  excelSerialToDay, matchColumn, matchColumnExact, matchColumnDomain, normalizeExternalDomain,
  IMPORT_ROW_LIMIT, HEADER_SEARCH_LINES,
  buildArticleTemplateWorkbook, buildArticleTemplateBytes,
  buildExternalArticleTemplateWorkbook, buildExternalArticleTemplateBytes,
  xlsxToImportText, readXlsxRows,
};
