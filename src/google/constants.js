// constants.js —— Google 数据抓取相关常量

module.exports = {
  // GSC 数据有 2~3 天延迟，GA4 也有小时级延迟。
  // 把区间结束日往回推，避免把还没回填的空数据算进"最近 N 天"里导致指标系统性偏低。
  DATA_LAG_DAYS: 3,

  // GSC 单次请求上限 25000 行，超过要翻页
  GSC_PAGE_SIZE: 25000,
  GSC_MAX_PAGES: 8,

  // GA4 runReport 单次最多返回的行数，超出靠 offset 翻页；翻满 GA4_MAX_PAGES 仍未取完视为截断
  GA4_PAGE_SIZE: 100000,
  GA4_MAX_PAGES: 20,

  // GA4 累计回填起点：取一个早于任何 GA4 资源开始采数的日期，让 GA4 只返回它实际有的数据。
  // 这样「从资源有数据那天开始累计」由 GA4 自己界定，我们不需要知道确切的起始日。
  GA_BACKFILL_START: '2020-01-01',

  // GSC 过滤表达式最长 4096 字符，按这个上限把 URL 列表切成几批
  GSC_FILTER_MAX: 4096,
  REGEX_OVERHEAD: 64,
};
