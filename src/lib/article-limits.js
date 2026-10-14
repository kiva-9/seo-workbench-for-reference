// article-limits.js —— 站内文章的容量与批量边界
//
// 这些数字不是产品硬上限的承诺，而是「一次操作能把系统推到多深」的工程边界：
//   - 启用篇数决定一次项目同步的 Google 请求数与数据库写入量，必须有一个上限；
//   - 批量 ID / 导入行数决定单条 SQL 的参数规模与请求耗时。
// 超限在写入前拒绝并给出可执行提示，不静默裁剪。

// 每项目最多同时启用的文章数
const PROJECT_ARTICLE_ACTIVE_LIMIT = 1000;
// 批量启停/删除/指派一次最多携带的文章 id 数
const PROJECT_ARTICLE_BATCH_LIMIT = 2000;

// 批量 id 列表归一化：去重 + 正整数过滤 + 上限校验。
// 返回 { ids } 或 { error }——调用方直接把 error 抛给用户。
function normalizeArticleIdList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const ids = [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return { error: '未选择任何文章' };
  if (ids.length > PROJECT_ARTICLE_BATCH_LIMIT) {
    return { error: `一次最多操作 ${PROJECT_ARTICLE_BATCH_LIMIT} 篇文章` };
  }
  return { ids };
}

// 排序 id 列表归一化：空列表是用户操作失误，明确报错
function normalizeOrderIds(raw) {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return { error: '排序列表不能为空' };
  return { ids };
}

module.exports = {
  PROJECT_ARTICLE_ACTIVE_LIMIT, PROJECT_ARTICLE_BATCH_LIMIT,
  normalizeArticleIdList, normalizeOrderIds,
};
