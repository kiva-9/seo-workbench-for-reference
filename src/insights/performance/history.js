const {shiftMonth,monthBounds,isValidDay}=require('../../lib/business-dates');
const {buildArticleFingerprints}=require('../../lib/article-fingerprint');
const {parseKeyEventNames}=require('../../google/project-config');
const {monthlySource,change,rounded,meets}=require('./quality');

function aggregate(profiles,source){
  if(!profiles.length||profiles.some(p=>!p.comparable))return null;
  const sum=key=>profiles.every(p=>p.values[key]!==null)?profiles.reduce((n,p)=>n+p.values[key],0):null;
  const days=profiles.reduce((n,p)=>n+Number(monthBounds(p.month).end.slice(-2)),0);
  if(source==='gsc'){
    const clicks=sum('clicks'),impressions=sum('impressions');
    const observed=profiles.filter(p=>p.values.impressions>0);
    const position=impressions>0&&observed.every(p=>p.values.position!==null)?rounded(observed.reduce((n,p)=>n+p.values.position*p.values.impressions,0)/impressions):null;
    return {clicks,impressions,ctr:impressions>0&&clicks!==null?rounded(clicks/impressions):null,position,days,clicks_per_day:clicks===null?null:rounded(clicks/days)};
  }
  return {pageviews:sum('pageviews'),key_events:sum('key_events'),days};
}
function comparison(baseline,current){
  if(!baseline||!current)return {comparable:false,baseline:baseline||null,current:current||null,changes:null};
  return {comparable:true,baseline,current,changes:Object.fromEntries(Object.keys(current).filter(k=>k!=='days').map(k=>[k,change(baseline[k],current[k])]))};
}
function direction(delta,rank=false){
  if(!delta)return '未知';
  return delta.absolute===0?'持平':delta.absolute>0?(rank?'向后':'增加'):(rank?'向前':'减少');
}

function attachHistory(card,{article,monthly,input,settings}){
  const count=settings.performance?.history_months||12,end=input.window.comparison;
  const months=Array.from({length:count},(_,i)=>shiftMonth(end,i-count+1));
  const fingerprints=buildArticleFingerprints(input.source_config||{}),identity=card.evidence[0];
  const eventsConfigured=parseKeyEventNames(input.source_config?.key_event_names).length>0;
  const profile=(month,source)=>{
    const p=monthlySource(monthly.find(row=>row.month===month),source,{month,article,fingerprint:fingerprints[source],asOfDay:input.as_of_day,staleDays:settings.rules.stale_days});
    if(source==='ga4'&&!eventsConfigured){p.values.key_events=null;p.issues.push('key_events_unconfigured');}
    if(!isValidDay(article.published_at)||article.published_at>monthBounds(month).start){p.comparable=false;p.issues.push('incomplete_article_lifetime');}
    if(source==='gsc'&&identity.gsc_mapping.some(m=>m.error)){p.comparable=false;p.issues.push('url_unresolved');}
    if(source==='ga4'&&identity.ga4_mapping.ambiguous.length){p.comparable=false;p.issues.push('ambiguous_path');}
    return p;
  };
  const timeline=months.map(month=>({month,gsc:profile(month,'gsc'),ga4:profile(month,'ga4')}));
  const recent=Array.from({length:3},(_,i)=>shiftMonth(end,i-2)),previous=Array.from({length:3},(_,i)=>shiftMonth(end,i-5));
  const yearMonth=shiftMonth(end,-12),quarter={},year_over_year={},series={};
  for(const source of ['gsc','ga4']){
    quarter[source]={...comparison(aggregate(previous.map(m=>profile(m,source)),source),aggregate(recent.map(m=>profile(m,source)),source)),baseline_months:previous,current_months:recent};
    year_over_year[source]={...comparison(aggregate([profile(yearMonth,source)],source),aggregate([profile(end,source)],source)),baseline_month:yearMonth,current_month:end};
    const key=source==='gsc'?'clicks':'pageviews';
    const steps=timeline.slice(1).map((entry,i)=>({from:timeline[i].month,to:entry.month,change:timeline[i][source].comparable&&entry[source].comparable?change(timeline[i][source].values[key],entry[source].values[key]):null}));
    let decline=0,growth=0;
    for(const step of [...steps].reverse()){if(step.change?.absolute<0)decline++;else break;}
    for(const step of [...steps].reverse()){if(step.change?.absolute>0)growth++;else break;}
    const first=timeline[timeline.length-1-Math.max(decline,growth)]?.[source];
    series[source]={comparable_months:timeline.filter(e=>e[source].comparable).length,missing_months:timeline.filter(e=>!e[source].present).map(e=>e.month),unusable_months:timeline.filter(e=>!e[source].comparable).map(e=>e.month),steps,consecutive_declines:decline,consecutive_growth:growth,
      continuous_change:first?.comparable?change(first.values[key],timeline.at(-1)[source].values[key]):null};
  }
  const history={id:`article:${article.id}:history`,kind:'performance_history',start:months[0],end,requested_months:count,timeline,series,quarter,year_over_year,
    limitations:['缺月或不可比月份打断连续趋势，不跨缺口推断。','季度按完整自然月累计并另比较日均点击；CTR 按总点击除总展示计算，排名按展示加权。','同期对比只是观察证据，不能单凭同比确认季节性或变化原因。','历史同步时间和 URL 修订逐月保留，旧成功值不能替代当前口径。']};
  // The recent pair remains visible; longer, complete evidence can also nominate a sustained change.
  const ready=card.evidence.find(e=>e.kind==='deterministic_comparison').eligible_for_classification;
  const q=quarter.gsc,c=series.gsc.continuous_change;
  const candidates=[];
  if(ready&&settings.rules.click_enabled){
    if(q.comparable&&q.baseline.clicks/3>=settings.rules.min_baseline_clicks&&meets(Math.abs(q.current.clicks/3-q.baseline.clicks/3),settings.rules.min_click_change)&&q.changes.clicks_per_day?.ratio!==null&&meets(Math.abs(q.changes.clicks_per_day?.ratio||0),settings.rules.click_change_ratio))candidates.push(q.changes.clicks_per_day.absolute<0?'quarter_decline':'quarter_growth');
    if(Math.max(series.gsc.consecutive_declines,series.gsc.consecutive_growth)>=2&&c?.baseline>=settings.rules.min_baseline_clicks&&meets(Math.abs(c.absolute),settings.rules.min_click_change)&&c.ratio!==null&&meets(Math.abs(c.ratio),settings.rules.click_change_ratio))candidates.push(c.absolute<0?'sustained_decline':'sustained_growth');
  }
  history.signals=candidates;
  if(card.category==='observe'&&candidates.length){
    const down=candidates.some(s=>s.endsWith('decline'));card.category=down?'optimize':'review';card.priority=down?88:68;
    card.signals.push(...candidates);card.reasons=card.reasons.filter(r=>!['low_sample','below_candidate_thresholds','zero_baseline'].includes(r)).concat(candidates);
    card.summary=down?'可比完整历史显示持续或季度点击下降，进入优先优化候选；原因尚未确认。':'可比完整历史显示持续或季度点击增长，进入复盘候选；经验是否可复用仍需核查。';
    card.recommended_checks=['结合连续完整月与季度变化核查查询构成、内容改动和推广记录，确认变化是否持续。'];
    card.suggested_actions=[down?'先复核长期变化的来源，再决定文章优化动作。':'人工复盘长期增长对应的内容与推广记录。'];
    for(const e of card.evidence.filter(e=>['deterministic_comparison','deterministic_decision'].includes(e.kind))){e.category=card.category;e.reasons=card.reasons;if(e.kind==='deterministic_decision'){e.summary=card.summary;e.recommended_checks=card.recommended_checks;e.suggested_actions=card.suggested_actions;}}
  }
  card.history=history;card.evidence.push(history);return card;
}

