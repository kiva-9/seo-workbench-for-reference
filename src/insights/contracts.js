const {createHash}=require('node:crypto');
const {z}=require('zod');
const MODULES=['performance','news','indexing'];
const VERSION='ai-insights-v1';
const short=z.string().max(1000);
const configSchema=z.object({
  background:z.object({industry:short.default(''),products:short.default(''),markets:short.default(''),promotion:short.default(''),language:z.string().max(80).default('zh-CN')}).strict().prefault({}),
  keywords:z.array(z.string().min(1).max(80)).max(30).default([]),
  exclude_keywords:z.array(z.string().min(1).max(80)).max(30).default([]),
  sources:z.array(z.object({id:z.string().min(1).max(80),url:z.url().max(2000),name:z.string().max(160),approved:z.boolean(),tier:z.enum(['primary','secondary','unknown']).default('unknown'),publisher:z.string().max(160).default(''),kind:z.enum(['feed','search']).default('feed'),query:z.string().max(300).default('')}).strict()).max(20).default([]),
  performance:z.object({history_months:z.number().int().min(3).max(24).default(12)}).strict().prefault({}),
  rules:z.object({mature_days:z.number().int().min(1).max(730).default(60),min_baseline_clicks:z.number().min(0).default(30),min_click_change:z.number().min(0).default(10),click_change_ratio:z.number().min(0).max(10).default(.3),position_min:z.number().min(1).max(100).default(3),position_max:z.number().min(1).max(100).default(20),min_impressions:z.number().min(0).default(500),ctr_drop_points:z.number().min(0).max(100).default(1),click_enabled:z.boolean().default(true),ctr_enabled:z.boolean().default(true),stale_days:z.number().int().min(1).max(365).default(45)}).strict().prefault({}),
  news:z.object({max_age_days:z.number().int().min(1).max(90).default(7),max_items:z.number().int().min(1).max(20).default(5),min_summary_chars:z.number().int().min(0).max(500).default(20),max_per_publisher:z.number().int().min(1).max(20).default(2)}).strict().prefault({}),
  indexing:z.object({max_urls:z.number().int().min(1).max(100).default(20),project_daily:z.number().int().min(0).max(2000).default(100),property_daily:z.number().int().min(0).max(2000).default(100),property_minute:z.number().int().min(1).max(600).default(20),confirm_hours:z.number().min(1).max(168).default(24),stale_days:z.number().int().min(1).max(90).default(7)}).strict().prefault({}),
  model:z.object({enabled:z.boolean().default(false),data_approved:z.boolean().default(false),budget_mode:z.enum(['cost','calls','unlimited']).default('cost'),daily_calls:z.number().int().min(0).max(10000).default(0),daily_cost:z.number().min(0).max(100).default(0),call_cost_limit:z.number().min(0).max(10).default(0),max_tokens:z.number().int().min(128).max(16000).default(1000)}).strict().prefault({}),
  max_articles:z.number().int().min(1).max(100).default(30),
  schedule:z.object({enabled:z.boolean().default(false),hour:z.number().int().min(0).max(23).default(9),modules:z.array(z.enum(MODULES)).max(3).default(MODULES)}).strict().prefault({}),
}).strict();
function parseSettings(input={}) { const out=configSchema.safeParse(input);if(!out.success)fail('VALIDATION_ERROR','见解配置格式无效',400);if(out.data.rules.position_min>out.data.rules.position_max)fail('VALIDATION_ERROR','排名区间无效',400);return out.data; }
function fail(code,message=code,status=409){throw Object.assign(new Error(message),{code,status});}
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));return value;}
function hash(value){return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');}
function businessDay(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));}
function safeUrl(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}}
const explanationSchema=z.object({summary:z.string().max(1200),evidenceIds:z.array(z.string().max(160)).min(1).max(30),hypotheses:z.array(short).max(5),recommendedChecks:z.array(short).max(5),suggestedActions:z.array(short).max(5),limitations:z.array(short).max(8)}).strict();
class ExplanationFactError extends Error{
  constructor(field,reason){super('模型包含未经证据支持的事实');this.code='MODEL_FACT';this.status=409;this.diagnostic={field,reason};}
}
// Only locally generated, fixed-field diagnostics can leave validation; never echo rejected prose.
function explanationDiagnostic(error){return error instanceof ExplanationFactError?error.diagnostic:undefined;}
function indexingReviewDiagnostic(output){
  // The API has no review workflow state; use human verification language instead of inventing one.
  const rules=[
    ['unsupported_review_state',/审核|审批|审查|\b(?:pending\s+review|under\s+review|awaiting\s+approval|review\s+(?:state|status|process)|(?:passed|approved).{0,30}(?:review|approval))\b/i],
    ['unsupported_submission',/已(?:成功)?提交|成功提交|\b(?:successfully\s+submitted|has\s+been\s+submitted)\b/i],
    ['unsupported_all_checks',/(?:所有|全部).{0,12}(?:检查项|检测项|指标).{0,8}(?:达标|通过)|\ball\s+(?:checks|requirements).{0,20}(?:passed|satisfied)\b/i],
  ];
  for(const field of ['summary','hypotheses','recommendedChecks','suggestedActions','limitations']){
    const value=output?.[field],text=typeof value==='string'?value:Array.isArray(value)?value.join(' '):'';
    for(const [reason,pattern]of rules)if(pattern.test(text))return {field,reason};
  }
  return null;
}
function validateExplanation(output,evidence,{module}={}){
  const parsed=explanationSchema.safeParse(output);if(!parsed.success)fail('MODEL_INVALID','模型输出结构无效');
  const review=module==='indexing'&&indexingReviewDiagnostic(parsed.data);if(review)throw new ExplanationFactError(review.field,review.reason);
  const ids=new Set(evidence.map(e=>e.id));if(parsed.data.evidenceIds.some(id=>!ids.has(id)))fail('MODEL_EVIDENCE','模型引用不在输入证据中');
  const sourceNumbers=new Set(),sourceUrls=new Set();
  const withoutUrls=(text,visit)=>text.replace(/https?:\/\/[^\s"<>]+/g,url=>{visit?.(url);return '';});
  function collectUrls(value){
    if(typeof value==='string')withoutUrls(value,url=>sourceUrls.add(url));
    else if(Array.isArray(value))value.forEach(collectUrls);
    else if(value&&typeof value==='object')Object.values(value).forEach(collectUrls);
  }
  collectUrls(evidence);
  // ISO date separators are not negative signs; presentation can omit zero padding.
  const normalizeNumber=token=>token.replace(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/,(_,sign,integer,fraction='',exponent='0')=>{
    // Expand finite-number exponents as text, avoiding rounding large integers.
    const shift=Number(exponent);if(Math.abs(shift)>400)return token.toLowerCase().replace('e+','e');
    const digits=integer+fraction,point=integer.length+shift;
    if(point<=0){integer='0';fraction='0'.repeat(-point)+digits;}
    else if(point>=digits.length){integer=digits+'0'.repeat(point-digits.length);fraction='';}
    else{integer=digits.slice(0,point);fraction=digits.slice(point);}
    integer=integer.replace(/^0+(?=\d)/,'');fraction=fraction.replace(/0+$/,'');
    return (integer==='0'&&!fraction?'':sign)+integer+(fraction?'.'+fraction:'');
  });
  const numbersInText=text=>(text.replace(/\u2212/g,'-').replace(/\b(\d{4})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?(?![\d-])/g,(_,year,month,day)=>[year,month,day].filter(Boolean).join(' ')).match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)||[]).map(normalizeNumber);
  const comparisons=evidence.filter(item=>item.kind==='deterministic_comparison');
  const metricNames={
    '展示量':['GSC','gsc_impressions'],'展示次数':['GSC','gsc_impressions'],'展示':['GSC','gsc_impressions'],
    '点击量':['GSC','gsc_clicks'],'点击次数':['GSC','gsc_clicks'],'点击':['GSC','gsc_clicks'],
    'CTR':['GSC','gsc_ctr'],'点击率':['GSC','gsc_ctr'],
    '浏览量':['GA4','ga4_pageviews'],'浏览次数':['GA4','ga4_pageviews'],'页面浏览量':['GA4','ga4_pageviews'],
    '关键事件次数':['GA4','ga4_key_events'],'关键事件':['GA4','ga4_key_events'],
  };
  const decrease=new RegExp(`(?:^|[，。；,;！!？?、（("])\\s*(?:(GSC|GA4)\\s*(?:的)?\\s*)?(${Object.keys(metricNames).join('|')})\\s*(?:下降|减少|降低|下滑|回落|降幅)(?:了)?(?:约)?\\s*(\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\s*(个百分点|%|％|次)?(?=\\s*(?:$|[，。；,;！!？?、）)"\\]\\}]))`,'gi');
  function boundPresentation(text,field){
    // Only a saved comparison period can justify a month range, never unrelated metric digits.
    text=text.replace(/(?<![\d.-])(?:(\d{4})\s*年\s*)?(0?[1-9]|1[0-2])\s*[-–—]\s*(0?[1-9]|1[0-2])\s*月/g,(_,year,start,end)=>{
      const supported=comparisons.some(item=>{
        const baseline=/^(\d{4})-(0[1-9]|1[0-2])$/.exec(item.period?.baseline||''),current=/^(\d{4})-(0[1-9]|1[0-2])$/.exec(item.period?.comparison||'');
        return baseline&&current&&baseline[1]===current[1]&&(!year||year===baseline[1])&&Number(start)===Number(baseline[2])&&Number(end)===Number(current[2]);
      });
      if(!supported)throw new ExplanationFactError(field,'unsupported_number');
      return ' ';
    });
    // Match the named metric and unit against its own signed delta; never add absolute values to the global set.
    return text.replace(decrease,(_,source,name,magnitude,unit='')=>{
      const [expectedSource,key]=metricNames[name.toUpperCase()]||metricNames[name];
      const valueKey=unit==='个百分点'?(key==='gsc_ctr'?'points':null):['%','％'].includes(unit)?(key!=='gsc_ctr'?'percentage':null):(key!=='gsc_ctr'?'absolute':null);
      const wanted=normalizeNumber('-'+magnitude);
      const supported=(!source||source.toUpperCase()===expectedSource)&&valueKey&&comparisons.some(item=>{
        const value=item.changes?.[key]?.[valueKey];
        return typeof value==='number'&&Number.isFinite(value)&&value<0&&(normalizeNumber(String(value))===wanted||(Number(value.toFixed(2))!==0&&normalizeNumber(String(Number(value.toFixed(2))))===wanted));
      });
      if(!supported)throw new ExplanationFactError(field,'unsupported_number');
      return ' ';
    });
  }
  function collect(value,key=''){
    if(/(^id$|_id$|Ids$|guid|url|hash|fingerprint|revision|version|configuration_key|kind|^article_title$|^registered_keyword$)/i.test(key))return;
    if(typeof value==='number'&&Number.isFinite(value)){
      sourceNumbers.add(normalizeNumber(String(value)));
      // Match the UI's two-decimal presentation without accepting new calculations.
      const rounded=Number(value.toFixed(2));
      if(rounded!==0||value===0)sourceNumbers.add(normalizeNumber(String(rounded)));
    }
    else if(typeof value==='string')for(const n of numbersInText(withoutUrls(value)))sourceNumbers.add(n);
    else if(Array.isArray(value))value.forEach(v=>collect(v,key));
    else if(value&&typeof value==='object')for(const [k,v]of Object.entries(value))collect(v,k);
  }
  collect(evidence);
  for(const [field,value]of Object.entries(parsed.data)){
    if(field==='evidenceIds')continue;
    // Validate links separately; their paths are not numeric metric claims.
    const prose=withoutUrls(JSON.stringify(value),url=>{if(!sourceUrls.has(url))throw new ExplanationFactError(field,'unsupported_link');});
    for(const n of numbersInText(boundPresentation(prose,field)))if(!sourceNumbers.has(n))throw new ExplanationFactError(field,sourceNumbers.has(n.startsWith('-')?n.slice(1):'-'+n)?'opposite_sign':'unsupported_number');
  }
  return parsed.data;
}
module.exports={MODULES,VERSION,parseSettings,fail,hash,businessDay,safeUrl,validateExplanation,explanationDiagnostic,indexingReviewDiagnostic};
