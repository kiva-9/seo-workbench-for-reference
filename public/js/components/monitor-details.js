// 后端已按月合并各来源；同月临时值只在没有合并月记录时作为占位展示。
export function monthlyOverviewRows(detail, { esc, fmtNum, fmtPct = value => value == null ? '—' : (Number(value) * 100).toFixed(2) + '%', fmtPos = value => value == null ? '—' : Number(value).toFixed(1) }) {
  const caption = text => text ? `<span class="am-detail-source-date">${esc(text)}</span>` : '';
  const months = new Map((detail.monthly || []).map(month => [month.month, month]));
  const current = detail.current;
  if (current && !months.has(current.month)) {
    const published = detail.article?.published_at;
    months.set(current.month, {
      month: current.month, currentOnly: true, provisional: true,
      rangeStart: published ? [current.month + '-01', published].sort().at(-1) : null,
      gscClicks: current.clicks, gscImpressions: current.gscImpressions,
      gscCtr: current.gscCtr, gscPosition: current.gscPosition,
      ga4Pageviews: current.views, ga4KeyEvents: current.events,
      gscCoverEnd: current.gscEndDate, ga4CoverEnd: current.ga4EndDate,
      state: current.sourceState,
      currentNote: current.state === 'waiting' ? current.note || '等待同步'
        : current.syncedAt ? '同步于 ' + String(current.syncedAt).replace('T', ' ').slice(0, 16) : '',
    });
  }
  return [...months.values()].sort((a, b) => String(b.month).localeCompare(String(a.month))).map(month => {
    const temporary = month.provisional && (month.currentOnly || month.month === current?.month || month.isCurrentMonth === true);
    const state = temporary ? '<span class="tag tag-gray">本月临时</span>'
      : month.provisional ? caption('含临时数据') : !(month.gscFinalized && month.ga4Finalized) ? caption('未定稿') : '';
    const range = month.currentOnly ? month.rangeStart ? `${esc(month.rangeStart)} 起` : '请补填发布日期'
      : month.rangeStart ? `${esc(month.rangeStart)} — ${esc(month.rangeEnd || '—')}` : '请补填发布日期';
    const retained = month.fromLastSuccess && Object.values(month.fromLastSuccess).some(Boolean) ? caption('保留最后成功值') : '';
    const sourceDate = (key, fallback) => {
      const coverage = month.sourceCoverage?.[key];
      if (!(coverage ? coverage.provisional : month.provisional)) return '';
      const end = coverage && Object.hasOwn(coverage, 'endDate') ? coverage.endDate : fallback;
      return caption(end ? '截至 ' + end : '');
    };
    const sourceState = key => caption({ partial: '数据不完整', truncated: '数据不完整', error: '数据不完整',
      pending: '待同步', unavailable: '来源不可用', unconfigured: '未配置', empty: '暂无数据' }[month.state?.[key]] || '');
    const gscDate = sourceDate('gsc', month.gscCoverEnd) + sourceState('gsc');
    const ga4Date = sourceDate('views', month.ga4CoverEnd) + sourceState('views');
    const eventDate = sourceDate('events', month.ga4CoverEnd) + sourceState('events');
    return `<tr${temporary ? ' class="am-current-month"' : ''}>
      <td><strong>${esc(month.month)}</strong>${state}</td>
      <td>${range}${caption(month.currentNote)}${retained}</td>
      <td class="am-detail-num"><strong>${fmtNum(month.gscClicks)}</strong>${gscDate}</td>
      <td class="am-detail-num"><strong>${fmtNum(month.gscImpressions)}</strong>${gscDate}</td>
      <td class="am-detail-num"><strong>${fmtPct(month.gscCtr)}</strong></td>
      <td class="am-detail-num"><strong>${fmtPos(month.gscPosition)}</strong></td>
      <td class="am-detail-num"><strong>${fmtNum(month.ga4Pageviews)}</strong>${ga4Date}</td>
      <td class="am-detail-num"><strong>${fmtNum(month.ga4KeyEvents)}</strong>${eventDate}</td></tr>`;
  }).join('');
}
