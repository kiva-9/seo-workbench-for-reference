// fetch-ga4.js —— 抓 GA4 并本地增量累计：站内 URL（ga4_metrics）+ 我发的外链（external_links）
//
// 每类实体（每条站内 URL / 每条登记的外链）在本地存「已累计到的日期」settled_through + 累计总数。
// 每次抓取只查 settled_through 之后的新增段，加进本地累计，再把水位往前推。
// 老数据第一次抓取时就进了本地账本，之后 GA4 过了保留期删掉也不影响。

const { normPath } = require('../lib/url-match');
const { rootDomain } = require('../lib/root-domain');
const { fmtDate, parseDay, addDays, today } = require('../lib/dates');
const { DATA_LAG_DAYS, GA_BACKFILL_START } = require('./constants');
const { isAuthError } = require('./oauth');
const { resolveAccounts, parseKeyEventNames } = require('./project-config');
const { TRUNCATED_MSG } = require('./ga4');

// 把 Map<date, { field: n }> 里「date > 已累计日 through」的部分求和 —— 只加新增段，已累计的不重复加。
// through 为 null/undefined 表示还没累计过，那全部日期都算新增。
function sumSince(dateMap, field, through) {
  if (!dateMap) return 0;
  let total = 0;
  for (const [date, m] of dateMap) {
    if (through && date <= through) continue;
    total += (m && m[field]) || 0;
  }
  return total;
}

// 本次增量查询的共享起点：只要还有「没见过」的实体就整段回填（新实体需要全量历史），
// 否则取所有实体里累计最靠后那位 +1 天。已累计到最新的实体在窗口内没有新增，自然不加。
function incrementalStart(entities, throughField, lagEnd) {
  const hasNew = entities.some((e) => !e[throughField]);
  if (hasNew) return GA_BACKFILL_START;
  const throughs = entities.map((e) => e[throughField]).filter(Boolean);
  if (!throughs.length) return GA_BACKFILL_START;
  // ISO 日期字符串可直接按字典序取最小（不要用 Math.min，它会把字符串转成数字变成 NaN）
  const minThrough = throughs.reduce((a, b) => (a < b ? a : b));
  const start = fmtDate(addDays(parseDay(minThrough), 1));
  return start <= lagEnd ? start : null; // null = 没有新增，无需查询
}

