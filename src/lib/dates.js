// dates.js —— 日期与统计窗口：本地时区的 YYYY-MM-DD、自然月区间、自选区间校验
// 纯函数，不碰数据库，也不依赖 Google 模块。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// GSC 只保留最近 16 个月的数据，超出部分查不到
const MAX_RANGE_DAYS = 16 * 31;

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 用当天正午构造，避开夏令时切换导致的日期漂移
function parseDay(s) {
  if (!DATE_RE.test(String(s || ''))) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
  return Number.isNaN(dt.getTime()) || dt.getMonth() !== m - 1 ? null : dt;
}

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

// 含首尾的天数
function daysInclusive(startDate, endDate) {
  const a = parseDay(startDate), b = parseDay(endDate);
  if (!a || !b) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

function today() {
  return fmtDate(new Date());
}

// 自然月区间。'2026-07' -> 2026-07-01 ~ 2026-07-31
// 当月只取到今天为止（月份还没过完）
function monthRange(ym) {
  if (!MONTH_RE.test(String(ym || ''))) throw new Error('月份格式不正确（应为 YYYY-MM）');
  const [y, m] = ym.split('-').map(Number);
  const start = new Date(y, m - 1, 1, 12);
  const monthEnd = new Date(y, m, 0, 12); // 下个月的第 0 天 = 本月最后一天
  const todayD = parseDay(today());
  if (start > todayD) throw new Error('不能查询还没开始的月份');
  const end = monthEnd > todayD ? todayD : monthEnd;
  return {
    startDate: fmtDate(start), endDate: fmtDate(end),
    periodDays: Math.round((end - start) / 86400000) + 1,
    month: ym, partial: monthEnd > todayD, custom: false,
  };
}

// 上个完整自然月 —— 看板默认就看这个
function lastMonthKey(from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth() - 1, 1, 12);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function currentMonthKey(from = new Date()) {
  return `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`;
}

// 给前端下拉用的月份列表（从本月往前推）
function recentMonths(count = 16) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1, 12);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push({
      value: key,
      label: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`,
      current: i === 0,
    });
  }
  return out;
}

// 校验并规范化用户自选的区间
function normalizeRange(startDate, endDate) {
  const a = parseDay(startDate), b = parseDay(endDate);
  if (!a) throw new Error('开始日期格式不正确（应为 YYYY-MM-DD）');
  if (!b) throw new Error('结束日期格式不正确（应为 YYYY-MM-DD）');
  if (a > b) throw new Error('开始日期不能晚于结束日期');
  const todayD = parseDay(today());
  if (b > todayD) throw new Error('结束日期不能晚于今天');
  const periodDays = Math.round((b - a) / 86400000) + 1;
  if (periodDays > MAX_RANGE_DAYS) throw new Error(`区间最长 ${MAX_RANGE_DAYS} 天（Search Console 只保留最近 16 个月的数据）`);
  return { startDate: fmtDate(a), endDate: fmtDate(b), periodDays, custom: true };
}

// 从请求参数解析统计窗口：优先自定义区间，其次自然月，都没有就默认上个完整月
// src 可以是 req.query 也可以是 req.body
function resolveRange(src = {}) {
  if (src.start || src.end) return normalizeRange(src.start ?? src.startDate, src.end ?? src.endDate);
  if (src.startDate || src.endDate) return normalizeRange(src.startDate, src.endDate);
  return monthRange(src.month || lastMonthKey());
}

module.exports = {
  DATE_RE, MAX_RANGE_DAYS,
  fmtDate, parseDay, addDays, daysInclusive, today,
  monthRange, lastMonthKey, currentMonthKey, recentMonths, normalizeRange, resolveRange,
};