function attachPeers(cards){
  const eligible=cards.filter(c=>c.maturity.mature&&c.sources.gsc.current.comparable&&c.sources.gsc.current.fresh);
  const values=eligible.map(c=>c.sources.gsc.current.values.clicks).sort((a,b)=>a-b),n=values.length;
  const median=n?(n%2?values[(n-1)/2]:(values[n/2-1]+values[n/2])/2):null;
  for(const card of cards){
    const included=eligible.includes(card),value=card.sources.gsc.current.values.clicks;
    card.peer_context={id:`article:${card.entity_key}:peers`,kind:'project_peer_context',scope:'本次分析中同项目、成熟且最新完整月可比的文章',sample_size:n,included,median_clicks:median,
      click_rank:included?1+values.filter(v=>v>value).length:null,relative_to_median:included&&n>=3?(value>median?'above':value<median?'below':'equal'):'unknown',limitations:['项目内相对位置不等于内容质量或优化原因。','单次文章上限可能限制参考范围，不与其他项目混合排名。']};
    card.evidence.push(card.peer_context);
  }
}
function historyFacts(card){
  if(!card.history)return [];
  const facts=[];
  if(card.history.timeline.some(entry=>entry.gsc.issues.includes('incomplete_article_lifetime'))){
    facts.push(card.maturity.age_days!==null?'历史窗口部分月份在文章上线前或上线当月，未完整覆盖文章存续期；不能靠补抓消除这项可比性限制。':'文章发布日期尚不能确认，历史月度总量缺少可验证的存续期覆盖；应先核对登记发布日期。');
  }
  for(const [source,title]of [['gsc','搜索点击'],['ga4','页面浏览']]){
    const series=card.history.series[source];
    facts.push(`按历史时间顺序，${title}相邻月变化为：${series.steps.map(s=>direction(s.change)).join('、')}。`);
    if(series.consecutive_declines>=2)facts.push(`${title}在最近连续可比完整月持续减少。`);
    else if(series.consecutive_growth>=2)facts.push(`${title}在最近连续可比完整月持续增加。`);
    if(series.unusable_months.length)facts.push(`${title}历史窗口有缺失或不可比月份，不能补为零或跨缺口推断。`);
    const q=card.history.quarter[source],y=card.history.year_over_year[source],key=source==='gsc'?'clicks_per_day':'pageviews';
    facts.push(q.comparable?`近期完整季度与前一完整季度相比，${title}${source==='gsc'?'日均值':''}${direction(q.changes[key])}。`:`${title}尚无完整可比的前后季度基线。`);
    facts.push(y.comparable?`与上年同期完整月相比，${title}${direction(y.changes[source==='gsc'?'clicks':'pageviews'])}；这不能单独证明季节性。`:`${title}尚无完整可比的上年同期基线。`);
  }
  if(card.peer_context?.relative_to_median!=='unknown')facts.push(`当前完整月搜索点击在本次同项目可比文章中${{above:'高于',below:'低于',equal:'等于'}[card.peer_context.relative_to_median]}中位水平，不能据此判定内容质量。`);
  return facts;
}
module.exports={attachHistory,attachPeers,historyFacts,aggregate};
