// ga4.js —— GA4 Admin / Data API：列资源、列事件、按页面或按来源抓会话/用户/浏览/关键事件

const { normPathname } = require('../lib/url-match');
const { fmtDate } = require('../lib/dates');
const { chunkPathsForRegex, buildPagePathRegex } = require('./filters');
const { GA4_PAGE_SIZE, GA4_MAX_PAGES } = require('./constants');
const { sourceResponseError } = require('./source-request');
const { normalizeGa4Date } = require('./ga4-date');

// 翻满 GA4_MAX_PAGES 仍未取完时的提示。这种情况下本次抓取的那一路会整段作废
// （见 fetch-ga4.js 的 mainUsable/keyUsable），宁可白跑一次也不写半截数据进累计表。
const TRUNCATED_MSG = (what) =>
  `${what}超出单次抓取上限（已翻 ${GA4_MAX_PAGES} 页仍未取完），本次未入库以免累计出错；` +
  '请缩小抓取范围（减少登记 URL 或分批抓取）后重试。';

// GA4 runReport 一次最多返回 GA4_PAGE_SIZE 行，超出必须靠 offset 翻页。
// 响应里的 rowCount 是「满足条件的总行数」，据此翻到取完为止。
// 只发一次请求、超了就置个截断标志是不够的：累计表照样会把 settled_through
// 推到今天，被丢掉的那段永远补不回来。所以这里统一走分页。
//
// onRow 逐行回调（各查询自己往 byDate 里塞）；返回 { truncated } 表示是否撞到页数上限。
async function ga4RunReport(token, propertyId, body, onRow, label,beforeRequest=()=>{}) {
  let offset = 0;
  let total = 0;
  for (let page = 0; page < GA4_MAX_PAGES; page++) {
    await beforeRequest();
    const resp = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, limit: GA4_PAGE_SIZE, offset }),
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw sourceResponseError(`${label}失败: ${data.error?.message || resp.status}`,resp);

    const rows = data.rows || [];
    for (const row of rows) onRow(row);
    if (page === 0) total = Number(data.rowCount || 0);
    offset += rows.length;
    if (!rows.length) return { truncated: false };
    // rowCount 缺失时退化成「装满一页就再翻一页」
    const more = total > 0 ? offset < total : rows.length >= GA4_PAGE_SIZE;
    if (!more) return { truncated: false };
  }
  return { truncated: true };
}

