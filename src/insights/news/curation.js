const {hash}=require('../contracts');
const {normalizeText}=require('./text');

const CURATION_VERSION='news-curation-v4';
const MIN_COPY_CHARS=40;

function sourceMetadata(report,source) {
  const configured=String(source.publisher||'').trim();
  const hostname=new URL(source.url).hostname.toLowerCase().replace(/\.$/,'');
  if(hostname.length>253)throw Object.assign(new Error('NEWS_URL_BLOCKED'),{code:'NEWS_URL_BLOCKED'});
  const publisher=configured||(source.kind==='search'?report.reported_publisher:null)||hostname;
  return {...report,source_tier:source.tier||'unknown',publisher,publisher_key:publisher.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g,' ').trim()};
}

function firstPublished(report) { return report.first_published_at||report.original_published_at||report.published_at||null; }
function knownDate(report) { return Boolean(firstPublished(report))&&(report.first_publication_quality||report.date_status)==='known'; }
function enoughSummary(report,news={}) { return report.summary.trim().length>0&&report.summary.trim().length>=(news.min_summary_chars??20); }

function hasKeyword(text,word) {
  const keyword=normalizeText(word);
  if(!keyword)return false;
  const tokenCharacter=/[\p{Script=Latin}\p{N}]/u;
  const boundedStart=tokenCharacter.test(keyword[0]),boundedEnd=tokenCharacter.test(keyword.at(-1));
  // Latin words need boundaries: PC in HPC is unrelated. Chinese terms remain substring matches.
  for(let from=0;from<text.length;){
    const index=text.indexOf(keyword,from);if(index<0)return false;
    const end=index+keyword.length;
    if((!boundedStart||!tokenCharacter.test(text[index-1]||''))&&(!boundedEnd||!tokenCharacter.test(text[end]||'')))return true;
    from=index+1;
  }
  return false;
}

function filterReport(report,{window,now,keywords=[],exclude_keywords=[],news={}}) {
  const text=normalizeText(report.title+' '+report.summary);
  const matches=words=>words.filter(word=>hasKeyword(text,word));
  const matched_keywords=matches(keywords),excluded_keywords=matches(exclude_keywords);
  const result={reason:null,matched_keywords,label:'unknown',decision:'observe',reasons:[]};
  if(excluded_keywords.length)return {...result,reason:'excluded',label:'block',decision:'skip',excluded_keywords};
  const published=firstPublished(report);
  if(published&&knownDate(report)){
    if(Date.parse(published)<Date.parse(window.start_at))return {...result,reason:report.republished?'republished_old':'old',decision:'skip'};
    if(Date.parse(published)>Date.parse(now)||Date.parse(published)>=Date.parse(window.end_at))return {...result,reason:'future',decision:'skip'};
  }else if(Date.parse(report.fetched_at)<Date.parse(window.start_at))return {...result,reason:'stale_undated',decision:'skip'};
  if(!keywords.some(word=>normalizeText(word)))return {...result,reason:'attention_not_configured',decision:'skip'};
  if(!knownDate(report))result.reasons.push('publication_unconfirmed');
  if(!enoughSummary(report,news))result.reasons.push('insufficient_summary');
  if(!matched_keywords.length){
    result.reasons.push('no_keyword_evidence');
    if(!result.reasons.includes('insufficient_summary')&&!result.reasons.includes('publication_unconfirmed'))return {...result,reason:'no_keyword_match',decision:'skip'};
    return result;
  }
  if(result.reasons.length)return result;
  return {...result,label:'pass',decision:'selected',reasons:['keyword_match','publication_known','summary_available']};
}

function hardMatch(a,b) {
  if(a.dedupe_key===b.dedupe_key&&a.source_id===b.source_id&&a.source_url===b.source_url)return 'source_identity';
  if(a.canonical_url&&a.canonical_url===b.canonical_url)return 'canonical_url';
  if(a.content_hash&&a.summary.length>=MIN_COPY_CHARS&&b.summary.length>=MIN_COPY_CHARS&&a.content_hash===b.content_hash)return 'identical_title_and_summary';
  return null;
}

function tierRank(report) { return {primary:0,secondary:1,unknown:2}[report.source_tier]??2; }

function pickRepresentative(reports,news={}) {
  return [...reports].sort((a,b)=>tierRank(a)-tierRank(b)||Number(enoughSummary(b,news))-Number(enoughSummary(a,news))||
    Number(knownDate(b))-Number(knownDate(a))||(firstPublished(a)||'9999').localeCompare(firstPublished(b)||'9999')||a.id.localeCompare(b.id))[0];
}

function titleSimilarity(a,b) {
  const words=text=>{
    const clean=Array.from(normalizeText(text).replace(/\s/g,'')),pairs=new Set();
    for(let i=0;i<clean.length-1;i++)pairs.add(clean[i]+clean[i+1]);return pairs;
  };
  const left=a instanceof Set?a:words(a),right=b instanceof Set?b:words(b);if(left.size<6||right.size<6)return 0;
  const common=[...left].filter(pair=>right.has(pair)).length;
  // This is a broad review hint, so a changed action or a longer title does not hide the shared subject.
  return common/Math.min(left.size,right.size);
}

