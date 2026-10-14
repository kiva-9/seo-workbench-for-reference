// project-article-workspace-route.js —— 项目文章工作区路由的纯函数（hash 深链）
//
// 应用自身是 hash 路由，没有独立的查询串，所以工作区上下文（项目/分区/文章/返回位置）
// 全部挂在项目页的 hash 查询里：
//   #/project?id=25&section=external&article_id=12&return=%23article-monitor
// 解析与拼装只在这一处定义，调用方（项目页、文章监控看板）不做内联的 URLSearchParams，
// 这样「什么算合法上下文」只有一个说法。
//
const SECTIONS = ['internal', 'external', 'settings'];

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeSection(value) {
  const s = String(value || '').trim();
  // 早期把文案师名单当独立分区，老链接仍要落到真正承载名单的那一屏
  if (s === 'copywriters') return 'settings';
  return SECTIONS.includes(s) ? s : null;
}

// 已知路由名：返回位置只放行能落到本应用内部页面的 hash，其余一律拒绝
const KNOWN_ROUTES = ['dashboard', 'projects', 'project', 'article-monitor', 'board', 'calendar', 'docs', 'accounts', 'settings'];

function isWorkspaceHash(hash) {
  const value = String(hash || '');
  const bare = value.startsWith('#/') ? value.slice(2) : value.startsWith('#') ? value.slice(1) : value;
  return bare === 'project' || bare.startsWith('project?');
}

// return 是不可信输入：它会变成一个 <a href>。历史上把 javascript:alert(...) 直接写进
// href 就能在应用自身来源下执行（带着登录态的 API 权限），所以只放行站内 hash。
// 返回位置必须落在白名单路由上、不含控制字符/空白
// （浏览器解析 scheme 前会吃掉 "java\tscript:" 里的空白，逐个模拟各浏览器的归一化不现实，
// 见到控制字符直接拒）、不接受 scheme、不接受 protocol-relative "//host"、不接受反斜杠
// （有的浏览器会把 "\" 归一成 "/"）。
const UNSAFE_RETURN_CHARS = /[\u0000-\u001f\u007f-\u009f\s]/;

function sanitizeReturnLocation(value) {
  if (value == null) return null;
  let raw = String(value).trim();
  if (!raw || UNSAFE_RETURN_CHARS.test(raw)) return null;
  // 查询串里的 return 会被 URLSearchParams 解码，%23 还原成 #，这里兼容两种形态
  const hashLike = raw.startsWith('#') ? raw : raw.startsWith('%23') ? `#${decodeURIComponent(raw.slice(3))}` : '';
  if (hashLike) {
    const bare = hashLike.slice(1).replace(/^\//, '');
    if (isWorkspaceHash(`#/${bare}`)) return null; // 不允许返回工作区自身（死循环）
    const name = bare.split('/')[0].split('?')[0];
    return KNOWN_ROUTES.includes(name) ? `#/${bare}` : null;
  }
  // 站内路径（不带 hash 的历史书签）：只放行 /app、/projects 形态，同样不许 // 与反斜杠
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  return raw === '/projects' || raw.startsWith('/projects/') ? raw : null;
}

// 未知/缺失的分区一律落到 internal：老书签或手打错的分区名也该进到有用的一屏，
// 而不是让整个工作区渲染失败
function parseWorkspaceHash(hash) {
  const value = String(hash || '');
  const query = value.includes('?') ? value.slice(value.indexOf('?') + 1) : '';
  let params;
  try { params = new URLSearchParams(query); } catch { params = new URLSearchParams(); }
  return {
    projectId: positiveInt(params.get('id') ?? params.get('project_id')),
    section: normalizeSection(params.get('section')) || 'internal',
    articleId: positiveInt(params.get('article_id')),
    returnLocation: sanitizeReturnLocation(params.get('return')),
  };
}

function buildWorkspaceHash({ projectId, section, articleId, returnLocation } = {}) {
  const pid = positiveInt(projectId);
  const params = new URLSearchParams();
  if (pid) params.set('id', String(pid));
  const resolved = normalizeSection(section);
  if (resolved && resolved !== 'internal') params.set('section', resolved);
  const aid = positiveInt(articleId);
  if (aid) params.set('article_id', String(aid));
  const safeReturn = sanitizeReturnLocation(returnLocation);
  if (safeReturn) params.set('return', safeReturn);
  const query = params.toString();
  return `#/project${query ? `?${query}` : ''}`;
}

// 多选之类的视图草稿状态只在项目/分区真的变了才清，同一上下文内的重复渲染不清
function workspaceContextChanged(previous, next) {
  if (!previous) return true;
  return Number(previous.projectId || 0) !== Number(next.projectId || 0) || previous.section !== next.section;
}

export {
  SECTIONS, isWorkspaceHash, parseWorkspaceHash, buildWorkspaceHash,
  sanitizeReturnLocation, workspaceContextChanged,
};

// 用完整的服务端顺序定位页码，避免深链只能找到第一页的文章。
// 站内清单有轻量 ids 接口；站外清单按服务端分页依次查找，不把全部行塞进 DOM。
export async function findArticlePage({ articleId, pageSize = 50, fetchIds, fetchPage }) {
  const target = positiveInt(articleId);
  if (!target) return null;
  const size = Math.max(1, Math.min(100, positiveInt(pageSize) || 50));
  if (fetchIds) {
    const ids = await fetchIds();
    const index = ids.findIndex((id) => Number(id) === target);
    return index < 0 ? null : Math.floor(index / size) + 1;
  }
  let page = 1;
  while (true) {
    const data = await fetchPage(page, size);
    const rows = data.rows || [];
    if (rows.some((row) => Number(row.id) === target)) return page;
    if (!rows.length || page * size >= Number(data.total)) return null;
    page++;
  }
}
