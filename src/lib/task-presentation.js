const parse = (value, fallback = {}) => { try { return JSON.parse(value || 'null') ?? fallback; } catch { return fallback; } };
const count = value => Number.isFinite(value) && value >= 0 ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(value) ? value : null;
const code = value => typeof value === 'string' && /^(SOURCE|NEWS|MODEL|BUDGET|AUTH|HTTP|FORBIDDEN|CONFLICT|INVALID|DEPENDENCY|LEASE|RUN|VALIDATION|CONFIG|INDEX|PERFORMANCE|STALE|TASK)[A-Z0-9_]{0,60}$/.test(value) ? value : value ? 'TASK_ERROR' : null;
const months = value => Array.isArray(value) ? value.filter(v => /^\d{4}-\d{2}$/.test(v)).slice(0, 600) : [];
// 保留业务原因与拆分提示，但不返回来源原文中的凭据、URL 查询或主机路径。
const redact = value => String(value ?? '').slice(0, 600)
  .replace(/Bearer\s+[^\s,;"}]+/gi, 'Bearer [已隐藏]')
  .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|authorization|token)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, '$1[已隐藏]')
  .replace(/https?:\/\/[^\s<>"']+/gi, '[来源地址]')
  .replace(/(?:sk-|AIza)[\w-]{12,}/g, '[已隐藏]')
  .replace(/(?:\/Users\/|\/var\/|\/private\/|\/home\/)[^\s"']+/g, '[路径]')
  .replace(/[a-zA-Z0-9_-]{40,}/g, '[已隐藏]');
function publicArticleMetrics(raw, status) {
  const out = articleMetrics(raw, status);
  out.engineStatus = typeof raw.engineStatus === 'string' && /^[a-z-]{1,40}$/.test(raw.engineStatus) ? raw.engineStatus : null;
  out.reason = raw.reason ? redact(raw.reason) : null;
  out.hint = raw.hint && typeof raw.hint === 'object' ? {
    ...(count(raw.hint.maxMonthsPerSync) !== null ? { maxMonthsPerSync: raw.hint.maxMonthsPerSync } : {}),
    ...(Array.isArray(raw.hint.suggestedBatches) ? { suggestedBatches: raw.hint.suggestedBatches.map(months).filter(a=>a.length).slice(0,100) } : {}),
  } : null;
  return out;
}
function articleMetrics(raw, status) {
  const m = raw || {}, remainingMonths = months(m.remainingMonths);
  const engineStatus = ['ok', 'succeeded', 'complete', 'partial', 'failed', 'error', 'busy', 'skipped', 'range-exceeded'].includes(m.engineStatus) ? m.engineStatus : null;
  const reason = engineStatus === 'range-exceeded' ? '同步范围超过预算，请按月份或文章拆分后重新提交'
    : engineStatus === 'busy' ? '该项目已有同步正在执行，请稍后核查'
      : engineStatus === 'skipped' ? '同步未执行，请检查发布日期及数据源配置'
        : remainingMonths.length ? m.autoContinue && ['queued','running'].includes(status)
          ? `剩余 ${remainingMonths.length} 个历史月份已排队，将自动继续` : `仍有 ${remainingMonths.length} 个历史月份未完成，请核查失败原因`
          : status === 'failed' ? '同步执行未完成，请核查项目数据源后重新提交'
            : status === 'partial' ? '部分文章或来源未完成，已保留成功结果' : null;
  return { engineStatus, reason, hint: engineStatus === 'range-exceeded' ? { action: 'split-range' } : null,
    months: count(m.months), totalMonths: count(m.totalMonths), batches: count(m.batches), autoContinue: m.autoContinue === true,
    dataThrough: date(m.dataThrough), remainingMonths, unprocessed: count(m.unprocessed),
    fetched: m.fetched ? { articles: count(m.fetched.articles), sourceMonths: count(m.fetched.sourceMonths) } : null,
    current: m.current ? { month: months([m.current.month])[0] || null,
      status: ['succeeded', 'partial', 'failed', 'skipped'].includes(m.current.status) ? m.current.status : null,
      gscEndDate: date(m.current.gscEndDate), ga4EndDate: date(m.current.ga4EndDate) } : null };
}
module.exports = { parse, count, date, code, months, articleMetrics, publicArticleMetrics, redact };
