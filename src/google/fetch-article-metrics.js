// fetch-article-metrics.js —— 站内文章月度同步执行器（任务07）
//
// 请求组织：「项目 × 月份 × URL过滤批次 × 来源」——不按 1000 篇逐篇逐月各打 3 路请求。
// 单篇刷新复用同一执行器（只是 URL 集合换成那一篇的）。
//
// 契约要点（任务07）：
//   - 指纹按来源构造：GSC 账号/站点；GA4 账号/资源 + 所选事件集合（去重排序，换序不失效）。
//   - URL 集合与发布日期变化推进文章取数修订；标题/文案师不触发重抓。
//   - 跳过规则（逐来源）：完整成功 + 完整月已定稿 + 指纹与文章修订一致 + 非 force 才跳过。
//   - GSC 表达式超长拆批，无法放入明确报错，不自动退回全站快照。
//   - GA4 浏览与所选事件分两个请求（维度过滤会互相污染），过滤集合按规范化路径去重。
//   - 抓取完整成功但缺行 → 成功覆盖内物化 0；失败/截断/未配置不补 0。
//     截断不提交部分和、不标 complete，保留最后成功值并标异常。
//   - 默认抓到 min(月末, today−DATA_LAG_DAYS)；结束早于开始不请求、不写伪零。
//   - 每次结果写入与清 dirty 都带运行标识 + 指纹 + 文章修订守卫（旧响应晚到不覆盖）。
//   - 按项目数据库条件认领 + 有限有效期；同项目重入返回「正在刷新」。
//   - 返回成功/失败/未处理范围和实际数据截至日（不用请求结束时间冒充）。

const { DATA_LAG_DAYS, GA_BACKFILL_START, GSC_FILTER_MAX } = require('./constants');
const { parseKeyEventNames, resolveAccounts } = require('./project-config');

// 项目所选关键事件（去重排序）——本月临时的 GA4 事件请求用
function eventNamesOf(project) {
  return [...new Set(parseKeyEventNames(project.key_event_names))].sort();
}
const { isAuthError } = require('./oauth');
const { chunkPathsForRegex, buildPathRegex } = require('./filters');
const { chunk } = require('../lib/chunk');
const { runUnitBatch } = require('../lib/unit-batch');
const {
  businessToday, monthBounds, shiftMonth, shiftDay, safeMonthEnd, isValidMonth, isValidDay, monthOf,
} = require('../lib/business-dates');
const {
  parseGscSite, aggregateGscRows, gscValueForArticle, ga4PathsForArticle,
  ga4ValueForArticle, ga4KeyEventsForArticle,
} = require('../lib/article-fetch-urls');
const { normPath } = require('../lib/url-match');
const { currentWindow } = require('../lib/current-month');
const { fail } = require('../services/mcp-common');
const { sourceRequest } = require('./source-request');

// 每批限制 SQL 体积，全部批次随该同步单元一起提交。
const ROWS_PER_STMT = 500;
// 限制单次同步的月份和 Google 请求规模，避免长时间占用一个 HTTP 请求。
const MAX_MONTHS_PER_SYNC = 6;
const MAX_GOOGLE_REQUESTS_PER_SYNC = 45;

// 定稿安全窗口：月末 + 3 天内抓取的快照允许在下一个同步轮里重抓一次
const SETTLED_LAG_DAYS = 3;

// GSC 只保留约 16 个月数据：从这里往前的月份标记「来源范围不支持」
function gscEarliestMonth(today) {
  return shiftMonth(monthOf(today), -15);
}

function ga4EarliestMonth() {
  return GA_BACKFILL_START.slice(0, 7);
}

// 指纹：换序/重复不失效（事件集合去重排序）
const { buildArticleFingerprints: buildFingerprints } = require('../lib/article-fingerprint');

// 一个月份的「拟取区间」：月初 → min(月末, today−lag)。结束早于开始 → null（不请求）
function monthFetchRange(month, today, lagDays = DATA_LAG_DAYS) {
  const bounds = monthBounds(month);
  const safeEnd = safeMonthEnd(month, today, lagDays);
  if (!safeEnd || safeEnd < bounds.start) return null;
  return { start: bounds.start, end: safeEnd, monthEnd: bounds.end };
}

function publicationDay(article) {
  return isValidDay(article?.published_at) ? article.published_at : null;
}

// 同一起日的文章共享请求，发布当月不能用发布前的流量补足业务覆盖。
function groupArticleWindows(articles, month, endDate) {
  if (!endDate) return [];
  const bounds = monthBounds(month);
  const groups = new Map();
  for (const article of articles) {
    const published = publicationDay(article);
    if (!published) continue;
    const start = published > bounds.start ? published : bounds.start;
    if (start > endDate) continue;
    if (!groups.has(start)) groups.set(start, { range: { start, end: endDate, monthEnd: bounds.end }, articles: [] });
    groups.get(start).articles.push(article);
  }
  return [...groups.values()].sort((a, b) => a.range.start.localeCompare(b.range.start)).map(group => {
    const paths = new Set();
    for (const article of group.articles) for (const url of article.urls || [article.url])
      paths.add(normPath(url));
    return { ...group, batches: chunkPathsForRegex([...paths]) };
  });
}

