const {domainToASCII}=require('node:url');

function webUrl(value) {
  if(typeof value!=='string'||value.length>4000||/[\u0000-\u0020\u007f]/.test(value))return null;
  try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url:null;}
  catch{return null;}
}
function propertyContains(property,value) {
  const url=webUrl(value);if(!url||url.hash||typeof property!=='string')return false;
  if(property.startsWith('sc-domain:')){
    const raw=property.slice(10),domain=domainToASCII(raw).toLowerCase();
    if(!domain||domain!==raw.toLowerCase()||!domain.includes('.')||/[^a-z0-9.-]/.test(domain)
      ||domain.startsWith('.')||domain.endsWith('.')||domain.includes('..'))return false;
    const host=url.hostname.toLowerCase();return host===domain||host.endsWith(`.${domain}`);
  }
  const prefix=webUrl(property);
  return Boolean(prefix&&!prefix.search&&!prefix.hash&&property.endsWith('/')
    &&url.origin===prefix.origin&&url.pathname.startsWith(prefix.pathname));
}
const text=(value,max=500)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max):null;
const canonical=value=>webUrl(value)?value:null;
function officialResult(response) {
  const result=response?.inspectionResult;
  const index=result?.indexStatusResult;
  const verdict=text(index?.verdict,80);
  const status=verdict==='PASS'?'indexed':['NEUTRAL','FAIL'].includes(verdict)?'not_indexed':'unknown';
  const rawLink=result?.inspectionResultLink,link=webUrl(rawLink);
  return {valid:status!=='unknown',status,execution_status:'succeeded',
    official:{verdict,coverageState:text(index?.coverageState),indexingState:text(index?.indexingState,80),
      robotsTxtState:text(index?.robotsTxtState,80),pageFetchState:text(index?.pageFetchState,80),
      lastCrawlTime:typeof index?.lastCrawlTime==='string'&&Number.isFinite(Date.parse(index.lastCrawlTime))?index.lastCrawlTime:null,
      googleCanonical:canonical(index?.googleCanonical),userCanonical:canonical(index?.userCanonical)},
    inspection_link:link&&link.protocol==='https:'&&link.hostname==='search.google.com'
      &&link.pathname.startsWith('/search-console/')?rawLink:null,
    invalid_canonical:Boolean(index?.googleCanonical&&!canonical(index.googleCanonical))
      ||Boolean(index?.userCanonical&&!canonical(index.userCanonical)),
    failure:null,
  };
}
function decodeSnapshot(row) {
  if(!row)return null;
  let data;try{data=JSON.parse(row.data_json);}catch{data={};}
  return {...data,id:row.id,project_id:row.project_id,run_id:row.run_id,article_id:row.article_id,
    url:row.url,property:row.property,checked_at:row.checked_at,valid:Boolean(row.valid),status:row.status};
}
function reviewReasons(previous,current) {
  if(!previous)return [];
  const reasons=[];
  for(const field of ['url','property'])if(previous[field]!==current[field])reasons.push(`${field}_changed`);
  if(previous.fetch_revision!==undefined&&previous.fetch_revision!==current.fetch_revision)reasons.push('article_revision_changed');
  // A negative verdict normally omits Google canonical; absence alone does not prove an identity change.
  for(const field of ['googleCanonical','userCanonical']){
    const old=previous.official?.[field],next=current.official?.[field];
    if(old&&next&&old!==next)reasons.push(`${field}_changed`);
  }
  if(previous.invalid_canonical||current.invalid_canonical)reasons.push('invalid_canonical');
  return reasons;
}
function snapshotEvidence(snapshot) {
  if(!snapshot)return null;
  return {id:snapshot.id,article_id:snapshot.article_id,url:snapshot.url,property:snapshot.property,
    fetch_revision:snapshot.fetch_revision??null,checked_at:snapshot.checked_at,valid:snapshot.valid,
    state:snapshot.status,category:snapshot.comparison?.category??snapshot.status,
    execution_status:snapshot.execution_status??(snapshot.valid?'succeeded':'failed'),
    official:snapshot.official??null,inspection_link:snapshot.inspection_link??null,
    failure:snapshot.failure??null,provenance:snapshot.provenance??'url_inspection'};
}
function compareSnapshots(current,history,{confirm_hours=24,stale_days=7}={}) {
  const before=history.filter(s=>s.id!==current.id&&Date.parse(s.checked_at)<=Date.parse(current.checked_at));
  const valid=before.filter(s=>s.valid&&['indexed','not_indexed'].includes(s.status));
  const previous=valid[0]??null,reasons=reviewReasons(previous,current);
  if(previous){
    for(const attempt of before.slice(0,before.indexOf(previous))){
      reasons.push(...reviewReasons(previous,attempt).filter(reason=>!reasons.includes(reason)));
    }
  }
  const result={category:current.status,latest_valid:current.valid?current:previous,
    baseline:previous,evidence:[current],review_reasons:reasons,recovered:false,
    first_negative:null,confirm_hours,confirmation_rule_tentative:true,
    stale:Boolean(previous&&Date.parse(current.checked_at)-Date.parse(previous.checked_at)>stale_days*86400000)};
  if(previous)result.evidence.unshift(previous);
  if(current.execution_status==='failed'){result.category='check_failed';return result;}
  if(reasons.length){result.category='needs_review';return result;}
  if(!current.valid){result.category='unknown';return result;}
  if(!previous)return result;
  if(current.status==='indexed'){
    if(previous.status==='not_indexed'){
      let olderPass=null;
      for(const snapshot of previous.comparison?.category==='needs_review'?[]:valid.slice(1)){
        if(reviewReasons(snapshot,current).length)break;
        if(snapshot.status==='indexed'){olderPass=snapshot;break;}
      }
      result.category=olderPass?'indexed':'newly_indexed';result.recovered=Boolean(olderPass);
    }
    return result;
  }
  let firstNegative=current,baseline=null;
  for(const snapshot of valid){
    if(reviewReasons(snapshot,current).length)break;
    if(snapshot.status==='not_indexed'&&snapshot.comparison?.category==='needs_review'){firstNegative=snapshot;break;}
    if(snapshot.status==='indexed'){baseline=snapshot;break;}
    firstNegative=snapshot;
  }
  if(!baseline)return result;
  result.baseline=baseline;result.first_negative=firstNegative;
  const elapsed=Date.parse(current.checked_at)-Date.parse(firstNegative.checked_at);
  result.category=firstNegative.id!==current.id&&elapsed>=confirm_hours*3600000
    ?'persistent_not_indexed':'suspected_drop';
  result.evidence=[baseline,...(firstNegative.id===current.id?[]:[firstNegative]),current];
  return result;
}
module.exports={propertyContains,officialResult,decodeSnapshot,reviewReasons,snapshotEvidence,compareSnapshots};
