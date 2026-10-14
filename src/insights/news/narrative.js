function modelEvidence(card){
  const reports=card.evidence.filter(e=>e.kind==='feed_report').slice(0,3).map(e=>({id:e.id,kind:e.kind,title:e.title.slice(0,300),summary:e.summary.slice(0,600),publisher:e.publisher,url:e.url,published_at:e.published_at,source_tier:e.source_tier,discovery_source:e.discovery_source,
    limitations:e.discovery_source?['聚合搜索材料只作为发现线索，需要核查原文。']:['仅使用 feed 摘要，未读取网页全文。']}));
  const {related_reports,...context}=card.context;
  const related=related_reports.map(r=>({...r,kind:'related_feed_report',title:r.title.slice(0,300),summary:r.summary.slice(0,400)}));
  const dossier={...context,related_report_ids:related.map(r=>r.id)};
  return [...reports,...related,{id:'news:selection',kind:'curation_rule',decision:card.selection.decision,matched_keywords:card.selection.matched_keywords,reasons:card.selection.reasons},dossier,
    {id:'news:context',kind:'project_context',limitations:card.limitations}];
}
module.exports={modelEvidence};
