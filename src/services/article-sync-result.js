// 只有明确成功的引擎结果才能记成功；未执行的结果也保留拆分提示供调用方采取行动。
function jobResultPatch(out) {
  const errors = (out.failed || []).map(f => `${f.month || ''} ${f.source || ''}: ${f.reason || ''}`.trim());
  errors.push(...(out.current?.errors || []));
  const knownSuccess = ['ok', 'succeeded', 'complete'].includes(out.status);
  const incomplete = errors.length || (out.partial || []).length || (out.unprocessed || []).length
    || (out.current && !['ok', 'succeeded', 'complete'].includes(out.current.status));
  const status = out.status === 'partial' || (knownSuccess && incomplete) ? 'partial' : knownSuccess ? 'succeeded' : 'failed';
  const defaults = { busy: '该项目正在刷新中', skipped: '同步未执行', 'range-exceeded': '同步范围超限', error: '同步失败', failed: '同步失败' };
  const reason = out.reason || out.error || (status === 'failed' ? defaults[out.status] || `同步引擎返回未知状态: ${String(out.status ?? '缺失')}` : null);
  if (reason) errors.push(reason);
  if (status === 'partial' && !errors.length) errors.push('部分文章或来源未完成同步');
  return {
    status, progressStep: reason || (status === 'partial' ? '部分文章或来源未完成同步' : null),
    errors: [...new Set(errors)],
    metrics: {
      engineStatus: out.status ?? null, reason, hint: out.hint ?? null,
      months: (out.months || []).length,
      dataThrough: out.dataThrough || null,
      current: out.current ? { month: out.current.month, gscEndDate: out.current.gscEndDate || null, ga4EndDate: out.current.ga4EndDate || null, status: out.current.status } : null,
      fetched: out.fetched || null,
      warnings: out.warnings || [], unprocessed: (out.unprocessed || []).length,
      remainingMonths: out.remainingMonths || [],
    },
  };
}

module.exports = { jobResultPatch };