function clusterReports(reports,news={}) {
  const groups=[],seen=new Set();
  for(const report of [...reports].sort((a,b)=>a.fetched_at.localeCompare(b.fetched_at)||a.id.localeCompare(b.id))){
    if(seen.has(report.id))continue;seen.add(report.id);
    const matches=groups.map(group=>({group,other:group.reports.find(other=>hardMatch(report,other))})).filter(item=>item.other);
    const group=matches[0]?.group||{reports:[],dedupe_links:[]};
    if(!matches.length)groups.push(group);
    for(const item of matches){
      group.dedupe_links.push({a:report.id,b:item.other.id,basis:hardMatch(report,item.other)});
      if(item.group!==group){group.reports.push(...item.group.reports);group.dedupe_links.push(...item.group.dedupe_links);groups.splice(groups.indexOf(item.group),1);}
    }
    group.reports.push(report);
  }
  const claimed=new Set();
  for(const group of groups){
    const prior=[...new Set(group.reports.map(report=>report.event_key).filter(Boolean))];
    const stable=[...group.reports].sort((a,b)=>a.source_id.localeCompare(b.source_id)||a.id.localeCompare(b.id))[0];
    const key=prior.find(value=>!claimed.has(value))||'event:'+hash(stable.canonical_url).slice(0,40);
    group.event_key=claimed.has(key)?'event:'+hash([stable.canonical_url,stable.dedupe_key]).slice(0,40):key;
    claimed.add(group.event_key);group.related_event_keys=prior.filter(value=>value!==group.event_key);
    group.reports=group.reports.map(report=>({...report,event_key:group.event_key}));
    group.representative=pickRepresentative(group.reports,news);group.possible_related=[];
  }
  const titleSets=groups.map(group=>{
    const clean=Array.from(normalizeText(group.representative.title).replace(/\s/g,'')),pairs=new Set();
    for(let i=0;i<clean.length-1;i++)pairs.add(clean[i]+clean[i+1]);return pairs;
  });
  for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++){
    const left=groups[i],right=groups[j];
    if(titleSimilarity(titleSets[i],titleSets[j])<.55)continue;
    const relation=other=>({entity_key:other.event_key,report_id:other.representative.id,title:other.representative.title,url:other.representative.url,basis:'similar_title_only',relation:'possible_related'});
    if(left.possible_related.length<5)left.possible_related.push(relation(right));
    if(right.possible_related.length<5)right.possible_related.push(relation(left));
  }
  return groups;
}

function selectGroups(groups,input,now) {
  const filtered=[],publisherCounts=new Map(),maxPerPublisher=input.news.max_per_publisher??2;
  const ranked=groups.map(group=>{
    const matched_keywords=[...new Set(group.reports.flatMap(report=>filterReport(report,{...input,now}).matched_keywords))];
    const primary=group.representative;
    const sufficient=knownDate(primary)&&enoughSummary(primary,input.news);
    const anyMissing=group.reports.some(report=>!knownDate(report)||!enoughSummary(report,input.news));
    const decision=matched_keywords.length?(sufficient?'selected':'observe'):(anyMissing?'observe':'skip');
    const reasons=matched_keywords.length?['keyword_match']:['no_keyword_evidence'];
    if(!knownDate(primary))reasons.push('publication_unconfirmed');
    if(!enoughSummary(primary,input.news))reasons.push('insufficient_summary');
    if(decision==='skip')reasons.push('no_keyword_match');
    return {...group,selection:{version:CURATION_VERSION,decision,label:decision==='selected'?'pass':'unknown',reasons,matched_keywords,
      representative:{report_id:primary.id,source_tier:primary.source_tier||'unknown',publisher:primary.publisher,rule:'declared_tier_then_material_then_first_publication'},
      material:{summary_chars:primary.summary.length,min_summary_chars:input.news.min_summary_chars??20,first_publication_quality:primary.first_publication_quality||primary.date_status||'missing'},
      ordering_basis:'规则按材料质量、声明来源分级、关注词与新鲜度排序，优先保留各有效来源的代表；不是 AI 分数。',publisher_limit:maxPerPublisher}};
  }).sort((a,b)=>Number(b.selection.decision==='selected')-Number(a.selection.decision==='selected')||
    tierRank(a.representative)-tierRank(b.representative)||
    b.selection.matched_keywords.length-a.selection.matched_keywords.length||
    (firstPublished(b.representative)||'').localeCompare(firstPublished(a.representative)||'')||a.event_key.localeCompare(b.event_key));
  const representatives=[],remaining=[],coveredSources=new Set();
  for(const group of ranked){
    const source=group.representative.source_id;
    if(group.selection.decision==='selected'&&!coveredSources.has(source)){representatives.push(group);coveredSources.add(source);}
    else remaining.push(group);
  }
  const selected=[];
  for(const group of [...representatives,...remaining]){
    if(group.selection.decision==='skip'){filtered.push({reason:'no_keyword_match',group});continue;}
    const publisher=group.representative.publisher_key||group.representative.source_id;
    if((publisherCounts.get(publisher)||0)>=maxPerPublisher){filtered.push({reason:'publisher_limit',group});continue;}
    if(selected.length>=input.news.max_items){filtered.push({reason:'item_limit',group});continue;}
    publisherCounts.set(publisher,(publisherCounts.get(publisher)||0)+1);
    group.selection.publisher_slot=publisherCounts.get(publisher);selected.push(group);
  }
  return {selected,filtered};
}

module.exports={CURATION_VERSION,sourceMetadata,firstPublished,knownDate,filterReport,hardMatch,clusterReports,selectGroups};
