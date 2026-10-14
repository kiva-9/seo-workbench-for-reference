const {knownDate,firstPublished}=require('./curation');

function buildDossier(group,groups,input,sourceStates){
  const words=new Set(group.selection.matched_keywords);
  const related=groups.filter(other=>other.event_key!==group.event_key&&other.reports.some(r=>r.curation?.matched_keywords?.some(w=>words.has(w))))
    .filter(other=>knownDate(other.representative)&&other.representative.summary.trim().length>=input.news.min_summary_chars)
    .sort((a,b)=>firstPublished(b.representative).localeCompare(firstPublished(a.representative))).slice(0,6);
  const reports=related.map(other=>({id:other.representative.id,event_key:other.event_key,title:other.representative.title,
    summary:other.representative.summary,url:other.representative.url,publisher:other.representative.publisher,
    published_at:firstPublished(other.representative),source_tier:other.representative.source_tier,
    relation:'shared_attention_words',matched_keywords:other.representative.curation?.matched_keywords||[]}));
  const publishers=[...new Set([...group.reports,...related.flatMap(other=>other.reports)].map(r=>r.publisher_key))];
  const dates=[...group.reports,...related.map(other=>other.representative)].filter(knownDate).map(firstPublished).sort();
  return {id:'news:dossier',kind:'news_dossier',window:input.window,focus_words:[...words],related_reports:reports,
    coverage:{configured_sources:input.sources.length,succeeded_sources:sourceStates.filter(s=>s.status==='succeeded').length,
      failed_sources:sourceStates.filter(s=>s.status==='failed').length,declared_publishers:publishers.length,
      earliest_publication:dates[0]||null,latest_publication:dates.at(-1)||null},
    observation:reports.length?'存在同关注方向的其他报道，可比较其时间、主体和适用条件。':'当前只有该事件材料，跨事件背景仍不足。',
    limitations:['关注词重叠只证明材料可能相关，不证明属于同一事件或存在因果。','发布机构数量来自 feed 声明，不代表已独立核实或确认行业趋势。','请结合相关报道辨别一致与分歧、项目机会与不适用条件；材料未支持的判断应保留未知。']};
}
module.exports={buildDossier};
