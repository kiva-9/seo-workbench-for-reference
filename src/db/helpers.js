// helpers.js —— 纯函数小工具（不碰数据库）
// 需要数据库连接的 insert/update/remove/exists 在 ../crud（工厂注入后端）。

// 统一时间戳格式
function now() {
  return new Date().toISOString();
}

// 标签统一规范化：trim、去空、去重，逗号连接。
// 不规范化的话 "a, b" 会存成带前导空格的 " b"，标签过滤（精确匹配）永远对不上。
function normalizeTags(tags) {
  const arr = Array.isArray(tags) ? tags : String(tags ?? '').split(',');
  return [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))].join(',');
}

// LIKE 的 % 和 _ 是通配符，用户输入里带上它们会意外放大匹配范围，配合 ESCAPE '\\' 使用
function escapeLike(s) {
  return String(s ?? '').replace(/[\\%_]/g, '\\$&');
}

module.exports = { now, normalizeTags, escapeLike };