function createArticleMetricsFetchers({ db, gsc, ga4 }) {
  // 后台按文章、月份、来源保存检查点；不读取整项目，也不隐式追加本月请求。
  async function fetchArticleMetricsUnit(project, { articleId, fetchRevision, month, source, current=false, today=businessToday() }) {
    if(!['gsc','ga4'].includes(source))fail('VALIDATION_ERROR','未知站内取数来源');
    const article=await db.db.prepare("SELECT id,url,published_at,fetch_revision FROM project_articles WHERE id=? AND project_id=? AND status='active'").get(articleId,project.id);
    if(!article || (fetchRevision!==undefined && Number(article.fetch_revision)!==Number(fetchRevision)))fail('CONFLICT','文章取数修订已变化');
    const published=publicationDay(article);
    if(!published)fail('VALIDATION_ERROR','请先补填文章发布日期');
    const history=await db.db.prepare('SELECT url FROM project_article_url_history WHERE article_id=? AND project_id=? ORDER BY id LIMIT 65').all(articleId,project.id);
    if(history.length>64)fail('RANGE_TOO_LARGE','单篇历史地址超过后台单元范围，请先缩小地址集合');
    article.urls=[article.url,...history.map(r=>r.url)];
    const paths=[...new Set(article.urls.map(normPath))];
    if(!paths.length || chunkPathsForRegex(paths).length!==1 || buildPathRegex(paths).length>GSC_FILTER_MAX)
      fail('RANGE_TOO_LARGE','单篇地址过滤超出单元预算');
    const fps=buildFingerprints(project);
    if(!fps[source])fail('SOURCE_UNCONFIGURED','项目未配置该来源');
    const {gscAccountId,ga4AccountId}=resolveAccounts(project);
    const eventNames=eventNamesOf(project);
    const commit=async(statements,result)=>{
      if(db.db.commitSyncUnit)return db.db.commitSyncUnit(statements,result,{expectedChanges:1});
      const rows=await db.db.batchAtomic(statements);
      if(Number(rows[0]?.changes)!==1)fail('CONFLICT','同步落库时文章或配置已变化');
      return rows;
    };
    if(current) {
      const currentMonth=monthOf(today);
      if(month && month!==currentMonth)fail('CONFLICT','本月已切换，请重新计划');
      const start=published>monthBounds(currentMonth).start?published:monthBounds(currentMonth).start;
      if(start>today)fail('VALIDATION_ERROR','文章尚未发布，不能同步发布前指标');
      const previous=await db.getCurrentForArticle(article.id);
      const latest=await sourceRequest(()=>source==='gsc'?gsc.gscLatestDate(gscAccountId,project.gsc_site,{today})
        :ga4.ga4LatestDate(ga4AccountId,project.ga4_property_id,{}));
      const window=currentWindow(currentMonth,latest);
      if(window.endDate && window.endDate<start){window.empty=true;window.endDate=null;}
      const row={articleId:article.id,revision:article.fetch_revision,month:currentMonth,rangeStart:start,
        gscState:fps.gsc?'pending':'unavailable',ga4ViewsState:fps.ga4?'pending':'unavailable',
        ga4KeyEventsState:fps.ga4?(eventNames.length?'pending':'unconfigured'):'unavailable',errors:[]};
      if(source==='gsc') {
        row.gscState=window.empty?'empty':'complete';row.gscEndDate=window.endDate;
        if(window.empty) {
          if(previous?.month===currentMonth && previous.gsc_config_fingerprint===fps.gsc && ['complete','empty'].includes(previous.gsc_state)) {
            row.gscClicks=previous.gsc_clicks;row.gscEndDate=previous.gsc_end_date;
          }
        } else {
          const response=await sourceRequest(()=>gsc.gscQuery(gscAccountId,project.gsc_site,start,window.endDate,paths,{dataState:'all'}));
          if(response.truncated)fail('SOURCE_ERROR','GSC 返回已截断，保留上次成功值');
          const value=gscValueForArticle(aggregateGscRows(response.raw||[]),article.urls,parseGscSite(project.gsc_site));
          if(value.error || (value.variant && value.clicks===undefined))fail('SOURCE_ERROR','GSC 返回地址无法精确匹配');
          row.gscClicks=value.clicks??0;
          row.gscImpressions=value.impressions??0;row.gscCtr=value.ctr??null;row.gscPosition=value.position??null;
        }
      } else {
        row.ga4ViewsState=window.empty?'empty':'complete';row.ga4EndDate=window.endDate;
        row.ga4KeyEventsState=eventNames.length?(window.empty?'empty':'complete'):'unconfigured';
        if(window.empty) {
          if(previous?.month===currentMonth && previous.ga4_config_fingerprint===fps.ga4) {
            if(['complete','empty'].includes(previous.ga4_views_state)) {row.ga4Views=previous.ga4_views;row.ga4EndDate=previous.ga4_end_date;}
            if(['complete','empty'].includes(previous.ga4_key_events_state))row.ga4KeyEvents=previous.ga4_key_events;
          }
        } else {
          const views=await sourceRequest(()=>ga4.ga4Query(ga4AccountId,project.ga4_property_id,start,window.endDate,paths));
          const events=eventNames.length?await sourceRequest(()=>ga4.ga4KeyEventsQuery(ga4AccountId,project.ga4_property_id,start,window.endDate,paths,eventNames)):null;
          if(views.truncated || events?.truncated)fail('SOURCE_ERROR','GA4 返回已截断，保留上次成功值');
          const articlePaths=ga4PathsForArticle(article.urls).paths;
          row.ga4Views=articlePaths.reduce((sum,p)=>sum+ga4ValueForArticle(views.byDate,p).pageviews,0);
          row.ga4KeyEvents=events?articlePaths.reduce((sum,p)=>sum+(ga4KeyEventsForArticle(events.byDate,p)??0),0):null;
        }
      }
      const result={status:'complete',kind:'current',month:currentMonth,source,article_id:article.id,rows_written:1,
        cover_start:start,cover_end:source==='gsc'?row.gscEndDate??null:row.ga4EndDate??null};
      await db.upsertCurrentRows(project.id,[row],{fingerprints:fps,configRevision:project.config_revision,source,
        commit:statements=>commit(statements,result)});
      return result;
    }
    if(!isValidMonth(month) || month>=monthOf(today))fail('VALIDATION_ERROR','月度单元必须使用过去月份');
    const range=monthFetchRange(month,today);
    if(!range)fail('RANGE_TOO_LARGE','月份不在可抓取窗口');
    range.start=published>range.start?published:range.start;
    if(range.start>range.end)fail('VALIDATION_ERROR','所选月份早于文章发布日期');
    const earliest=source==='gsc'?gscEarliestMonth(today):ga4EarliestMonth();
    if(month<earliest) {
      const result={status:'unavailable',kind:'monthly',month,source,article_id:article.id,rows_written:1};
      await commit([db.monthlyUnavailableStmt(article.id,month,source,'月份早于来源可用范围',{revision:article.fetch_revision,fingerprint:fps[source]})],result);
      return result;
    }
    let values;let mismatch=null;
    if(source==='gsc') {
      const response=await sourceRequest(()=>gsc.gscQuery(gscAccountId,project.gsc_site,range.start,range.end,paths,{dataState:'final'}));
      if(response.truncated)fail('SOURCE_ERROR','GSC 返回已截断，保留上次成功值');
      const value=gscValueForArticle(aggregateGscRows(response.raw||[]),article.urls,parseGscSite(project.gsc_site));
      if(value.error || (value.variant && value.clicks===undefined))fail('SOURCE_ERROR','GSC 返回地址无法精确匹配');
      values={clicks:value.clicks??0,impressions:value.impressions??0,ctr:value.ctr??null,position:value.position??null};
      mismatch=value.variant?`响应变体未计入: ${value.observed||value.variant.join(', ')}`:null;
    } else {
      const views=await sourceRequest(()=>ga4.ga4Query(ga4AccountId,project.ga4_property_id,range.start,range.end,paths));
      const events=eventNames.length?await sourceRequest(()=>ga4.ga4KeyEventsQuery(ga4AccountId,project.ga4_property_id,range.start,range.end,paths,eventNames)):null;
      if(views.truncated || events?.truncated)fail('SOURCE_ERROR','GA4 返回已截断，保留上次成功值');
      const {paths:articlePaths,ambiguous}=ga4PathsForArticle(article.urls);
      values={pageviews:articlePaths.reduce((sum,p)=>sum+ga4ValueForArticle(views.byDate,p).pageviews,0),
        keyEvents:events?articlePaths.reduce((sum,p)=>sum+(ga4KeyEventsForArticle(events.byDate,p)??0),0):null};
      mismatch=ambiguous.length?`跨主机同路径歧义: ${ambiguous.join(', ')}`:null;
    }
    const result={status:'complete',kind:'monthly',month,source,article_id:article.id,rows_written:1,cover_start:range.start,cover_end:range.end};
    await commit([db.monthlyWriteMultiStmt(source,month,[{articleId:article.id,revision:article.fetch_revision,values,mismatch}],
      {fingerprint:fps[source],coverStart:range.start,coverEnd:range.end,finalized:range.end>=range.monthEnd,
        projectId:project.id,configRevision:project.config_revision})],result);
    return result;
  }

  async function finalizeArticleMetricsUnit(project,{articleId,fetchRevision}) {
    const result={status:'complete',kind:'internal_finalize',article_id:articleId,metrics_dirty:false};
    const statement=db.db.prepare("UPDATE project_articles SET metrics_dirty=0,last_synced_at=? WHERE id=? AND project_id=? AND status='active' AND fetch_revision=?")
      .bind(new Date().toISOString(),articleId,project.id,fetchRevision);
    const rows=await (db.db.commitSyncUnit?db.db.commitSyncUnit([statement],result,{expectedChanges:1}):db.db.batchAtomic([statement]));
    if(Number(rows[0]?.changes)!==1)fail('CONFLICT','文章取数修订已变化');
    return result;
  }

  async function markArticleMetricsUnitError(project,{articleId,fetchRevision,month,source,current=false,error}) {
    if(!['gsc','ga4'].includes(source) || !isValidMonth(month))fail('VALIDATION_ERROR','文章来源失败状态无效');
    const message=String(error?.message||error||'来源抓取失败').slice(0,500);
    const failure={code:'SOURCE_ERROR',message};
    const result={status:'error',kind:current?'current':'monthly',month,source,article_id:articleId,error:message};
    const fps=buildFingerprints(project);
    const commit=statements=>db.db.commitSyncUnit?db.db.commitSyncUnit(statements,result,{expectedChanges:1,error:failure}):db.db.batchAtomic(statements);
    if(current) {
      const article=await db.db.prepare('SELECT published_at FROM project_articles WHERE id=? AND project_id=?').get(articleId,project.id);
      const published=publicationDay(article);
      if(!published)fail('VALIDATION_ERROR','请先补填文章发布日期');
      const hasKeyEvents=eventNamesOf(project).length>0;
      const row={articleId,revision:fetchRevision,month,rangeStart:published>monthBounds(month).start?published:monthBounds(month).start,
        gscState:source==='gsc'?'error':fps.gsc?'pending':'unavailable',
        ga4ViewsState:source==='ga4'?'error':fps.ga4?'pending':'unavailable',
        ga4KeyEventsState:source==='ga4'&&hasKeyEvents?'error':fps.ga4?(hasKeyEvents?'pending':'unconfigured'):'unavailable',errors:[message]};
      await db.upsertCurrentRows(project.id,[row],{fingerprints:fps,configRevision:project.config_revision,source,commit});
    } else {
      await commit([db.monthlyWriteMultiStmt(source,month,[{articleId,revision:fetchRevision,values:{}}],
        {fingerprint:fps[source],error:message,projectId:project.id,configRevision:project.config_revision})]);
    }
    return result;
  }
  // ============ 计划（纯决策，不请求） ============

  // months 为空时按文章发布日期推到「上一个完整月」；force 全部重抓。
  // 本月（当前自然月）不走月度表——它由 fetchCurrentMonth 抓「应覆盖起日→各源最新日期」
  // 的临时数据，读取时合并（见 src/lib/current-month.js）。
  // 返回 { months: [{month, gsc, ga4}], requests: {gsc, ga4}, monitorStart, dataThrough, current }
  async function planArticleSync(project, { months, force = false, today = businessToday(), articleId = null, articleIds = null, currentOnly = false } = {}) {
    const fps = buildFingerprints(project);
    const selectedIds = Array.isArray(articleIds) ? new Set(articleIds.map(Number)) : articleId ? new Set([Number(articleId)]) : null;
    const articles = (await db.listArticleUrlsForSync(project.id)).filter(a => !selectedIds || selectedIds.has(a.id));
    const missingPublicationIds = articles.filter(a => !publicationDay(a)).map(a => a.id);
    const publishedArticles = articles.filter(a => publicationDay(a) && publicationDay(a) <= today);
    const firstPublication = publishedArticles.map(publicationDay).sort()[0] || null;
    const monitorStart = firstPublication ? monthOf(firstPublication) : null;
    const currentMonth = monthOf(today);
    const prevMonth = shiftMonth(currentMonth, -1);
    const safeThrough = safeMonthEnd(currentMonth, today, DATA_LAG_DAYS);
    const dataThrough = safeThrough && safeThrough >= monthBounds(currentMonth).start ? safeThrough : null;

    let monthList;
    if (currentOnly) monthList = [];
    else if (Array.isArray(months) && months.length) {
      monthList = [...new Set(months.filter(isValidMonth))].sort();
    } else {
      monthList = [];
      for (let m = monitorStart; m && m <= prevMonth; m = shiftMonth(m, 1)) monthList.push(m);
    }

    const planRows = await db.listPlanRows(project.id, monthList);
    const rowByKey = new Map(planRows.map((r) => [`${r.article_id}|${r.month}`, r]));

    const gscFrom = fps.gsc ? gscEarliestMonth(today) : null;
    const ga4From = fps.ga4 ? ga4EarliestMonth() : null;

    const currentGroups = groupArticleWindows(publishedArticles, currentMonth, today);
    const currentBatchCount = currentGroups.reduce((sum, group) => sum + group.batches.length, 0);

    const planMonths = [];
    let reqGsc = 0;
    let reqGa4 = 0;
    for (const month of monthList) {
      const range = monthFetchRange(month, today);
      const groups = groupArticleWindows(publishedArticles, month, range?.end);
      const monthArticles = groups.flatMap(group => group.articles);
      const articleById = new Map(monthArticles.map(a => [a.id, a]));
      const batchCount = groups.reduce((sum, group) => sum + group.batches.length, 0);
      let gscPlan = { need: false, reason: null };
      let ga4Plan = { need: false, reason: null };

      if (!range) {
        gscPlan = { need: false, reason: '月份还没到可抓取窗口（today−lag 未进入该月）' };
        ga4Plan = { ...gscPlan };
      } else if (!monthArticles.length) {
        gscPlan = { need: false, reason: missingPublicationIds.length ? '请先补填文章发布日期' : '所选月份没有已发布文章' };
        ga4Plan = { ...gscPlan };
      } else {
        if (!fps.gsc) gscPlan = { need: false, reason: 'unavailable', detail: '未配置 GSC 账号/站点' };
        else if (month < gscFrom) gscPlan = { need: false, reason: 'unavailable', detail: '超出 GSC 约 16 个月可见范围' };
        else if (force) gscPlan = { need: true, reason: 'force' };
        else {
          gscPlan = { need: monthNeedsFetch(rowByKey, articleById, month, 'gsc', fps.gsc), reason: gscPlan.reason };
        }
        if (!fps.ga4) ga4Plan = { need: false, reason: 'unavailable', detail: '未配置 GA4 账号/资源' };
        else if (month < ga4From) ga4Plan = { need: false, reason: 'unavailable', detail: '超出 GA4 起始范围' };
        else if (force) ga4Plan = { need: true, reason: 'force' };
        else {
          ga4Plan = { need: monthNeedsFetch(rowByKey, articleById, month, 'ga4', fps.ga4), reason: null };
        }
      }
      if (gscPlan.need) reqGsc += batchCount;
      if (ga4Plan.need) reqGa4 += batchCount * (eventNamesOf(project).length ? 2 : 1);
      planMonths.push({ month, range, articleIds: monthArticles.map(a => a.id), gsc: gscPlan, ga4: ga4Plan,
        requests: { gsc: gscPlan.need ? batchCount : 0, ga4: ga4Plan.need ? batchCount * (eventNamesOf(project).length ? 2 : 1) : 0 } });
    }
    // 本月临时：两个探测 + 与一个月份同规模的批次数（GSC 一批、GA4 两路各一批）
    const hasArticles = publishedArticles.length > 0;
    const currentGsc = hasArticles && fps.gsc ? currentBatchCount + 1 : 0;
    const currentGa4 = hasArticles && fps.ga4 ? currentBatchCount * (eventNamesOf(project).length ? 2 : 1) + 1 : 0;
    return {
      monitorStart, dataThrough, today,
      missingPublicationIds,
      ...(missingPublicationIds.length ? { reason: '请先补填文章发布日期' } : {}),
      ...(!hasArticles && missingPublicationIds.length ? { skipped: 'missing_publication_date' } : {}),
      months: planMonths,
      requests: { gsc: reqGsc + currentGsc, ga4: reqGa4 + currentGa4 },
      monthlyRequests: { gsc: reqGsc, ga4: reqGa4 },
      current: {
        month: currentMonth, planned: hasArticles && Boolean(fps.gsc || fps.ga4),
        articleIds: publishedArticles.map(a => a.id),
        requests: { gsc: currentGsc, ga4: currentGa4 },
      },
      articleCount: articles.length,
      urlBatches: currentBatchCount,
    };
  }

  // 某来源在某月是否需要抓：任一篇「不完整/未定稿/指纹或修订不一致」就需要。
  // 额外一条：定稿≠永久冻结——月末+3 天内抓的快照，GSC/GA4
  // 可能还在回填，已经过了定稿日的完整月允许再抓一次更正（synced_at 早于定稿日的行）。
  function monthNeedsFetch(rowByKey, articleById, month, source, fingerprint) {
    const statusCol = source === 'gsc' ? 'gsc_status' : 'ga4_status';
    const finCol = source === 'gsc' ? 'gsc_finalized' : 'ga4_finalized';
    const fpCol = source === 'gsc' ? 'gsc_config_fingerprint' : 'ga4_config_fingerprint';
    const fetchedCol = source === 'gsc' ? 'gsc_fetched_at' : 'ga4_fetched_at';
    const monthEnd = monthBounds(month).end;
    for (const a of articleById.values()) {
      const row = rowByKey.get(`${a.id}|${month}`);
      if (!row) return true;
      if (row[statusCol] !== 'complete') return true;
      if (!row[finCol]) return true;
      if (row[fpCol] !== fingerprint) return true;
      if (Number(row.fetch_revision) !== Number(a.fetch_revision ?? 1)) return true;
      const expectedStart = publicationDay(a) > monthBounds(month).start ? publicationDay(a) : monthBounds(month).start;
      if (row[`${source}_cover_start`] !== expectedStart || row[`${source}_cover_end`] < monthEnd) return true;
      // 抓取时间早于「月末+3 天」→ 这个快照可能赶在回填前，允许重抓一次
      const fetched = String(row[fetchedCol] || '').slice(0, 10);
      if (fetched && fetched <= shiftDay(monthEnd, SETTLED_LAG_DAYS)) return true;
    }
    return false;
  }

  // ============ 执行 ============

  // 完整计划描述业务覆盖；默认刷新只消费仍需抓取的月份，并为本月预留预算。
  // 先检查单个窗口能否执行，避免把永远无法放入预算的月份反复留到下一轮。
  function boundedMonthExecution(plan, explicitMonths) {
    if (explicitMonths) return { months: plan.months, remaining: [], requests: plan.requests };
    const pending = plan.months.filter(pm => pm.gsc.need || pm.ga4.need)
      .sort((a, b) => b.month.localeCompare(a.month));
    const requests = { ...plan.current.requests };
    const currentCost = requests.gsc + requests.ga4;
    if (currentCost > MAX_GOOGLE_REQUESTS_PER_SYNC) return {
      months: [], remaining: pending, requests,
      budgetExceeded: `本月预计 Google 请求数 ${currentCost} 超过单次上限 ${MAX_GOOGLE_REQUESTS_PER_SYNC}，请按文章分批刷新`,
    };
    const oversized = pending.find(pm => currentCost + pm.requests.gsc + pm.requests.ga4 > MAX_GOOGLE_REQUESTS_PER_SYNC);
    if (oversized) return {
      months: [], remaining: pending, requests,
      budgetExceeded: `${oversized.month} 单月连同本月预计 Google 请求数 ${currentCost + oversized.requests.gsc + oversized.requests.ga4} 超过单次上限 ${MAX_GOOGLE_REQUESTS_PER_SYNC}，请按文章分批刷新`,
    };
    const selected = [];
    const remaining = [];
    for (const pm of pending) {
      const cost = pm.requests.gsc + pm.requests.ga4;
      if (selected.length >= MAX_MONTHS_PER_SYNC || requests.gsc + requests.ga4 + cost > MAX_GOOGLE_REQUESTS_PER_SYNC) {
        remaining.push(pm);
        continue;
      }
      selected.push(pm);
      requests.gsc += pm.requests.gsc;
      requests.ga4 += pm.requests.ga4;
    }
    return { months: selected, remaining, requests };
  }

  function articleUnprocessed(result, articleId) {
    return result.unprocessed.some(row => row.articleId === articleId || row.articleIds?.includes(articleId));
  }

  // articleId 非空 = 单篇刷新（URL 集合只含该篇）。返回承诺的边界信息。
  async function fetchArticleMetrics(project, { months, force = false, articleId = null, articleIds = null,
    currentOnly = false, includeCurrent = true, deferCompletion = false, runId: requestedRunId = null, today = businessToday() } = {}) {
    const fps = buildFingerprints(project);
    if (!fps.gsc && !fps.ga4) {
      return { status: 'skipped', reason: '未配置 GSC/GA4 数据源', dataThrough: null, months: [] };
    }

    // 数据库条件认领（同项目重入 → 正在刷新）；租约 15 分钟，到期由下一次请求恢复
    const runId = requestedRunId || `run-${project.id}-${Date.now().toString(36)}`;
    const at = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const claimed = await db.claimMonitorSyncState(project.id, { runId, leaseUntil, at });
    if (!claimed) {
      return { status: 'busy', reason: '该项目正在刷新中，请稍后再试', dataThrough: null, months: [] };
    }

    const result = {
      status: 'ok', runId, dataThrough: null,
      months: [], warnings: [],
      fetched: { articles: 0, sourceMonths: 0 },
      failed: [], unprocessed: [],
    };
    try {
      const plan = await planArticleSync(project, { months, force, today, articleId, articleIds, currentOnly });
      result.dataThrough = plan.dataThrough;
      const explicitMonths = Array.isArray(months) && months.length > 0;
      const execution = boundedMonthExecution(plan, explicitMonths);
      result.plan = { monitorStart: plan.monitorStart, requests: execution.requests, articleCount: plan.articleCount };
      if (plan.missingPublicationIds.length) {
        result.warnings.push('部分文章缺少发布日期，请先补填');
        result.unprocessed.push(...plan.missingPublicationIds.map(articleId => ({ articleId, reason: '请先补填文章发布日期' })));
      }
      if (plan.skipped === 'missing_publication_date') {
        result.status = 'skipped';
        result.reason = plan.reason;
        await db.releaseMonitorSyncState(project.id, { runId, at, lastError: plan.reason });
        return result;
      }

      // 超限在来源请求和指标写入前拒绝，返回可执行拆分提示。
      const requestedMonths = execution.months.map((m) => m.month);
      if (execution.budgetExceeded) {
        await db.releaseMonitorSyncState(project.id, { runId, at, lastError: execution.budgetExceeded });
        return rangeExceeded(result, execution.remaining.map(pm => pm.month), execution.budgetExceeded);
      }
      if (requestedMonths.length > MAX_MONTHS_PER_SYNC) {
        const reason = `一次最多同步 ${MAX_MONTHS_PER_SYNC} 个月，请分次选择（项目文章多时每批还要更小）`;
        await db.releaseMonitorSyncState(project.id, { runId, at, lastError: reason });
        return rangeExceeded(result, requestedMonths, reason);
      }
      const estGoogle = execution.requests.gsc + execution.requests.ga4;
      if (estGoogle > MAX_GOOGLE_REQUESTS_PER_SYNC) {
        const reason = `预计 Google 请求数 ${estGoogle} 超过单次上限 ${MAX_GOOGLE_REQUESTS_PER_SYNC}，请缩小月份范围`;
        await db.releaseMonitorSyncState(project.id, { runId, at, lastError: reason });
        return rangeExceeded(result, requestedMonths, reason);
      }

      result.remainingMonths = execution.remaining.map(pm => pm.month);
      if (result.remainingMonths.length) {
        result.reason = `本次按同步预算处理最近待同步月份，仍有 ${result.remainingMonths.length} 个月历史数据待继续同步，下次刷新将继续`;
        result.unprocessed.push(...execution.remaining.map(pm => ({ month: pm.month, articleIds: pm.articleIds,
          sources: ['gsc', 'ga4'].filter(source => pm[source].need), reason: '单次同步预算内未处理，等待下次刷新' })));
      }
      if (!explicitMonths && plan.months.some(pm => pm.gsc.reason === 'unavailable' || pm.ga4.reason === 'unavailable'))
        result.warnings.push('部分历史来源未配置或超出可用范围，对应指标仍为未知');

      const selectedIds = Array.isArray(articleIds) ? new Set(articleIds.map(Number)) : articleId ? new Set([Number(articleId)]) : null;
      const registered = (await db.listArticleUrlsForSync(project.id)).filter(a => !selectedIds || selectedIds.has(a.id));
      const articles = registered.filter(a => publicationDay(a) && publicationDay(a) <= today);
      if (!articles.length) {
        result.reason = registered.length ? '文章尚未发布' : '项目没有登记文章';
        result.warnings.push(result.reason);
        await db.releaseMonitorSyncState(project.id, { runId, at, lastError: result.reason });
        result.status = 'skipped';
        return result;
      }
      const revisions = new Map(articles.map((a) => [a.id, Number(a.fetch_revision ?? 1)]));

      const currentMonth = monthOf(today);
      for (const pm of execution.months) {
        const monthResult = { month: pm.month, gsc: 'skipped', ga4: 'skipped', detail: [] };
        if (pm.month >= currentMonth) {
          // 本月/未来月不进月度表：本月临时数据单独抓（见下方 runCurrentMonth），
          // 用户显式选了当月也走同一条路，不写「半截月度行」。
          monthResult.detail.push('本月数据走「本月临时」通道（各源最新日期），不进月度累计表');
          result.months.push(monthResult);
          continue;
        }
        if (!pm.range) {
          monthResult.gsc = 'skipped';
          monthResult.ga4 = 'skipped';
          monthResult.detail.push(pm.gsc.reason || '未到可抓取窗口');
          result.months.push(monthResult);
          continue;
        }
        const monthArticles = articles.filter(a => pm.articleIds.includes(a.id));
        // GSC
        if (pm.gsc.need) {
          const r = await runMonthWindows(runGscMonth, project, pm, monthArticles, revisions, fps.gsc, today, result);
          monthResult.gsc = r.status;
          monthResult.detail.push(...r.details);
        } else if (pm.gsc.reason === 'unavailable') {
          monthResult.gsc = 'unavailable';
          monthResult.detail.push(`GSC: ${pm.gsc.detail}`);
          await markUnavailable(monthArticles, pm.month, 'gsc', pm.gsc.detail, revisions, fps.gsc);
        }
        // GA4
        if (pm.ga4.need) {
          const r = await runMonthWindows(runGa4Month, project, pm, monthArticles, revisions, fps.ga4, today, result);
          monthResult.ga4 = r.status;
          monthResult.detail.push(...r.details);
        } else if (pm.ga4.reason === 'unavailable') {
          monthResult.ga4 = 'unavailable';
          monthResult.detail.push(`GA4: ${pm.ga4.detail}`);
          await markUnavailable(monthArticles, pm.month, 'ga4', pm.ga4.detail, revisions, fps.ga4);
        }
        result.months.push(monthResult);
      }

      // 本月临时数据：探测各源最新日期 → 抓发布后的实际窗口 → 按来源保存
      const current = includeCurrent ? await runCurrentMonth(project, { articles, today, articleId }) : null;
      result.current = current;
      if (current && ['error', 'partial'].includes(current.status)) {
        const failedIds = current.failedArticleIds?.length ? current.failedArticleIds : [null];
        for (const id of failedIds)
          result.failed.push({ month: current.month, source: 'current', articleId: id, reason: current.error || current.errors.join('；') });
      }

      // 结束：被守卫挡下的文章（修订在同步途中变化）不清 dirty；全部写成功的清
      const partialIds = new Set((result.partial || []).flatMap((p) => p.ids));
      for (const a of deferCompletion ? [] : articles) {
        const rev = revisions.get(a.id);
        const anyFailed = result.failed.some((f) => f.articleId === null || f.articleId === a.id);
        // 写入被守卫挡下（整单失败或部分行没落）的文章不清 dirty——下次刷新重来
        if (!anyFailed && !partialIds.has(a.id) && !articleUnprocessed(result, a.id)) {
          const cleared = await db.clearArticleDirty(a.id, rev, { projectId: project.id, configRevision: project.config_revision });
          if (!cleared) result.failed.push({ articleId: a.id, source: 'finalize', reason: '文章或配置已变化，请重新同步' });
        }
      }
      if (result.failed.length || result.partial?.length || result.unprocessed.length) result.status = 'partial';
      await db.releaseMonitorSyncState(project.id, { runId, at: new Date().toISOString(),
        lastError: result.status === 'partial' ? '部分文章或来源未完成同步' : null, markSuccess: !deferCompletion });
      return result;
    } catch (e) {
      // 鉴权失败停止无意义重试；其余错误带原因释放锁，等下一次用户请求
      const auth = isAuthError(e);
      await db.releaseMonitorSyncState(project.id, {
        runId, at: new Date().toISOString(),
        lastError: String(e.message || e).slice(0, 500),
      });
      result.status = 'error';
      result.error = String(e.message || e);
      result.authError = auth;
      return result;
    }
  }

  // 范围超限时尚未请求来源或写指标，返回可执行拆分（每批 ≤ 上限）。
  function rangeExceeded(result, months, reason) {
    const sorted = [...months].sort();
    const batches = [];
    for (let i = 0; i < sorted.length; i += MAX_MONTHS_PER_SYNC) batches.push(sorted.slice(i, i + MAX_MONTHS_PER_SYNC));
    return {
      status: 'range-exceeded', reason,
      hint: { maxMonthsPerSync: MAX_MONTHS_PER_SYNC, suggestedBatches: batches },
      dataThrough: result.dataThrough, months: [],
    };
  }

  // ---- 单来源单月执行 ----

  async function runMonthWindows(run, project, pm, articles, revisions, fingerprint, today, result) {
    const results = [];
    for (const group of groupArticleWindows(articles, pm.month, pm.range.end))
      results.push(await run(project, { ...pm, range: group.range }, group.articles, revisions, fingerprint, today, result));
    const statuses = results.map(r => r.status);
    const status = statuses.some(s => !['complete', 'skipped'].includes(s))
      ? (statuses.includes('complete') ? 'partial' : statuses.find(s => s !== 'skipped'))
      : statuses.includes('complete') ? 'complete' : 'skipped';
    return { status, details: results.flatMap(r => r.details) };
  }

  async function runGscMonth(project, pm, articles, revisions, fingerprint, today, result) {
    const { gscAccountId } = resolveAccounts(project);
    const site = parseGscSite(project.gsc_site);
    const details = [];
    const { start, end, monthEnd } = pm.range;

    // URL 过滤集合：规范化路径去重后分批；解析成完整 URL 用于精确计数
    const pathSet = new Map(); // path -> [registered urls]
    for (const a of articles) {
      for ( const u of a.urls ) {
        const p = normPath(u);
        if (!pathSet.has(p)) pathSet.set(p, []);
        pathSet.get(p).push(u);
      }
    }
    const batches = chunkPathsForRegex([...pathSet.keys()]);
    const exact = new Map();
    let truncated = false;
    try {
      for (const paths of batches) {
        // 表达式超长且无法拆小（单条 URL 就超限）：明确报错，不自动退回全站快照
        if (buildPathRegex(paths).length > GSC_FILTER_MAX) {
          throw new Error(`URL 过滤表达式超长（${buildPathRegex(paths).length} > ${GSC_FILTER_MAX}）：${paths[0]?.slice(0, 60)}… 请缩短登记地址或分批`);
        }
        const r = await gsc.gscQuery(gscAccountId, project.gsc_site, start, end, paths, { dataState: 'final' });
        if (r.truncated) truncated = true;
        for (const [page, v] of aggregateGscRows(r.raw || [])) exact.set(page, v);
      }
    } catch (e) {
      details.push(`GSC 抓取失败: ${e.message}`);
      result.failed.push({ month: pm.month, source: 'gsc', articleId: null, reason: e.message });
      await writeMonthAttemptError(project, pm, articles, revisions, 'gsc', fingerprint, e.message, details);
      if (isAuthError(e)) throw e;
      return { status: 'error', details };
    }
    if (truncated) {
      details.push('GSC 返回结果已达上限，本月未入库（保留上次成功值）');
      result.failed.push({ month: pm.month, source: 'gsc', articleId: null, reason: 'truncated' });
      await writeMonthAttemptError(project, pm, articles, revisions, 'gsc', fingerprint, 'GSC 返回行数达到上限，覆盖可能不完整', details);
      return { status: 'truncated', details };
    }

    const finalized = end >= monthEnd;
    // 批量写入每个来源的成功事实，减少逐篇执行 SQL 的开销
    const units = [];
    for (const group of chunk(articles, ROWS_PER_STMT)) {
      const rows = [];
      for (const a of group) {
        const g = gscValueForArticle(exact, a.urls, site);
        if (g.error) {
          details.push(`${a.url}: 无法按唯一站点解析（${g.error}），请补完整 URL`);
          result.failed.push({ month: pm.month, source: 'gsc', articleId: a.id, reason: 'url-unresolved' });
          continue;
        }
        // 带点击数：用户要能看出「这块流量没被计入」到底有多大
        const mismatch = g.variant ? `响应变体未计入: ${g.observed || g.variant.join(', ')}` : null;
        if (mismatch && g.clicks === undefined) {
          // 只有变体没有精确行：不猜数，记 mismatch
          await noteAnomaly([a], pm.month, 'gsc', mismatch, revisions);
          continue;
        }
        rows.push({
          articleId: a.id,
          values: { clicks: g.clicks ?? 0, impressions: g.impressions ?? 0, ctr: g.ctr ?? null, position: g.position ?? null },
          revision: revisions.get(a.id), mismatch,
        });
      }
      if (!rows.length) continue;
      const writeOpts = { fingerprint, coverStart: start, coverEnd: end, finalized,
        projectId: project.id, configRevision: project.config_revision };
      units.push({
        ids: rows.map((r) => r.articleId),
        rows, writeOpts,
        statements: [db.monthlyWriteMultiStmt('gsc', pm.month, rows, writeOpts)],
      });
    }
    return applyMonthUnits(units, pm, 'gsc', revisions, result, details);
  }

  async function runGa4Month(project, pm, articles, revisions, fingerprint, today, result) {
    const { ga4AccountId } = resolveAccounts(project);
    const propertyId = project.ga4_property_id;
    const eventNames = [...new Set(parseKeyEventNames(project.key_event_names))].sort();
    const { start, end, monthEnd } = pm.range;
    const details = [];

    // 过滤集合按规范化路径去重（同一路径只进一个批次 → 不会重复累计）
    const pathSet = new Set();
    for (const a of articles) {
      for (const u of a.urls) pathSet.add(normPath(u));
    }
    const batches = pathSet.size ? chunkPathsForRegex([...pathSet]) : [];

    let byDate = new Map();
    let byDateEvents = new Map();
    let truncated = false;
    try {
      for (const paths of batches) {
        const [views, events] = await Promise.all([
          ga4.ga4Query(ga4AccountId, propertyId, start, end, paths),
          eventNames.length
            ? ga4.ga4KeyEventsQuery(ga4AccountId, propertyId, start, end, paths, eventNames)
            : Promise.resolve({ byDate: new Map(), truncated: false }),
        ]);
        if (views.truncated || events.truncated) truncated = true;
        mergeByDate(byDate, views.byDate);
        mergeByDate(byDateEvents, events.byDate);
      }
    } catch (e) {
      details.push(`GA4 抓取失败: ${e.message}`);
      result.failed.push({ month: pm.month, source: 'ga4', articleId: null, reason: e.message });
      await writeMonthAttemptError(project, pm, articles, revisions, 'ga4', fingerprint, e.message, details);
      if (isAuthError(e)) throw e;
      return { status: 'error', details };
    }
    if (truncated) {
      details.push('GA4 返回结果已达上限，本月未入库（保留上次成功值）');
      result.failed.push({ month: pm.month, source: 'ga4', articleId: null, reason: 'truncated' });
      await writeMonthAttemptError(project, pm, articles, revisions, 'ga4', fingerprint, 'GA4 返回行数达到上限，覆盖可能不完整', details);
      return { status: 'truncated', details };
    }

    const finalized = end >= monthEnd;
    const units = [];
    for (const group of chunk(articles, ROWS_PER_STMT)) {
      const rows = [];
      for (const a of group) {
        const { paths, ambiguous } = ga4PathsForArticle(a.urls);
        let pageviews = 0;
        for (const p of paths) pageviews += ga4ValueForArticle(byDate, p).pageviews;
        // 所选事件未配置 → keyEvents 留 NULL（未配置，不是 0）
        const keyEvents = eventNames.length && paths.length
          ? paths.reduce((sum, p) => sum + (ga4KeyEventsForArticle(byDateEvents, p) ?? 0), 0)
          : null;
        const mismatch = ambiguous.length ? `跨主机同路径歧义: ${ambiguous.join(', ')}` : null;
        rows.push({
          articleId: a.id,
          values: { pageviews, keyEvents },
          revision: revisions.get(a.id), mismatch,
        });
      }
      if (!rows.length) continue;
      const writeOpts = { fingerprint, coverStart: start, coverEnd: end, finalized,
        projectId: project.id, configRevision: project.config_revision };
      units.push({
        ids: rows.map((r) => r.articleId),
        rows, writeOpts,
        statements: [db.monthlyWriteMultiStmt('ga4', pm.month, rows, writeOpts)],
      });
    }
    return applyMonthUnits(units, pm, 'ga4', revisions, result, details);
  }

  // 错误只写尝试层；成功事实保持原值、覆盖及时间，失败来源下一轮仍需抓取。
  async function writeMonthAttemptError(project, pm, articles, revisions, source, fingerprint, error, details) {
    const opts = { fingerprint, error: String(error || '来源抓取失败').slice(0, 500),
      coverStart: null, coverEnd: null, finalized: false,
      projectId: project.id, configRevision: project.config_revision };
    for (const group of chunk(articles, ROWS_PER_STMT)) {
      const rows = group.map(article => ({ articleId: article.id, revision: revisions.get(article.id), values: {} }));
      const results = await db.db.batchAtomic([db.monthlyWriteMultiStmt(source, pm.month, rows, opts)]);
      if (Number(results[0]?.changes || 0) < rows.length) details.push(`${source} 失败尝试因项目配置或文章状态变化未全部写入`);
    }
  }

  // 回读校验：这个单元里哪些文章的月度行真的落库了（fetch_revision 与计划一致）
  async function landedArticleIds(unit, month) {
    const planned = new Map(unit.rows.map((r) => [Number(r.articleId), Number(r.revision)]));
    const named = { month };
    const inList = [...planned.keys()].map((id, i) => { named['i' + i] = id; return '@i' + i; }).join(',');
    const rows = await db.db.prepare(
      'SELECT article_id, fetch_revision FROM project_article_monthly_metrics WHERE month = @month AND article_id IN (' + inList + ')'
    ).all(named);
    return rows.filter((r) => planned.get(Number(r.article_id)) === Number(r.fetch_revision)).map((r) => Number(r.article_id));
  }

  // 逐篇一个业务单元写入 + 清 dirty（守卫在内）；返回真实应用篇数
  async function applyMonthUnits(units, pm, source, revisions, result, details) {
    if (!units.length) return { status: 'skipped', details };
    let applied = 0;
    const unitResult = await runUnitBatch(units, async (u) => {
      let r;
      try {
        r = await db.db.batchAtomic(u.statements);
      } catch (e) {
        // 整单失败（典型：同步途中文章被删，外键挡下整条语句）→ 逐行重试隔离坏行，
        // 好行照常落库，坏行记 failed。不重复提交已成功单元（这里本来就是失败单元）。
        const rows = u.rows || [];
        if (!rows.length) throw e;
        let isolated = 0;
        for (const row of rows) {
          try {
            const one = await db.db.batchAtomic([db.monthlyWriteMultiStmt(source, pm.month, [row], u.writeOpts)]);
            isolated += Number(one[0].changes || 0);
          } catch { /* 这一行确实写不进去（文章没了），记 failed */ }
        }
        applied += isolated;
        if (isolated < rows.length) {
          result.failed.push({ month: pm.month, source, articleId: u.ids[0], reason: String(e.message || e).slice(0, 200), count: rows.length - isolated });
        }
        return;
      }
      const n = Number(r[0].changes || 0);
      applied += n;
      if (n === 0) {
        result.failed.push({ month: pm.month, source, articleId: u.ids[0], reason: 'guard-rejected', count: u.ids.length });
      } else if (n < u.ids.length) {
        // 有行没落（守卫挡下/文章被删）。回读校验哪些真落库了：落库的（fetch_revision
        // 与计划一致）只记录成功；全部来源和本月完成后再清 dirty。
        const landed = await landedArticleIds(u, pm.month);
        const missed = u.ids.filter((id) => !landed.includes(id));
        if (missed.length) {
          result.partial = result.partial || [];
          result.partial.push({ month: pm.month, source, ids: missed, applied: landed.length });
        }
      }
    });
    result.fetched.sourceMonths += 1;
    result.fetched.articles += applied;
    if (unitResult.failed.length) {
      details.push(`${source} 有 ${unitResult.failed.length} 个写入单元失败`);
      return { status: 'partial', details };
    }
    if (applied === 0) {
      details.push(`${source} 全部写入被守卫挡下（同步途中文章被修改，留待下次刷新）`);
      return { status: 'guard-rejected', details };
    }
    if (result.partial?.length) details.push(`${source} 有部分文章的写入被守卫挡下（同步途中被修改，留待下次刷新）`);
    return { status: 'complete', details };
  }

  // 来源不可用：逐篇写状态（数值不动）
  async function markUnavailable(articles, month, source, reason, revisions, fingerprint) {
    const units = articles.map((a) => ({
      ids: [a.id],
      statements: [db.monthlyUnavailableStmt(a.id, month, source, reason, { revision: revisions.get(a.id), fingerprint })],
    }));
    if (!units.length) return;
    await runUnitBatch(units, (u) => db.db.batchAtomic(u.statements));
  }

  // 异常标注（截断/变体）：只动 mismatch 列，不动数值与状态。
  // UPSERT 而不是 UPDATE：这篇这个月还没有任何行时（首次同步就撞上变体），
  // UPDATE 会静默丢诊断——用户看不到「有流量没被计入」的提示。
  async function noteAnomaly(articles, month, source, note, revisions) {
    if (!articles.length) return;
    const bounds = monthBounds(month);
    const note500 = String(note).slice(0, 500);
    const units = articles.map((a) => ({
      ids: [a.id],
      statements: [db.db.prepare(
        `INSERT INTO project_article_monthly_metrics
           (article_id, month, month_start, month_end, mismatch, fetch_revision, updated_at)
         SELECT @aid, @month, @mStart, @mEnd, @note, @rev, @at
         WHERE (SELECT fetch_revision FROM project_articles WHERE id = @aid) = @rev
         ON CONFLICT(article_id, month) DO UPDATE SET
           mismatch = excluded.mismatch, fetch_revision = excluded.fetch_revision, updated_at = excluded.updated_at
         WHERE (SELECT fetch_revision FROM project_articles WHERE id = @aid) = @rev`
      ).bind({ note: note500, at: new Date().toISOString(), aid: a.id, month, mStart: bounds.start, mEnd: bounds.end, rev: revisions.get(a.id) })],
    }));
    await runUnitBatch(units, (u) => db.db.batchAtomic(u.statements));
  }

  function mergeByDate(target, source) {
    for (const [path, acc] of source) {
      if (!target.has(path)) target.set(path, new Map());
      const t = target.get(path);
      for (const [date, v] of acc) {
        const cur = t.get(date) || {};
        for (const k of Object.keys(v)) cur[k] = (cur[k] || 0) + v[k];
        t.set(date, cur);
      }
    }
  }


  // ============ 本月临时数据 ============

  // 探测 + 抓取 + 整行覆盖。每篇文章一行；三个来源各自的状态与截止日。
  // 探测失败（网络/鉴权）时截止日沿用上一次成功值——失败轮不把本月已有贡献抹掉。
  async function runCurrentMonth(project, { articles, today = businessToday(), articleId = null }) {
    const fps = buildFingerprints(project);
    const month = monthOf(today);
    const startedAt = new Date();
    const out = {
      month, status: 'ok', gscEndDate: null, ga4EndDate: null,
      requests: { gsc: 0, ga4: 0 }, rowsWritten: 0, errors: [], warnings: [],
      failedArticleIds: [], unprocessed: [],
    };
    const missing = articles.filter(a => !publicationDay(a));
    out.unprocessed = missing.map(a => ({ articleId: a.id, reason: '请先补填文章发布日期' }));
    if (missing.length) out.warnings.push('部分文章缺少发布日期，请先补填');
    const eligible = articles.filter(a => publicationDay(a) && publicationDay(a) <= today);
    if (!eligible.length) {
      out.status = 'skipped';
      out.reason = missing.length ? '请先补填文章发布日期' : '没有已发布文章';
      return out;
    }
    const { gscAccountId, ga4AccountId } = resolveAccounts(project);
    const eventNames = eventNamesOf(project);
    const hasKeyEvents = eventNames.length > 0;
    const existing = new Map((await db.db.prepare(
      'SELECT * FROM project_article_current_metrics WHERE project_id = ? AND month = ?'
    ).all(project.id, month)).map(row => [Number(row.article_id), row]));
    const previousEnd = (articleId, source, selectedPrefix = null) => {
      const row = existing.get(articleId);
      if (!row) return null;
      const prefixes = source === 'gsc' ? ['gsc'] : [selectedPrefix || 'ga4_views'];
      const dates = prefixes.map(prefix => {
        try {
          const config = JSON.parse(row[prefix + '_success_config'] || 'null');
          return config?.fingerprint === fps[source] ? config.cover_end : null;
        } catch { return null; }
      }).filter(day => isValidDay(day) && day >= monthBounds(month).start);
      return dates.length ? dates.sort().at(-1) : null;
    };
    const metrics = new Map(eligible.map(a => [a.id, {
      articleId: a.id, revision: a.fetch_revision,
      rangeStart: publicationDay(a) > monthBounds(month).start ? publicationDay(a) : monthBounds(month).start,
      gscClicks: null, gscImpressions: null, gscCtr: null, gscPosition: null,
      ga4Views: null, ga4KeyEvents: null,
      gscEndDate: previousEnd(a.id, 'gsc'), ga4EndDate: previousEnd(a.id, 'ga4'),
      gscState: fps.gsc ? 'pending' : 'unavailable',
      ga4ViewsState: fps.ga4 ? 'pending' : 'unavailable',
      ga4KeyEventsState: fps.ga4 ? (hasKeyEvents ? 'pending' : 'unconfigured') : 'unavailable',
      errors: [],
    }]));
    const markError = (group, states, label, error) => {
      const message = `${label}: ${String(error.message || error)}`;
      out.errors.push(message);
      for (const article of group) {
        const row = metrics.get(article.id);
        for (const key of states) row[key] = 'error';
        row.errors.push(message);
      }
    };
    const markEmpty = (source, endDate) => {
      for (const row of metrics.values()) {
        if (endDate && endDate >= row.rangeStart) continue;
        if (source === 'gsc') row.gscState = 'empty';
        else {
          row.ga4ViewsState = 'empty';
          if (hasKeyEvents) row.ga4KeyEventsState = 'empty';
        }
      }
    };

    if (fps.gsc) {
      try {
        out.requests.gsc++;
        const latest = await gsc.gscLatestDate(gscAccountId, project.gsc_site, { today });
        const window = currentWindow(month, latest);
        markEmpty('gsc', window.endDate);
        if (window.empty) out.warnings.push('GSC 本月暂无数据');
        const site = parseGscSite(project.gsc_site);
        for (const group of groupArticleWindows(eligible, month, window.endDate)) {
          try {
            const exact = new Map();
            for (const paths of group.batches) {
              if (buildPathRegex(paths).length > GSC_FILTER_MAX) throw new Error('URL 过滤表达式超长，请缩短登记地址或分批');
              out.requests.gsc++;
              const response = await gsc.gscQuery(gscAccountId, project.gsc_site, group.range.start,
                group.range.end, paths, { dataState: 'all' });
              if (response.truncated) throw new Error('GSC 返回已截断，保留上次成功值');
              for (const [page, value] of aggregateGscRows(response.raw || [])) exact.set(page, value);
            }
            for (const article of group.articles) {
              const value = gscValueForArticle(exact, article.urls || [article.url], site);
              if (value.error || (value.variant && value.clicks === undefined)) {
                markError([article], ['gscState'], 'GSC 本月临时', new Error('响应地址无法精确匹配登记地址'));
                continue;
              }
              const row = metrics.get(article.id);
              row.gscClicks = value.clicks ?? 0;
              row.gscImpressions = value.impressions ?? 0;
              row.gscCtr = value.ctr ?? null;
              row.gscPosition = value.position ?? null;
              row.gscEndDate = group.range.end;
              row.gscState = 'complete';
            }
          } catch (error) {
            if (isAuthError(error)) throw error;
            markError(group.articles, ['gscState'], 'GSC 本月临时', error);
          }
        }
      } catch (error) {
        if (isAuthError(error)) throw error;
        markError(eligible, ['gscState'], 'GSC 本月临时探测', error);
      }
    }

    if (fps.ga4) {
      try {
        out.requests.ga4++;
        const latest = await ga4.ga4LatestDate(ga4AccountId, project.ga4_property_id, {});
        const window = currentWindow(month, latest);
        markEmpty('ga4', window.endDate);
        if (window.empty) out.warnings.push('GA4 本月暂无数据');
        for (const group of groupArticleWindows(eligible, month, window.endDate)) {
          const readSource = async (query, extract, valueKey, stateKey, label) => {
            try {
              const byDate = new Map();
              for (const paths of group.batches) {
                out.requests.ga4++;
                const response = await query(ga4AccountId, project.ga4_property_id, group.range.start, group.range.end, paths);
                if (response.truncated) throw new Error(`${label}返回已截断，保留上次成功值`);
                mergeByDate(byDate, response.byDate);
              }
              for (const article of group.articles) {
                const row = metrics.get(article.id);
                const { paths } = ga4PathsForArticle(article.urls || [article.url]);
                row[valueKey] = paths.reduce((sum, pathname) => sum + (extract(byDate, pathname) ?? 0), 0);
                row[stateKey] = 'complete';
                row.ga4EndDate = group.range.end;
              }
            } catch (error) {
              if (isAuthError(error)) throw error;
              markError(group.articles, [stateKey], label + ' 本月临时', error);
            }
          };
          await readSource(ga4.ga4Query, (byDate, pathname) => ga4ValueForArticle(byDate, pathname).pageviews,
            'ga4Views', 'ga4ViewsState', 'GA4 浏览');
          if (hasKeyEvents) await readSource(
            (aid, pid, start, end, paths) => ga4.ga4KeyEventsQuery(aid, pid, start, end, paths, eventNames),
            (byDate, pathname) => ga4KeyEventsForArticle(byDate, pathname),
            'ga4KeyEvents', 'ga4KeyEventsState', 'GA4 关键事件');
        }
      } catch (error) {
        if (isAuthError(error)) throw error;
        markError(eligible, ['ga4ViewsState', ...(hasKeyEvents ? ['ga4KeyEventsState'] : [])], 'GA4 本月临时探测', error);
      }
    }

    // 配置与文章修订由写入层复核；停用/删除的文章也不会接受迟到响应。
    const activeIds = new Set((await db.listArticleUrlsForSync(project.id)).map(a => a.id));
    const live = [...metrics.values()].filter(row => activeIds.has(row.articleId));
    if (live.length !== metrics.size) out.warnings.push(`有 ${metrics.size - live.length} 篇文章在抓取期间被删除或停用`);
    out.rowsWritten = await db.upsertCurrentRows(project.id, live.map(row => ({
      ...row, month, errors: [...new Set(row.errors)],
    })), { fingerprints: fps, configRevision: project.config_revision });
    if (out.rowsWritten < live.length) out.errors.push('项目配置或文章状态在本月抓取期间变化，部分临时值未写入');
    await db.clearCurrentForInactive(project.id);
    out.failedArticleIds = live.filter(row => row.errors.length).map(row => row.articleId);
    if (out.rowsWritten < live.length) out.failedArticleIds = live.map(row => row.articleId);
    const maxDate = (key) => live.map(row => row[key]).filter(isValidDay).sort().at(-1) || null;
    out.gscEndDate = maxDate('gscEndDate');
    // 共享列代表本次窗口，最后成功的事件覆盖仍独立来自其事实配置。
    out.ga4EndDate = [maxDate('ga4EndDate'), ...live.filter(row => row.ga4KeyEventsState !== 'complete')
      .map(row => previousEnd(row.articleId, 'ga4', 'ga4_key_events'))].filter(isValidDay).sort().at(-1) || null;
    out.status = out.errors.length || out.unprocessed.length ? 'partial' : 'succeeded';
    out.durationMs = Date.now() - startedAt.getTime();
    await db.setCurrentSyncState(project.id, {
      status: out.status, month, gscEndDate: out.gscEndDate, ga4EndDate: out.ga4EndDate,
      externalRequests: out.requests.gsc + out.requests.ga4,
      rowsWritten: out.rowsWritten, lastSyncedAt: startedAt.toISOString(),
      lastError: out.errors.length ? [...new Set(out.errors)].join('；') : null,
    });
    return out;
  }

  return { planArticleSync, fetchArticleMetrics, fetchArticleMetricsUnit, finalizeArticleMetricsUnit, markArticleMetricsUnitError, buildFingerprints, runCurrentMonth };
}

module.exports = { createArticleMetricsFetchers };
