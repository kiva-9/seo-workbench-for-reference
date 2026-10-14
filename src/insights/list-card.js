function compactCard(card){
  const d=card.data;
  return {...card,data:{summary:d.summary,description:d.description,reason:d.reason,provenance:d.provenance,
    period:d.period,published_at:d.published_at,last_valid_state:d.last_valid_state,
    model:d.model?{status:d.model.status,explanation:d.model.explanation?{summary:d.model.explanation.summary}:null,error_code:d.model.error_code,validation:d.model.validation}:undefined,
    sources:d.sources?{gsc:{baseline:{values:d.sources.gsc?.baseline?.values},current:{values:d.sources.gsc?.current?.values}}}:undefined,
    relevance:d.relevance?{matched_keywords:d.relevance.matched_keywords,promotion:d.relevance.promotion}:undefined,
    publisher:d.publisher,reports:d.reports?.map(r=>({source_name:r.source_name,publisher:r.publisher,discovery_source:r.discovery_source})),
    history:d.history?{start:d.history.start,end:d.history.end,requested_months:d.history.requested_months,comparable_months:d.history.series?.gsc?.comparable_months}:undefined,
    context:d.context?{related_count:d.context.related_reports?.length,coverage:d.context.coverage}:undefined,
  }};
}
function compactRun(run){
  const counts=Object.fromEntries(Object.entries(run.result?.counts||{}).filter(([,v])=>typeof v!=='object'));
  return {...run,result:run.result?{counts,version:run.result.version}:null};
}
module.exports={compactCard,compactRun};
