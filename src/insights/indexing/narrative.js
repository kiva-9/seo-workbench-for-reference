const MODEL_INPUT_VERSION='indexing-facts-v1';
const states={indexed:'已收录',not_indexed:'未收录',unknown:'未知'};
const reasons={url_changed:'登记地址改变',article_revision_changed:'文章输入版本改变',property_changed:'Search Console property 改变',google_canonical_changed:'Google canonical 改变',user_canonical_changed:'用户 canonical 改变'};

function buildIndexingNarrative(card){
  const facts=[card.category==='check_failed'?'本次检查失败，保留最后有效状态。':card.summary];
  if(card.status==='succeeded'&&card.current_state!=='unknown')facts.push(`本次官方检查成功，Google 判定支持${states[card.current_state]}。`);
  else if(card.status==='succeeded')facts.push('本次官方响应不足以确定收录状态。');
  else facts.push('本次检查执行失败，不能把失败当作未收录或掉收录。');
  if(card.latest_valid)facts.push(`最近一次有效官方结果支持${states[card.latest_valid.state]||'未知'}。`);
  if(card.category==='needs_review'){
    facts.push('需要人工复核的是工作台保存的比较口径；这不是 Google 的流程状态。');
    facts.push('口径改变原因：'+card.comparison.review_reasons.map(reason=>reasons[reason]||'比较身份改变').join('、')+'。');
  }
  facts.push('只能解释已保存的官方判定与比较事实，不推断平台流程、精确变化时间或原因。');
  return {version:MODEL_INPUT_VERSION,evidence:[{id:card.comparison.current_id,kind:'indexing_facts',facts}],source_evidence_ids:card.evidence.map(e=>e.id)};
}
module.exports={MODEL_INPUT_VERSION,buildIndexingNarrative};