function createGa4Fetchers({ db, ga4 }) {
  // 抓取单个项目的 GA4 累计（会话/用户/浏览/关键事件）并增量入库 ga4_metrics。
  // 每次只把「已累计日 → 今天-延迟」的新增段加进本地累计，老数据永久留在本地，不受 GA4 保留期影响。
  async function fetchProjectGa4(project) {
    const { ga4AccountId } = resolveAccounts(project);
    if (!ga4AccountId || !project.ga4_property_id) {
      return { fetched: 0, warnings: [], sources: { ga4: 'skip', keyEvents: 'skip' } };
    }
    const urls = await db.listUrls(project.id);
    if (!urls.length) return { fetched: 0, warnings: ['该项目还没有登记任何 URL'], sources: { ga4: 'skip', keyEvents: 'skip' } };

    const keyEventNames = parseKeyEventNames(project.key_event_names);
    const keyEventsEnabled = keyEventNames.length > 0;

    const ga4Rows = await db.getGa4Metrics(project.id);
    const existing = new Map(ga4Rows.map((r) => [r.url_id, r]));
    const lagEnd = fmtDate(addDays(parseDay(today()), -DATA_LAG_DAYS));

    const mainStart = incrementalStart(urls.map((u) => existing.get(u.id) || {}), 'settled_through', lagEnd);
    const keyStart = keyEventsEnabled ? incrementalStart(urls.map((u) => existing.get(u.id) || {}), 'key_events_through', lagEnd) : null;

    const warnings = [];
    const sources = { ga4: 'skip', keyEvents: 'skip' };

    const runMain = !mainStart ? Promise.resolve({ byDate: new Map() }) :
      ga4.ga4Query(ga4AccountId, project.ga4_property_id, mainStart, lagEnd, urls.map((u) => u.url))
        .then((r) => { sources.ga4 = r.truncated ? 'truncated' : 'ok'; if (r.truncated) warnings.push(TRUNCATED_MSG('GA4 页面数据')); return r; })
        .catch((e) => { sources.ga4 = 'fail'; warnings.push(`GA4: ${e.message}`); return { byDate: null, authError: isAuthError(e) }; });

    const runKey = !keyStart ? Promise.resolve({ byDate: new Map() }) :
      ga4.ga4KeyEventsQuery(ga4AccountId, project.ga4_property_id, keyStart, lagEnd, urls.map((u) => u.url), keyEventNames)
        .then((r) => { sources.keyEvents = r.truncated ? 'truncated' : 'ok'; if (r.truncated) warnings.push(TRUNCATED_MSG('GA4 关键事件')); return r; })
        .catch((e) => { sources.keyEvents = 'fail'; warnings.push(`关键事件: ${e.message}`); return { byDate: null }; });

    const [main, key] = await Promise.all([runMain, runKey]);
    if (sources.ga4 === 'fail') throw new Error(warnings.join('；') || '抓取失败');
    if (main.authError) throw new Error(warnings.join('；'));

    // 结果被截断时这一路整段作废：既不写这次的部分和，也不推进 settled_through。
    // 只做其中一件都会错——不推进却写入，下次从同一起点再加一遍（重复计数）；
    // 推进却不写入，缺的那段永远补不回来。整段作废最多是这次白跑，数字始终是对的。
    const mainUsable = Boolean(main.byDate) && !main.truncated;
    const keyUsable = keyEventsEnabled && Boolean(key.byDate) && !key.truncated;

    const rows = urls.map((u) => {
      const prev = existing.get(u.id) || {};
      // byDate 的 key 是归一化路径（见 ga4Query），这里用登记 URL 的归一化路径来查，
      // 不能用完整 URL——否则永远匹配不上
      const path = normPath(u.url);
      const m = mainUsable ? main.byDate.get(path) : null;
      const k = keyUsable ? key.byDate.get(path) : null;
      return {
        url_id: u.id, project_id: project.id,
        sessions: (prev.sessions || 0) + sumSince(m, 'sessions', prev.settled_through),
        users: (prev.users || 0) + sumSince(m, 'users', prev.settled_through),
        pageviews: (prev.pageviews || 0) + sumSince(m, 'pageviews', prev.settled_through),
        // 截断时保持原水位（settled_through 是直接覆盖写入，不走 COALESCE）
        settled_through: mainUsable ? lagEnd : (prev.settled_through ?? null),
        // 关键事件：查询成功且未截断才累加并推进；失败/截断/未配置传 undefined 保留旧值
        key_events: keyUsable ? (prev.key_events || 0) + sumSince(k, 'keyEvents', prev.key_events_through) : undefined,
        key_events_through: keyUsable ? lagEnd : undefined,
      };
    });

    await db.saveGa4Metrics(rows);
    return { fetched: rows.length, startDate: mainStart || GA_BACKFILL_START, endDate: lagEnd, warnings, sources };
  }

  // 抓取"我发的外链"反查累计：拿用户登记的 URL 列表提取根域名，去 GA4 sessionSource 反查，
  // 看每条根域名带来了多少会话/用户/关键事件。本地累计到 lagEnd，每次只加"上次之后"的新增段，
  // 跟 fetchProjectGa4 一个思路，老数据永久留本地。
  //
  // 重要限制：GA4 sessionSource 是根域名级（zhihu.com），不是 URL 级。
  // 同根域名的多条登记会拿到相同的累计数（GA4 那边根本不区分到 URL 级）。
  async function fetchProjectExternalLinks(project) {
    const { ga4AccountId } = resolveAccounts(project);
    if (!ga4AccountId || !project.ga4_property_id) throw new Error('该项目尚未绑定 GA4 资源');
    const links = await db.listExternalLinks(project.id);
    if (!links.length) {
      return { fetched: 0, warnings: ['该项目还没有登记任何外链 URL，请先在下方表格添加'], sources: { ga4: 'skip', keyEvents: 'skip' } };
    }

    const keyEventNames = parseKeyEventNames(project.key_event_names);
    const keyEventsEnabled = keyEventNames.length > 0;

    // 按根域名分组；同根域名的多条登记共享一次反查（GA4 sessionSource 只到根域名级）
    const byRoot = new Map(); // root_domain -> [link...]
    for (const l of links) {
      const rd = rootDomain(l.url);
      if (!byRoot.has(rd)) byRoot.set(rd, []);
      byRoot.get(rd).push(l);
    }
    const rootDomains = [...byRoot.keys()];
    // 反查起点按「每条 link 自己的」累计日判断，而不是按组内最大值：
    // 同根域名只要有一条是新的（settled_through NULL），incrementalStart 就走 hasNew 分支整段回填，
    // 这样后加的新 link 才能拿到完整历史；各自的 sumSince 用各自的值，不会重复累加。
    const rootEntities = links.map((l) => ({
      settled_through: l.settled_through,
      key_events_through: l.key_events_through,
    }));

    const lagEnd = fmtDate(addDays(parseDay(today()), -DATA_LAG_DAYS));
    const warnings = [];
    const sources = { ga4: 'skip', keyEvents: 'skip' };

    const mainStart = incrementalStart(rootEntities, 'settled_through', lagEnd);
    const keyStart = keyEventsEnabled ? incrementalStart(rootEntities, 'key_events_through', lagEnd) : null;

    // GA4 的 inListFilter 单次最多 100 个值；登记根域名超过 100 个时拆批查询再合并，避免查询直接报错。
    const IN_LIST_MAX = 100;
    const rootChunks = [];
    for (let i = 0; i < rootDomains.length; i += IN_LIST_MAX) {
      rootChunks.push(rootDomains.slice(i, i + IN_LIST_MAX));
    }
    // 对给定窗口逐个 chunk 跑反查，把各 chunk 的 byDate 合并成一张
    //（主查询含 sessions/users，关键事件查询含 keyEvents，合并时错位字段补 0）。
    async function runChunks(start, isKey) {
      const byDate = new Map();
      let truncated = false;
      for (const chunk of rootChunks) {
        const r = isKey
          ? await ga4.ga4ReferrerKeyEventsQuery(ga4AccountId, project.ga4_property_id, start, lagEnd, keyEventNames, chunk)
          : await ga4.ga4ReferrerQuery(ga4AccountId, project.ga4_property_id, start, lagEnd, chunk);
        if (r.truncated) truncated = true;
        for (const [ref, dateMap] of r.byDate) {
          let acc = byDate.get(ref);
          if (!acc) { acc = new Map(); byDate.set(ref, acc); }
          for (const [date, m] of dateMap) {
            const cur = acc.get(date) || {};
            acc.set(date, {
              sessions: (cur.sessions || 0) + (m.sessions || 0),
              users: (cur.users || 0) + (m.users || 0),
              keyEvents: (cur.keyEvents || 0) + (m.keyEvents || 0),
            });
          }
        }
      }
      return { byDate, truncated };
    }

    const runMain = !mainStart ? Promise.resolve({ byDate: new Map() }) :
      runChunks(mainStart, false)
        .then((r) => { sources.ga4 = r.truncated ? 'truncated' : 'ok'; if (r.truncated) warnings.push(TRUNCATED_MSG('GA4 外链反查')); return r; })
        .catch((e) => { sources.ga4 = 'fail'; warnings.push(`GA4: ${e.message}`); return { byDate: null, authError: isAuthError(e) }; });

    // 关键事件查询用 keyStart（不是 mainStart）：会话和关键事件的累计进度可能不同步——
    // 关键事件名变化触发 resetKeyEventsAccumulation 后 key_events_through 被清空、settled_through 没动，
    // 此时 keyStart 是 GA_BACKFILL_START 而 mainStart 是最近日期，用后者会漏掉整个历史段。
    const runKey = !keyStart ? Promise.resolve({ byDate: new Map() }) :
      runChunks(keyStart, true)
        .then((r) => { sources.keyEvents = r.truncated ? 'truncated' : 'ok'; if (r.truncated) warnings.push(TRUNCATED_MSG('GA4 外链关键事件')); return r; })
        .catch((e) => { sources.keyEvents = 'fail'; warnings.push(`关键事件: ${e.message}`); return { byDate: null }; });

    const [main, key] = await Promise.all([runMain, runKey]);
    if (sources.ga4 === 'fail') throw new Error(warnings.join('；') || '抓取失败');
    if (main.authError) throw new Error(warnings.join('；'));

    // 按根域名反查累计：byDate 的 key 是根域名（sessionSource 返回的值）。
    // sumSince 用每条 link 自己（l.*）的 settled_through/key_events_through，而不是组内的最大值——
    // 后加的同根域名 link 自带 settled_through=NULL，只有用它自己的值才能回填完整历史，
    // 否则新 link 永远只拿到「组已累计日之后」的新增段，比组内老 link 少一截（删掉老 link 时累计数会掉）。
    // 截断时这一路整段作废：不写部分和、不推进水位（理由同 fetchProjectGa4）
    const mainUsable = Boolean(main.byDate) && !main.truncated;
    const keyUsable = keyEventsEnabled && Boolean(key.byDate) && !key.truncated;

    const out = links.map((l) => {
      const rd = rootDomain(l.url);
      const m = mainUsable ? main.byDate.get(rd) : null;
      const k = keyUsable ? key.byDate.get(rd) : null;
      return {
        id: l.id,
        sessions: (l.sessions || 0) + sumSince(m, 'sessions', l.settled_through),
        users: (l.users || 0) + sumSince(m, 'users', l.settled_through),
        settled_through: mainUsable ? lagEnd : (l.settled_through ?? null),
        // 关键事件：查询成功且未截断才累加并推进；失败/截断/未配置传 undefined 保留旧值
        key_events: keyUsable ? (l.key_events || 0) + sumSince(k, 'keyEvents', l.key_events_through) : undefined,
        key_events_through: keyUsable ? lagEnd : undefined,
      };
    });

    await db.saveExternalLinksMetrics(out);
    return { fetched: out.length, startDate: mainStart || GA_BACKFILL_START, endDate: lagEnd, warnings, sources };
  }

  return { fetchProjectGa4, fetchProjectExternalLinks };
}

module.exports = { createGa4Fetchers, sumSince, incrementalStart };
