// business-dates.js —— 业务日与自然月助手：口径统一为 Asia/Shanghai
//
// 为什么不用 src/lib/dates.js：那份助手按宿主本地时区取「今天」（getFullYear 等），
// 浏览器与运维脚本运行在不同时区时会算出不同的「今天」，
// 直接决定抓取范围、定稿判断和月度归属。这里所有「业务日」都按 Asia/Shanghai 推。
//
// 约定（任务04数据契约）：
//   - 业务日是 YYYY-MM-DD 字符串，今天可以由调用方注入
//   - 存储时间戳仍用 UTC（src/db/helpers.js 的 now()），字符 arithmetic 只搬日期不碰时刻
//   - 月份键 YYYY-MM；自然月边界由 ym 直接推导，不依赖宿主时区
//   - 禁止 toISOString().slice(0,10) 这种把 UTC 日当业务日的写法
// 纯函数，不碰数据库，不依赖 Node 内置模块——浏览器和 Node 使用同一份实现。

const TZ = 'Asia/Shanghai';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// 时区和格式固定，复用格式器避免逐篇、逐月分析时反复初始化 Intl。
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

// 指定时刻在 Asia/Shanghai 的业务日。en-CA 的输出就是 YYYY-MM-DD，无需再拼格式。
function businessDay(now = new Date()) {
  const parts = dayFormatter.formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function businessToday() {
  return businessDay(new Date());
}

function isValidDay(day) {
  if (!DATE_RE.test(String(day || ''))) return false;
  const [y, m, d] = day.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function monthOf(day) {
  return isValidDay(day) ? day.slice(0, 7) : null;
}

function isValidMonth(ym) {
  return MONTH_RE.test(String(ym || ''));
}

function parseMonth(ym) {
  return isValidMonth(ym) ? ym : null;
}

// 自然月边界：'2026-07' → { start: '2026-07-01', end: '2026-07-31', days: 31 }
// 全程 Date.UTC 算术，不碰宿主时区；2 月长度按公历规则由 Date 自己判定。
function monthBounds(ym) {
  if (!isValidMonth(ym)) throw new Error('月份格式不正确（应为 YYYY-MM）');
  const [y, m] = ym.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0)); // 下个月第 0 天 = 本月最后一天
  const pad = (n) => String(n).padStart(2, '0');
  return {
    start: `${y}-${pad(m)}-01`,
    end: `${y}-${pad(m)}-${pad(end.getUTCDate())}`,
    days: end.getUTCDate(),
  };
}

// 月份键 ±n：'2026-01' - 1 → '2025-12'
function shiftMonth(ym, n) {
  if (!isValidMonth(ym)) throw new Error('月份格式不正确（应为 YYYY-MM）');
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// 业务日 ±n 天。按 UTC 日运算，东八区没有夏令时，加减天数不会漂。
// 显式取 UTC 各部分格式化，不用 toISOString().slice（那是把 UTC 日当业务日的写法，禁）。
function shiftDay(day, n) {
  if (!isValidDay(day)) throw new Error('日期格式不正确（应为 YYYY-MM-DD）');
  const [y, m, d] = day.split('-').map(Number);
  const out = new Date(Date.UTC(y, m - 1, d + n));
  return `${out.getUTCFullYear()}-${String(out.getUTCMonth() + 1).padStart(2, '0')}-${String(out.getUTCDate()).padStart(2, '0')}`;
}

// 当月可以安全抓取的最后一天 = min(自然月最后一天, 业务今天 - lagDays)。
// 结束早于开始时返回 null，调用方「暂不请求、不写伪零」。
function safeMonthEnd(ym, today, lagDays = 0) {
  const { end } = monthBounds(ym);
  const safe = shiftDay(today, -lagDays);
  return safe < end ? safe : end;
}

module.exports = {
  TZ, DATE_RE, MONTH_RE,
  businessDay, businessToday, isValidDay, isValidMonth, parseMonth,
  monthOf, monthBounds, shiftMonth, shiftDay, safeMonthEnd,
};
