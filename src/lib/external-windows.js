// external-windows.js —— 外链平台窗口与冻结区间计算（纯函数，任务11）
//
// 契约（任务11）：
//   1. 平台身份 = 项目 × 域名。按该平台**完整登记清单（包括 inactive）**的发布日期切窗口；
//      无发布日保留未知，提示补填发布日期；未来日期不分配未来数据。
//   2. 相同起点组成一组，share=1/N；本组窗口 [起点, 下一组起点)，末组开放到数据截至日后一日。
//   3. 活跃参考区间 = 文章窗口 ∩ 当前活跃段（active_segment_started_at 起）。
//   4. 停用日停止分配：半开区间 [start, end)，end = min(停用日, 后继组起点, T−3 后一日)，
//      且不早于 start；交集为空 → 空段（值 0）；有应统计日期却没取数 → NULL + 不完整。
//   5. 冻结保存停用时已知值；恢复开新段从恢复日开始，不抢回后继窗口；同日启停空交集。
//   6. 平台总量永远从当前有效日数据单独 SUM，不冻结、不分摊。

const { DATA_LAG_DAYS } = require('../google/constants');

// 业务日合法性：YYYY-MM-DD 且真实存在
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDay(s) {
  if (!DAY_RE.test(String(s || ''))) return false;
  const [y, m, d] = String(s).split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function dayAfter(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// 一篇的参考起点：published_at（合法且不晚于 today）；缺失时保持未知；
// 未来日期不分配（返回 null，由调用方决定排队/忽略）。
function articleStart(article, today) {
  const pub = article?.published_at;
  if (isDay(pub) && pub <= today) return { start: pub, fallback: false };
  if (isDay(pub) && pub > today) return { start: null, future: true };
  return { start: null, missing: true };
}

// 平台窗口：完整登记清单（含 inactive）按参考起点分组。
// 返回 [{ start, end, articleIds, share, fallback }]；end 为开区间上界。
// dataThrough 之后一日作为末组上界；没有数据截至日时末组开放到 null（调用方按今天处理）。
function computePlatformWindows(articles, today, dataThrough = null) {
  const groups = new Map(); // start -> { start, articleIds, fallback }
  const skipped = [];
  for (const a of articles || []) {
    const s = articleStart(a, today);
    if (!s.start) { skipped.push({ id: a.id, url: a.url, ...s }); continue; }
    if (!groups.has(s.start)) groups.set(s.start, { start: s.start, articleIds: [], fallback: Boolean(s.fallback) });
    groups.get(s.start).articleIds.push(a.id);
    if (s.fallback) groups.get(s.start).fallback = true;
  }
  const sorted = [...groups.values()].sort((x, y) => (x.start < y.start ? -1 : 1));
  const lastEnd = dataThrough ? dayAfter(dataThrough) : null;
  return {
    windows: sorted.map((g, i) => ({
      start: g.start,
      end: i + 1 < sorted.length ? sorted[i + 1].start : lastEnd,
      articleIds: g.articleIds,
      share: 1 / g.articleIds.length,
      fallback: g.fallback,
    })),
    skipped,
  };
}

// 冻结区间：[max(窗口起点, 活跃段起点), min(停用日, 后继组起点, T−3 后一日))
// segmentStart：该文章当前活跃段的开始（新登记=发布起点；迁移=迁移日；恢复=恢复日）
// nextGroupStart：窗口中下一组的起点（本组非末组时）；末组为 null
// 交集为空 → { empty: true }
function computeFreezeRange({ windowStart, segmentStart, disabledAt, nextGroupStart, today, lagDays = DATA_LAG_DAYS }) {
  const start = [windowStart, segmentStart].filter(Boolean).sort().pop();
  const safeEnd = dayAfter(shiftDaySafe(today, -lagDays)); // T−3 后一日
  const ends = [disabledAt, safeEnd].filter(Boolean);
  if (nextGroupStart) ends.push(nextGroupStart);
  let end = ends.sort()[0];
  if (!end || end <= start) return { empty: true, start, end };
  return { empty: false, start, end };
}

// 纯日期减法（UTC 安全）
function shiftDaySafe(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// 日数据聚合：[from, to) 半开区间求和 + 完整性。
// rows: [{ date, value }]（同来源同指纹）。返回 { value, complete, unknown, coveredDays, expectedDays }。
// 全部日期都有行 → complete；部分有 → 已知和 + incomplete；一天都没有 → null（未知）。
function aggregateDaily(rows, from, to) {
  if (!from || !to || to <= from) return { value: 0, complete: true, unknown: false, coveredDays: 0, expectedDays: 0, empty: true };
  const expectedDays = daysBetween(from, to);
  const got = new Map();
  for (const r of rows || []) if (r.date >= from && r.date < to) got.set(r.date, r.value);
  if (!got.size) return { value: null, complete: false, unknown: true, coveredDays: 0, expectedDays };
  let sum = 0;
  for (const v of got.values()) sum += Number(v || 0);
  return {
    value: sum,
    complete: got.size >= expectedDays,
    unknown: false,
    coveredDays: got.size,
    expectedDays,
  };
}

function daysBetween(from, to) {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

// 活跃参考区间 = 文章窗口 ∩ 当前活跃段（任务11 第3条；冻结后由冻结值承接）
function activeReferenceRange(windowStart, windowEnd, segmentStart) {
  const start = [windowStart, segmentStart].filter(Boolean).sort().pop();
  if (windowEnd && start && start >= windowEnd) return { empty: true };
  return { empty: false, start, end: windowEnd };
}

module.exports = {
  isDay, dayAfter, articleStart, computePlatformWindows, computeFreezeRange,
  aggregateDaily, daysBetween, activeReferenceRange,
};
