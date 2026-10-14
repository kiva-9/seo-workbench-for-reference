// http.js —— Express 路由通用小工具：异步错误兜底、ID 校验、字段白名单

// 把 async 路由的异常交给统一错误中间件，避免变成 unhandledRejection 打挂进程
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 解析并校验路径里的数字 ID
function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function badId(res) {
  return res.status(400).json({ error: '无效的 ID' });
}

// 从 body 里挑出白名单字段
function pick(body, allowed) {
  const data = {};
  for (const k of allowed) if (body[k] !== undefined) data[k] = body[k];
  return data;
}

// 空字符串 -> null（给可空的数字列用）
function nullableNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 旧写接口退役（任务14）：统一 410，调用方不再写旧表；hint 指向新入口
function retired(res, hint) {
  return res.status(410).json({
    error: '该接口已退役，不再写入旧数据模型' + (hint ? '；' + hint : ''),
  });
}

module.exports = { wrap, parseId, badId, pick, nullableNumber, retired };