function createGa4({ getAccessToken,beforeRequest=()=>{} }) {
  const fetchGoogle=async (...args)=>{await beforeRequest();return fetch(...args);};
  async function ga4ListProperties(accountId) {
    const token = await getAccessToken(accountId);
    const props = [];
    let pageToken = '';
    do {
      const url = new URL('https://analyticsadmin.googleapis.com/v1beta/accountSummaries');
      url.searchParams.set('pageSize', '200');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const resp = await fetchGoogle(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(`获取 GA4 资源失败: ${data.error?.message || resp.status}`);
      for (const acc of data.accountSummaries || []) {
        for (const p of acc.propertySummaries || []) {
          props.push({
            propertyId: String(p.property || '').split('/').pop(),
            displayName: p.displayName,
            accountDisplayName: acc.displayName,
          });
        }
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return props;
  }

  // trackedUrls 非空时同样走服务端过滤，和 GSC 一个思路，只是维度是纯路径。
  // 带 date 维度：返回 Map<pagePath, Map<date, {sessions,users,pageviews}>>，
  // 供累计逻辑按「每个 URL 已累计到的日期」拆分新增段，避免重复累加。
  async function ga4Query(accountId, propertyId, startDate, endDate, trackedUrls = []) {
    const token = await getAccessToken(accountId);
    const byDate = new Map();
    let truncated = false;

    const batches = trackedUrls.length ? chunkPathsForRegex(trackedUrls) : [null];

    for (const paths of batches) {
      const r = await ga4RunReport(token, propertyId, {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'pagePath' }, { name: 'date' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }],
        ...(paths ? {
          dimensionFilter: {
            filter: {
              fieldName: 'pagePath',
              stringFilter: { matchType: 'FULL_REGEXP', value: buildPagePathRegex(paths), caseSensitive: false },
            },
          },
        } : {}),
      }, (row) => {
        const pRaw = row.dimensionValues?.[0]?.value || '';
        const date = normalizeGa4Date(row.dimensionValues?.[1]?.value);
        if (!pRaw || !date) return;
        // 用归一化路径当 key（去尾斜杠），和 listUrls 里登记的路径对齐，否则查不到
        const p = normPathname(pRaw);
        const m = row.metricValues || [];
        const acc = byDate.get(p) || new Map();
        const cur = acc.get(date) || { sessions: 0, users: 0, pageviews: 0 };
        cur.sessions += Number(m[0]?.value || 0);
        cur.users += Number(m[1]?.value || 0);
        cur.pageviews += Number(m[2]?.value || 0);
        acc.set(date, cur);
        byDate.set(p, acc);
      }, '抓取 GA4 数据',beforeRequest);
      if (r.truncated) truncated = true;
    }
    return { byDate, truncated };
  }

  // 关键事件数：按 pagePath+date 拆分、只统计项目配置的事件名（如询盘）的 eventCount 总和。
  // 不能塞进 ga4Query —— GA4 的 dimensionFilter 会作用于所有指标，加了 eventName 过滤
  // sessions/users/pageviews 也会被一起过滤掉。所以独立发一次查询，本地用 byDate 合并。
  async function ga4KeyEventsQuery(accountId, propertyId, startDate, endDate, trackedUrls, eventNames) {
    const token = await getAccessToken(accountId);
    const byDate = new Map();
    let truncated = false;

    const batches = trackedUrls.length ? chunkPathsForRegex(trackedUrls) : [null];

    for (const paths of batches) {
      // 事件名过滤（必带）+ 可选的页面路径过滤，两个条件 AND
      const andExprs = [
        { filter: { fieldName: 'eventName', inListFilter: { values: eventNames } } },
      ];
      if (paths) {
        andExprs.unshift({
          filter: {
            fieldName: 'pagePath',
            stringFilter: { matchType: 'FULL_REGEXP', value: buildPagePathRegex(paths), caseSensitive: false },
          },
        });
      }
      const r = await ga4RunReport(token, propertyId, {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'pagePath' }, { name: 'date' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: { andGroup: { expressions: andExprs } },
      }, (row) => {
        const pRaw = row.dimensionValues?.[0]?.value || '';
        const date = normalizeGa4Date(row.dimensionValues?.[1]?.value);
        if (!pRaw || !date) return;
        const p = normPathname(pRaw); // 归一化路径当 key，和登记路径对齐
        const m = row.metricValues || [];
        const acc = byDate.get(p) || new Map();
        const cur = acc.get(date) || { keyEvents: 0 };
        cur.keyEvents += Number(m[0]?.value || 0);
        acc.set(date, cur);
        byDate.set(p, acc);
      }, '抓取 GA4 关键事件',beforeRequest);
      if (r.truncated) truncated = true;
    }
    return { byDate, truncated };
  }

  // 按来源抓会话/用户：sessionSource（会话来源，根域名级）+ date 维度。
  // 返回 Map<sessionSource, Map<date, { sessions, users }>>，source 为空/「(not set)」的行跳过。
  //
  // 注意：GA4 Data API 没有 sessionReferrer 维度（URL 级），最接近的是 sessionSource（根域名级），
  // 对应 GA4 后台"流量获取 → 来源/媒介"报告。同根域名的多条外链无法区分到 URL 级。
  //
  // urls：传一组根域名时用 inListFilter 精确限定到这批根域名（外链反查就是这么用的）；
  // 不传则按 medium=referral 过滤，只看转介流量。
  async function ga4ReferrerQuery(accountId, propertyId, startDate, endDate, urls = null) {
    const token = await getAccessToken(accountId);
    const byDate = new Map();
    const andExprs = [];
    if (urls && urls.length) {
      andExprs.push({ filter: { fieldName: 'sessionSource', inListFilter: { values: urls } } });
    } else {
      andExprs.push({ filter: { fieldName: 'sessionMedium', inListFilter: { values: ['referral'] } } });
    }
    const r = await ga4RunReport(token, propertyId, {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'sessionSource' }, { name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      dimensionFilter: andExprs.length === 1 ? andExprs[0] : { andGroup: { expressions: andExprs } },
    }, (row) => {
      const ref = (row.dimensionValues?.[0]?.value || '').trim();
      const date = normalizeGa4Date(row.dimensionValues?.[1]?.value);
      if (!ref || ref === '(not set)' || !date) return;
      const m = row.metricValues || [];
      const acc = byDate.get(ref) || new Map();
      const cur = acc.get(date) || { sessions: 0, users: 0 };
      cur.sessions += Number(m[0]?.value || 0);
      cur.users += Number(m[1]?.value || 0);
      acc.set(date, cur);
      byDate.set(ref, acc);
    }, '抓取 GA4 站外来源',beforeRequest);
    return { byDate, truncated: r.truncated };
  }

  // 按来源抓关键事件：sessionSource+date 拆分、只统计项目配置的事件名（如询盘）。
  // 不能塞进 ga4ReferrerQuery（dimensionFilter 作用于所有指标），单独发一次查询。
  // urls 参数同上。
  async function ga4ReferrerKeyEventsQuery(accountId, propertyId, startDate, endDate, eventNames, urls = null) {
    const token = await getAccessToken(accountId);
    const byDate = new Map();
    const andExprs = [
      { filter: { fieldName: 'eventName', inListFilter: { values: eventNames } } },
    ];
    if (urls && urls.length) {
      andExprs.push({ filter: { fieldName: 'sessionSource', inListFilter: { values: urls } } });
    } else {
      andExprs.push({ filter: { fieldName: 'sessionMedium', inListFilter: { values: ['referral'] } } });
    }
    const r = await ga4RunReport(token, propertyId, {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'sessionSource' }, { name: 'date' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { andGroup: { expressions: andExprs } },
    }, (row) => {
      const ref = (row.dimensionValues?.[0]?.value || '').trim();
      const date = normalizeGa4Date(row.dimensionValues?.[1]?.value);
      if (!ref || ref === '(not set)' || !date) return;
      const acc = byDate.get(ref) || new Map();
      const cur = acc.get(date) || { keyEvents: 0 };
      cur.keyEvents += Number(row.metricValues?.[0]?.value || 0);
      acc.set(date, cur);
      byDate.set(ref, acc);
    }, '抓取 GA4 站外关键事件',beforeRequest);
    return { byDate, truncated: r.truncated };
  }

  // 列出某个 GA4 资源最近 90 天出现过的所有事件名（供项目配置关键事件时勾选）
  // 数据新鲜度探测：GA4 实际有数据的最后一天（runReport 的 date 维度）。
  // 本月临时数据的 GA4 窗口截止日——与 GSC 各自独立，两者可能不同。
  // 返回 'YYYY-MM-DD' 或 null。
  async function ga4LatestDate(accountId, propertyId, { days = 7 } = {}) {
    const token = await getAccessToken(accountId);
    const dates = [];
    await ga4RunReport(token, propertyId, {
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'eventCount' }],
      limit: days + 1,
    }, (row) => {
      const value = normalizeGa4Date(row.dimensionValues?.[0]?.value);
      if (value) dates.push(value);
    }, 'GA4 新鲜度探测',beforeRequest);
    dates.sort();
    return dates.length ? dates[dates.length - 1] : null;
  }

  async function ga4ListEvents(accountId, propertyId) {
    const token = await getAccessToken(accountId);
    const end = new Date();
    const start = new Date(end.getTime() - 90 * 86400000);
    const seen = new Set();
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const resp = await fetchGoogle(
        `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dateRanges: [{ startDate: fmtDate(start), endDate: fmtDate(end) }],
            dimensions: [{ name: 'eventName' }],
            metrics: [{ name: 'eventCount' }],
            limit: 10000,
            offset,
          }),
        }
      );
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(`获取 GA4 事件列表失败: ${data.error?.message || resp.status}`);
      for (const row of data.rows || []) {
        const name = row.dimensionValues?.[0]?.value;
        if (name) seen.add(name);
      }
      total = data.rowCount || 0;
      offset += (data.rows || []).length;
    }
    return [...seen].sort();
  }

  return {
    ga4ListProperties, ga4ListEvents,
    ga4Query, ga4KeyEventsQuery, ga4ReferrerQuery, ga4ReferrerKeyEventsQuery,
    ga4LatestDate,
  };
}

module.exports = { createGa4, TRUNCATED_MSG };
