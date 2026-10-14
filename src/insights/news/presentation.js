const {modelEvidence}=require('./narrative');
const {projectReferences}=require('../model-references');
const {CURATION_VERSION}=require('./curation');

// Short labels are a model transport detail. Resolve prose only against already validated citations.
function readableNewsModel(data){
  const explanation=data.model?.explanation;
  if(data.grouping?.version!==CURATION_VERSION||data.model?.status!=='succeeded'||!Array.isArray(explanation?.evidenceIds)||!Array.isArray(data.context?.related_reports)||!data.selection)return data.model;
  let evidence;try{evidence=modelEvidence(data);}catch{return data.model;}
  const references=projectReferences(evidence),cited=new Set(explanation.evidenceIds);
  // A cited dossier explicitly includes these report IDs in the model input.
  if(cited.has(data.context.id))for(const report of data.context.related_reports)cited.add(report.id);
  const names=new Map(evidence.filter(e=>cited.has(e.id)).map(e=>[e.id,
    ['feed_report','related_feed_report'].includes(e.kind)?`「${e.publisher||e.discovery_source||'资讯来源'}」的报道`:
    e.kind==='curation_rule'?'资讯筛选记录':e.kind==='news_dossier'?'近期资讯材料':e.kind==='project_context'?'项目背景材料':null]));
  const replacements=new Map([...references.byLabel].filter(([,id])=>names.get(id)).map(([label,id])=>[label,names.get(id)]));
  const prose=value=>typeof value==='string'?value.replace(/https?:\/\/[^\s<>]+|(?<![A-Za-z0-9_])e[A-Z]+(?![A-Za-z0-9_])/g,label=>replacements.get(label)||label):value;
  const display={...explanation};
  for(const field of ['summary','hypotheses','recommendedChecks','suggestedActions','limitations'])if(Array.isArray(display[field]))display[field]=display[field].map(prose);else display[field]=prose(display[field]);
  return {...data.model,explanation:display};
}
module.exports={readableNewsModel};
