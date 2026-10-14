// gsc.js —— Search Console API：列站点、按 page 抓指标、按 page + query 抓明细、数据新鲜度探测

const { shiftDay, businessToday } = require('../lib/business-dates');
const { createIndex, indexPut } = require('../lib/url-match');
const { chunkPathsForRegex, buildPathRegex } = require('./filters');
const { GSC_PAGE_SIZE, GSC_MAX_PAGES, GSC_FILTER_MAX } = require('./constants');
const { sourceResponseError } = require('./source-request');

function createGsc({ getAccessToken,beforeRequest=()=>{} }) {
  const fetchGoogle=async (...args)=>{await beforeRequest();return fetch(...args);};
  async function gscListSites(accountId) {
    const token = await getAccessToken(accountId);
    const resp = await fetchGoogle('https://searchconsole.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`获取 GSC 站点失败: ${data.error?.message || resp.status}`);
    return (data.siteEntry || [])
      .filter((s) => s.permissionLevel && s.permissionLevel !== 'siteUnverifiedUser')
      .map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
  }

  // 返回 { index, truncated, raw }；index 支持按「主机+路径」和「纯路径」两种方式查。
  // raw 是原始响应行 [{ page, clicks, impressions, ctr, position }]，供月度同步按
  // 原始完整 URL 精确计数（index 会丢原始 URL，任务07起必须能看到）；
  // 快照/旧指标路径只消费 index，行为不变。
  //
  // trackedUrls 非空时走服务端过滤：按路径正则分批，每批一次请求，
  // Google 只回我们关心的那些页面。整站几万页也只回几百行，既省流量也省配额。
  // 传空数组则拉全站。
  async function gscQuery(accountId, siteUrl, startDate, endDate, trackedUrls = [], { dataState = 'final' } = {}) {
    if (!['all', 'final'].includes(dataState)) throw new Error('GSC dataState 必须为 all 或 final');
    const token = await getAccessToken(accountId);
    const encoded = encodeURIComponent(siteUrl);
    const index = createIndex();
    const raw = [];
    let truncated = false;

    const batches = trackedUrls.length ? chunkPathsForRegex(trackedUrls) : [null];

    const runQuery = async (body) => {
      const resp = await fetchGoogle(
        `https://searchconsole.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw sourceResponseError(`抓取 GSC 数据失败: ${data.error?.message || resp.status}`,resp);
      return data;
    };

    for (const paths of batches) {
      let expression = paths ? buildPathRegex(paths) : null;
      if (expression && expression.length > GSC_FILTER_MAX) {
        console.warn(`[GSC] 过滤表达式超长（${expression.length} > ${GSC_FILTER_MAX}），该批退回全量拉取`);
        expression = null;
      }
      const filter = expression
        ? [{ groupType: 'and', filters: [{ dimension: 'page', operator: 'includingRegex', expression }] }]
        : undefined;

      for (let page = 0; page < GSC_MAX_PAGES; page++) {
        const data = await runQuery({
          startDate, endDate, dataState,
          dimensions: ['page'],
          rowLimit: GSC_PAGE_SIZE,
          startRow: page * GSC_PAGE_SIZE,
          ...(filter ? { dimensionFilterGroups: filter } : {}),
        });

        const rows = data.rows || [];
        for (const row of rows) {
          const pageUrl = row.keys?.[0];
          if (!pageUrl) continue;
          const value = {
            clicks: row.clicks || 0,
            impressions: row.impressions || 0,
            ctr: row.ctr || 0,
            position: row.position || 0,
          };
          indexPut(index, pageUrl, value);
          raw.push({ page: pageUrl, ...value });
        }
        if (rows.length < GSC_PAGE_SIZE) break;
        if (page === GSC_MAX_PAGES - 1) truncated = true;
      }
    }
    return { index, truncated, raw };
  }

  // GSC 按 page + query 双维度抓取（用于全量快照）。
  // trackedUrls 非空时走服务端 page 过滤（和 gscQuery 一样按路径正则分批），
  // 返回 { rows: [{page, query, clicks, impressions, ctr, position}], truncated }
  async function gscPageQuery(accountId, siteUrl, startDate, endDate, trackedUrls = [], maxRows = 25000) {
    const token = await getAccessToken(accountId);
    const encoded = encodeURIComponent(siteUrl);
    const rows = [];
    let truncated = false;

    const runQuery = async (body) => {
      const resp = await fetchGoogle(
        `https://searchconsole.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(`抓取 GSC page+query 数据失败: ${data.error?.message || resp.status}`);
      return data;
    };

    const batches = trackedUrls.length ? chunkPathsForRegex(trackedUrls) : [null];
    const maxPages = Math.ceil(maxRows / GSC_PAGE_SIZE);

    for (const paths of batches) {
      let expression = paths ? buildPathRegex(paths) : null;
      if (expression && expression.length > GSC_FILTER_MAX) {
        console.warn(`[GSC] 快照过滤表达式超长（${expression.length} > ${GSC_FILTER_MAX}），该批退回全量拉取`);
        expression = null;
      }
      const filter = expression
        ? [{ groupType: 'and', filters: [{ dimension: 'page', operator: 'includingRegex', expression }] }]
        : undefined;

      for (let page = 0; page < maxPages; page++) {
        if (rows.length >= maxRows) { truncated = true; break; }
        const data = await runQuery({
          startDate, endDate,
          dimensions: ['page', 'query'],
          rowLimit: GSC_PAGE_SIZE,
          startRow: page * GSC_PAGE_SIZE,
          ...(filter ? { dimensionFilterGroups: filter } : {}),
        });

        const pageRows = data.rows || [];
        for (const row of pageRows) {
          if (rows.length >= maxRows) { truncated = true; break; }
          const pageUrl = row.keys?.[0];
          const query = row.keys?.[1];
          if (!pageUrl || !query) continue;
          rows.push({
            page: pageUrl,
            query,
            clicks: row.clicks || 0,
            impressions: row.impressions || 0,
            ctr: row.ctr || 0,
            position: row.position || 0,
          });
        }
        if (pageRows.length < GSC_PAGE_SIZE) break;
      }
      if (truncated) break;
    }
    return { rows, truncated };
  }

  // 数据新鲜度探测：最近 N 天里 GSC 实际有数据的最后一天（dataState=all 拿未结算数据）。
  // 本月临时数据的窗口截止日用它——两个来源各自的最新日期可能不同。
  // 返回 'YYYY-MM-DD' 或 null（探测窗口内完全没有数据/请求失败由调用方处理）。
  async function gscLatestDate(accountId, siteUrl, { days = 7, today = businessToday() } = {}) {
    const token = await getAccessToken(accountId);
    const encoded = encodeURIComponent(siteUrl);
    const end = shiftDay(today, -1);
    const start = shiftDay(today, -days);
    const resp = await fetchGoogle(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: start, endDate: end, type: 'web',
          dimensions: ['date'], rowLimit: days + 1, dataState: 'all',
        }),
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw sourceResponseError(`GSC 新鲜度探测失败: ${data.error?.message || resp.status}`,resp);
    const dates = (data.rows || [])
      .map((row) => String(row.keys?.[0] || ''))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    return dates.length ? dates[dates.length - 1] : null;
  }

  return { gscListSites, gscQuery, gscPageQuery, gscLatestDate };
}

module.exports = { createGsc };
