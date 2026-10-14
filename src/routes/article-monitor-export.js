// article-monitor-export.js —— 站内外 XLSX 导出路由（任务13）
// 只读导出：不触发同步、不隐式抓数；口径与看板列表完全一致（全量命中，不限当页）。
// 静态路由先于 /:articleId 动态路由注册（app.js 里先挂本文件）。
// 公式注入在写入单元格时统一加 ' 前缀（src/lib/xlsx.js），源数据不改写。

const express = require('express');
const zlib = require('node:zlib');
const { wrap, parseId, badId } = require('../lib/http');
const { buildXlsx } = require('../lib/xlsx');
const { monthOf } = require('../lib/business-dates');
const { businessToday } = require('../lib/business-dates');
const { detailMonths } = require('../lib/current-month');

const ATTAIN_LABEL = {
  attained: '已达标', 'not-attained': '未达标', observation: '观察期', pending: '待判断',
  'pending-key-events': '待配置关键事件', 'data-issue': '数据异常', syncing: '同步中',
};
const SYNC_LABEL = { ok: '已同步', dirty: '待刷新', error: '抓取失败' };
const SRC_LABEL = { complete: '完整成功', pending: '待取数', unavailable: '来源不可用', error: '抓取失败' };
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// 筛选条件说明行（导出文件里必须带，避免脱上下文后误读）
function filterNote(filters) {
  const parts = [];
  if (filters.project_id) parts.push('项目=' + filters.project_id);
  if (filters.status) parts.push('状态=' + filters.status);
  if (filters.copywriter_user_id) parts.push('文案师user_id=' + filters.copywriter_user_id);
  if (filters.missing_published_at) parts.push('缺发布日期');
  if (filters.unassigned) parts.push('未指派');
  if (filters.domain) parts.push('平台域名=' + filters.domain);
  if (filters.attainment) parts.push('达标=' + filters.attainment);
  if (filters.sync) parts.push('同步=' + filters.sync);
  if (filters.query) parts.push('搜索=' + filters.query);
  return parts.length ? parts.join('；') : '无（全部命中）';
}

function sendXlsx(res, filename, sheets) {
  const buf = buildXlsx(sheets);
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}

