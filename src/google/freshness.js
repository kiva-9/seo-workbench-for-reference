// freshness.js —— 数据定稿判断：Google 的数据有延迟且会回填，太早抓到的数字偏低

const { fmtDate, parseDay, addDays } = require('../lib/dates');
const { DATA_LAG_DAYS } = require('./constants');

// 一个统计窗口的「定稿日」= 窗口结束日 + 数据延迟天数。
// 在这天之前抓到的数字会偏低——Google 那时还在回填。
function settledDate(endDate) {
  const d = parseDay(endDate);
  return d ? fmtDate(addDays(d, DATA_LAG_DAYS)) : null;
}

// 这次抓取是不是「抢跑」了：抓取时刻早于定稿日。
// 抓取全靠手动触发，没有东西会替你重刷，所以要在看数的时候把这件事说出来，
// 否则一份偏低的数字和一份定稿的数字在界面上长得一模一样。
function fetchedTooEarly(fetchedAt, endDate) {
  if (!fetchedAt || !endDate) return false;
  const settled = settledDate(endDate);
  return Boolean(settled) && String(fetchedAt).slice(0, 10) < settled;
}

// 结束日落在 Google 还没回填完的窗口里时给个提醒（不改区间，只提示）
function lagWarning({ endDate }) {
  const safe = fmtDate(addDays(new Date(), -DATA_LAG_DAYS));
  return endDate > safe
    ? `结束日期 ${endDate} 还在 Google 的数据延迟窗口内（约 ${DATA_LAG_DAYS} 天），最后几天的数字可能偏低或为空`
    : null;
}

module.exports = { settledDate, fetchedTooEarly, lagWarning };
