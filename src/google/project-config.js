// project-config.js —— 读项目上的数据源配置：绑了哪个谷歌账号、配了哪些关键事件
// 注意：GSC 与 GA4 可以分别绑定不同的谷歌账号（项目表的 gsc_account_id / ga4_account_id）

// 项目实际生效的账号：优先用分开绑定的，回落到老的单一 account_id
function resolveAccounts(project) {
  return {
    gscAccountId: project.gsc_account_id ?? project.account_id ?? null,
    ga4AccountId: project.ga4_account_id ?? project.account_id ?? null,
  };
}

// 项目是否具备可抓取的数据源
function hasDataSource(project) {
  const { gscAccountId, ga4AccountId } = resolveAccounts(project);
  return Boolean((gscAccountId && project.gsc_site) || (ga4AccountId && project.ga4_property_id));
}

// 解析项目上保存的关键事件名：可能是 JSON 数组字符串，也可能是数组本身或逗号分隔字符串
function parseKeyEventNames(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s || '').trim()).filter(Boolean);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map((s) => String(s || '').trim()).filter(Boolean);
  } catch { /* 非 JSON，按逗号分隔处理 */ }
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = { resolveAccounts, hasDataSource, parseKeyEventNames };
