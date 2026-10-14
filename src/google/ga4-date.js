const { isValidDay } = require('../lib/business-dates');

// Google 的 date 维度使用 YYYYMMDD；所有消费者按业务日比较和查找日期。
function normalizeGa4Date(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const day = /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
  if (!isValidDay(day)) throw new Error('GA4 返回的 date 维度不是有效日期');
  return day;
}

module.exports = { normalizeGa4Date };