module.exports = function articleMonitorExportRoutes({ db, assertProjectAccess }) {
  const router = express.Router();

  // 显式指定 project_id 时先过项目访问校验——无权项目返回 403，而不是悄悄导出空文件
  async function assertExportProject(req, res, projectId) {
    if (!projectId) return true;
    return Boolean(await assertProjectAccess(req, res, projectId));
  }

  // ============ 站内导出 ============
  router.get('/api/article-monitor/export.xlsx', wrap(async (req, res) => {
    const q = req.query || {};
    const filters = {
      project_id: q.project_id ? parseId(q.project_id) : null,
      status: q.status || '',
      copywriter_user_id: q.copywriter_user_id ? Number(q.copywriter_user_id) : null,
      missing_published_at: q.missing_published_at === '1',
      unassigned: q.unassigned === '1',
      attainment: q.attainment || '',
      sync: q.sync || '',
      query: q.query || '',
      sort: q.sort || '',
      dir: q.dir || '',
    };
    if (!(await assertExportProject(req, res, filters.project_id))) return;
    const who = { userId: req.user.id, isAdmin: req.user.role === 'admin' };
    const { rows, summary } = await db.listMonitorAll(who, filters);
    const ids = rows.map((r) => r.id);
    // 本月临时行与月度矩阵同口径：当前月的未定稿月度行（旧模型残留）不写进矩阵，
    // 改由临时行占位并标「含临时数据」（各源截至日不同，矩阵里用两个覆盖列表达）。
    const currentRows = await db.listCurrentForArticles(ids);
    const currentByArticle = new Map(currentRows.map((r) => [Number(r.article_id), r]));
    const currentMonth = monthOf(businessToday());
    const monthly = await db.listMonthlyForArticles(ids);
    const monthlyByArticle = new Map();
    for (const m of monthly) {
      if (!monthlyByArticle.has(Number(m.article_id))) monthlyByArticle.set(Number(m.article_id), []);
      monthlyByArticle.get(Number(m.article_id)).push(m);
    }
    const effectiveByArticle = new Map(rows.map(r => [r.id, detailMonths(monthlyByArticle.get(r.id) || [], currentByArticle.get(r.id), currentMonth).filter(row => !r.published_at || row.month >= r.published_at.slice(0, 7))]));
    const months = [...new Set([...effectiveByArticle.values()].flatMap(values => values.map(row => row.month)))].sort();

    // 1) 汇总（与列表列一致；NULL 空白、0 数值）
    const summaryRows = [['URL', '标题', '项目', '文案师', '发布日期', '状态',
      '累计点击', '累计浏览', '累计事件', '转化率', '达标', '达标说明',
      '同步状态', 'GSC数据截至', 'GA4数据截至']];
    for (const r of rows) {
      summaryRows.push([
        r.url, r.title, r.project_id, r.copywriter_name || r.copywriter_email,
        r.published_at, r.status === 'active' ? '在册' : '已停用',
        r.cumulative.clicks, r.cumulative.views, r.cumulative.events,
        r.cumulative.ratio === null ? null : +(r.cumulative.ratio * 100).toFixed(2) + '%',
        ATTAIN_LABEL[r.attainment.status] || r.attainment.status,
        (r.attainment.evidence || []).concat(r.attainment.reasons || []).join('；') || null,
        SYNC_LABEL[r.syncStatus] || r.syncStatus,
        r.gsc.coverEnd, r.ga4.coverEnd,
      ]);
    }

    // 2) 文章×月份矩阵（点击/浏览/事件）+ 不完整月份
    const matrixHead = ['URL', '标题'];
    for (const m of months) matrixHead.push(m + '点击', m + '浏览', m + '事件');
    matrixHead.push('不完整月份');
    const matrixRows = [matrixHead];
    for (const r of rows) {
      const row = [r.url, r.title];
      const incomplete = [];
      for (const m of months) {
        const rec = effectiveByArticle.get(r.id).find(value => value.month === m);
        row.push(rec?.gscClicks ?? null, rec?.ga4Pageviews ?? null, rec?.ga4KeyEvents ?? null);
        if (rec?.provisional) incomplete.push(m + '(临时)');
        else if (rec && Object.values(rec.state).some(state => state !== 'complete')) incomplete.push(m);
      }
      row.push(incomplete.join('、') || null);
      matrixRows.push(row);
    }

    // 3) 状态与截至日（每篇 × 每来源）
    const stateRows = [['URL', '来源', '状态', '覆盖起', '覆盖止(数据截至日)', '抓取时间', '是否定稿', 'mismatch']];
    for (const r of rows) {
      for (const m of monthlyByArticle.get(r.id) || []) {
        for (const [src, label] of [['gsc', 'GSC'], ['ga4', 'GA4']]) {
          stateRows.push([
            r.url, label, SRC_LABEL[m[src + '_status']] || m[src + '_status'],
            m[src + '_cover_start'], m[src + '_cover_end'], m[src + '_fetched_at'],
            m[src + '_finalized'] ? '是' : '否', m.mismatch || null,
          ]);
        }
      }
    }

    // 5) 筛选说明
    const noteRows = [
      ['筛选条件', filterNote(filters)],
      ['导出时间', new Date().toISOString()],
      ['命中文章数', summary.total],
      ['已达标 / 未达标 / 观察期 / 待判断', `${summary.attained} / ${summary.notAttained} / ${summary.observation} / ${summary.pending}`],
      ['待配置关键事件 / 数据异常 / 同步中', `${summary.pendingKeyEvents} / ${summary.dataIssue} / ${summary.syncing}`],
      ['达标率', summary.rate === null ? '—（分母为0）' : (summary.rate * 100).toFixed(1) + '%'],
      ['总转化率', summary.conversionRate === null ? '—（分母为0）' : (summary.conversionRate * 100).toFixed(2) + '%'],
      ['待补发布日期', summary.missingPublishedAt],
      ['数据异常', summary.anomaly],
      ['口径说明', 'NULL=未知（没抓过/抓失败），0=抓到零；累计汇总完整成功的月度行，抓取失败的月份回退到最后一次成功值（状态列仍是失败）；每个月的每个来源只计入一份有效值；达标率分母=命中数−观察期'],
    ];

    sendXlsx(res, 'article-monitor.xlsx', [
      { name: '筛选说明', rows: noteRows },
      { name: '汇总', rows: summaryRows },
      { name: '月度矩阵', rows: matrixRows },
      { name: '状态与截至日', rows: stateRows },
    ]);
  }));

  // ============ 外链平台导出 ============
  router.get('/api/article-monitor/external/export.xlsx', wrap(async (req, res) => {
    const q = req.query || {};
    const searchQuery = q.query || q.q || '';
    const filters = {
      project_id: q.project_id ? parseId(q.project_id) : null,
      status: q.status || '',
      copywriter_user_id: q.copywriter_user_id ? Number(q.copywriter_user_id) : null,
      missing_published_at: q.missing_published_at === '1',
      unassigned: q.unassigned === '1',
      domain: q.domain || '',
      sync: q.sync || '',
      q: searchQuery,
      query: searchQuery,
      sort: q.sort || '',
      dir: q.dir || '',
    };
    if (!(await assertExportProject(req, res, filters.project_id))) return;
    const who = { userId: req.user.id, isAdmin: req.user.role === 'admin' };
    const { rows, summary } = await db.listPlatformsAll(who, filters);

    // 平台汇总（平台数字不因作者筛选变成「作者贡献」——表头与说明都写明整体口径）
    const platformRows = [['平台域名', '项目', '登记外链', '活跃外链', '命中外链',
      '每日用户数累计', '数据截至', '事件累计', '冻结段数', '数据状态']];
    for (const p of rows) {
      platformRows.push([
        p.domain, p.project_name, p.registeredArticleCount, p.activeArticleCount, p.matchedArticleCount,
        p.usersTotal, p.dataThrough, p.eventsTotal, p.freezeCount,
        p.staleConfig ? '旧配置' : (p.complete ? '完整' : '不完整'),
      ]);
    }

    // 文章参考明细（逐平台展开：窗口/份额/冻结段/活跃段）
    const detailRows = [['平台域名', '项目', 'URL', '标题', '文章状态',
      '窗口起', '窗口止', '份额', '冻结段版本', '冻结区间', '冻结用户值', '冻结事件值',
      '冻结来源状态', '冻结数据截至', '停用时间', '活跃段起', '活跃段用户值', '活跃段完整性', '参考合计', '参考完整性']];
    for (const p of rows) {
      const detail = await db.platformArticles(p.project_id, p.domain);
      for (const a of detail.articles) {
        const freezes = a.freezes.length
          ? a.freezes.map((f) => [
            p.domain, p.project_name, a.url, a.title, a.status === 'active' ? '活跃' : '已停用',
            a.window ? a.window.start : null, a.window ? a.window.end : null,
            a.window ? +a.window.share.toFixed(4) : null, f.segmentRevision, f.from + ' ~ ' + f.to,
            f.usersValue, f.eventsValue, f.usersStatus + '/' + f.eventsStatus,
            f.dataThrough, f.revokedAt,
            a.activeSegment ? a.activeSegment.start : null,
            a.activeSegment && a.activeSegment.users ? a.activeSegment.users.value : null,
            a.activeSegment && a.activeSegment.users ? (a.activeSegment.users.complete ? '完整' : '不完整') : null,
            a.referenceUsers, a.referenceComplete ? '完整' : '不完整',
          ])
          : [[
            p.domain, p.project_name, a.url, a.title, a.status === 'active' ? '活跃' : '已停用',
            a.window ? a.window.start : null, a.window ? a.window.end : null,
            a.window ? +a.window.share.toFixed(4) : null, null, null, null, null, null, null, null,
            a.activeSegment ? a.activeSegment.start : null,
            a.activeSegment && a.activeSegment.users ? a.activeSegment.users.value : null,
            a.activeSegment && a.activeSegment.users ? (a.activeSegment.users.complete ? '完整' : '不完整') : null,
            a.referenceUsers, a.referenceComplete ? '完整' : '不完整',
          ]];
        detailRows.push(...freezes);
      }
    }

    const noteRows = [
      ['筛选条件', filterNote(filters)],
      ['导出时间', new Date().toISOString()],
      ['命中平台数', summary.platformCount],
      ['登记/活跃/命中外链', `${summary.registeredArticleCount} / ${summary.activeArticleCount} / ${summary.matchedArticleCount}`],
      ['冻结段数', summary.freezeCount],
      ['口径说明', '平台值为当前有效日数据单独 SUM（不冻结、不分摊）；「每日用户数累计」跨日重复计算同一来源访客；文章参考合计 ≠ 平台总数（迁移、空档、冻结时点不同）；筛选不改变平台口径'],
    ];

    sendXlsx(res, 'external-platform.xlsx', [
      { name: '筛选说明', rows: noteRows },
      { name: '平台汇总', rows: platformRows },
      { name: '文章参考明细', rows: detailRows },
    ]);
  }));

  return router;
};
