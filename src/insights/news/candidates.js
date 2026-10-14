function boundedCandidates(reports,limit=300){
  const buckets=new Map();
  for(const report of reports){if(!buckets.has(report.source_id))buckets.set(report.source_id,[]);buckets.get(report.source_id).push(report);}
  for(const bucket of buckets.values())bucket.sort((a,b)=>(b.curation?.matched_keywords?.length||0)-(a.curation?.matched_keywords?.length||0)||(b.first_published_at||'').localeCompare(a.first_published_at||'')||a.id.localeCompare(b.id));
  const sources=[...buckets].sort(([a],[b])=>a.localeCompare(b)),selected=[];
  for(let row=0;selected.length<limit;row++){
    let added=false;
    for(const [,items]of sources){if(items[row]){selected.push(items[row]);added=true;if(selected.length===limit)break;}}
    if(!added)break;
  }
  return selected;
}
module.exports={boundedCandidates};
