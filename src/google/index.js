// index.js —— Google 数据层对外入口：createGoogle(db) 组装 OAuth / GSC / GA4 / 抓取入库
// db 由调用方注入，测试可以只给一个带用到的那几个方法的假 db。

const dates = require('../lib/dates');
const { splitUrl, normPath, createIndex, indexPut, indexGet } = require('../lib/url-match');
const { rootDomain } = require('../lib/root-domain');
const { DATA_LAG_DAYS, GA_BACKFILL_START } = require('./constants');
const filters = require('./filters');
const { settledDate, fetchedTooEarly, lagWarning } = require('./freshness');
const { resolveAccounts, hasDataSource, parseKeyEventNames } = require('./project-config');
const { createOAuth } = require('./oauth');
const { createResourceDiscovery } = require('./resource-discovery');
const { createGsc } = require('./gsc');
const { createGa4 } = require('./ga4');
const { createGscFetchers } = require('./fetch-gsc');
const { createArticleMetricsFetchers } = require('./fetch-article-metrics');
const { createExternalDailyFetchers } = require('./fetch-external-daily');
const { createGa4Fetchers, sumSince, incrementalStart } = require('./fetch-ga4');
const { fail } = require('../services/mcp-common');

function createGoogle(db,{beforeRequest}={}) {
  const oauth = createOAuth(db,{beforeRequest});
  const gsc = createGsc({ getAccessToken: oauth.getAccessToken,beforeRequest });
  const ga4 = createGa4({ getAccessToken: oauth.getAccessToken,beforeRequest });
  const { fetchProjectGsc, fetchGscSnapshot } = createGscFetchers({ db, gsc });
  const { planArticleSync, fetchArticleMetrics,fetchArticleMetricsUnit,finalizeArticleMetricsUnit,markArticleMetricsUnitError } = createArticleMetricsFetchers({ db, gsc, ga4 });
  const { planExternalDaily, fetchExternalDaily,fetchExternalDailyUnit,finalizeExternalDailyUnit } = createExternalDailyFetchers({ db, ga4 });
  const { fetchProjectGa4, fetchProjectExternalLinks } = createGa4Fetchers({ db, ga4 });

  // 抓取单个项目：GSC(按月) + GA4(累计)，两个数据源独立成败、互不阻塞。
  async function fetchProjectMetrics(project, range) {
    const [gscRes, ga4Res] = await Promise.allSettled([
      fetchProjectGsc(project, range),
      fetchProjectGa4(project),
    ]);
    const okGsc = gscRes.status === 'fulfilled';
    const okGa4 = ga4Res.status === 'fulfilled';
    const gscOut = okGsc ? gscRes.value : null;
    const ga4Out = okGa4 ? ga4Res.value : null;

    const warnings = [];
    if (gscOut?.warnings) warnings.push(...gscOut.warnings);
    if (ga4Out?.warnings) warnings.push(...ga4Out.warnings);
    if (!okGsc) warnings.push(`GSC: ${gscRes.reason.message}`);
    if (!okGa4) warnings.push(`GA4: ${ga4Res.reason.message}`);
    if (!okGsc && !okGa4) throw new Error(warnings.join('；') || '抓取失败');

    return {
      fetched: (gscOut?.fetched || 0) + (ga4Out?.fetched || 0),
      matched: gscOut?.matched || 0,
      startDate: range.startDate, endDate: range.endDate, periodDays: range.periodDays,
      warnings,
      sources: {
        gsc: okGsc ? (gscOut.gsc || 'ok') : 'fail',
        ga4: okGa4 ? (ga4Out.sources?.ga4 || 'ok') : 'fail',
      },
    };
  }

  return {
    ...createResourceDiscovery({getAccessToken:oauth.getAccessToken,beforeRequest}),
    createArticleScoped: (scopedDb, checkAuthority) => createGoogle(scopedDb, { beforeRequest: checkAuthority }),
    // Background callers inject an authority-guarded backend without replacing the shared live database.
    createScoped: (scopedDb) => {
      let requests=0;
      const scoped=createGoogle(scopedDb,{beforeRequest:()=>{
        if(requests>=12)fail('BUDGET_EXCEEDED','同步单元超出 Google 请求预算',{max_google_requests:12});
        requests++;
      }});
      scoped.syncUnitUsage=()=>({google_requests:requests,...scopedDb.db.syncUnitUsage?.()});
      return scoped;
    },
    buildAuthUrl: oauth.buildAuthUrl,
    exchangeCode: oauth.exchangeCode,
    getAccessToken: oauth.getAccessToken,
    forgetAccount: oauth.forgetAccount,
    gscListSites: gsc.gscListSites,
    ga4ListProperties: ga4.ga4ListProperties,
    ga4ListEvents: ga4.ga4ListEvents,
    fetchProjectGsc, fetchGscSnapshot, fetchProjectGa4, fetchProjectMetrics,
    fetchProjectExternalLinks,
    // 站内文章月度同步（任务07）：单请求同步、独立来源重试、条件写守卫
    planArticleSync, fetchArticleMetrics,fetchArticleMetricsUnit,finalizeArticleMetricsUnit,markArticleMetricsUnitError,
    // 外链平台日数据同步（任务10）
    planExternalDaily, fetchExternalDaily,fetchExternalDailyUnit,finalizeExternalDailyUnit,
    rootDomain,
    monthRange: dates.monthRange,
    normalizeRange: dates.normalizeRange,
    recentMonths: dates.recentMonths,
    lastMonthKey: dates.lastMonthKey,
    currentMonthKey: dates.currentMonthKey,
    daysInclusive: dates.daysInclusive,
    lagWarning, settledDate, fetchedTooEarly, normPath, splitUrl, resolveAccounts, hasDataSource,
    DATA_LAG_DAYS, MAX_RANGE_DAYS: dates.MAX_RANGE_DAYS, GA_BACKFILL_START,
    // 下面这些导出给测试用，业务代码不该直接调（纯函数也可以直接从 src/lib、src/google/filters 引）
    _internal: {
      createIndex, indexPut, indexGet,
      buildPathRegex: filters.buildPathRegex,
      buildPagePathRegex: filters.buildPagePathRegex,
      chunkPathsForRegex: filters.chunkPathsForRegex,
      makeFilterPredicate: filters.makeFilterPredicate,
      pathVariants: filters.pathVariants,
      ga4KeyEventsQuery: ga4.ga4KeyEventsQuery,
      parseKeyEventNames, sumSince, incrementalStart,
    },
  };
}

module.exports = createGoogle;
