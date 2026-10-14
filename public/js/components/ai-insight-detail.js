import {performanceEvidence,newsEvidence} from './ai-insight-evidence.js';
import {performanceHistoryEvidence} from './ai-performance-history.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl=value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}};
const list=items=>`<ul>${items.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`;
const block=(title,items,classes='')=>items?.length?`<section class="ai-reading-block ${classes}"><h4>${title}</h4>${list(items)}</section>`:'';
const link=(url,text,classes='')=>safeUrl(url)?`<a class="${classes}" href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${text} ↗</a>`:'';
const json=value=>esc(JSON.stringify(value,null,2));
const names={performance:'文章表现与优化',news:'行业资讯',indexing:'Google 收录变化'};

export function feedbackHistory(records,label,time){
  if(!records?.length)return '<p class="muted">尚未添加处理记录。</p>';
  return `<details class="ai-feedback-history"><summary>处理记录与备注</summary><ol>${records.map(record=>`<li><div><strong>${esc(label(record.action))}</strong><span>${esc(record.actor_name||'操作者未记录')} · ${esc(time(record.created_at))}</span></div>${record.note?`<p>${esc(record.note)}</p>`:''}</li>`).join('')}</ol><p class="muted">显示最近 ${records.length} 条记录。</p></details>`;
}

export function renderInsightDetail({card,back,summary,label,time}){
  const d=card.data,explanation=d.model?.explanation,evidence=d.evidence||[];
  const checks=explanation?.recommendedChecks?.length?explanation.recommendedChecks:d.recommended_checks||[];
  const actions=explanation?.suggestedActions||[];
  const limitations=[...new Set([...(explanation?.limitations||[]),...(d.limitations||[])])];
  const narrative=evidence.find(e=>e.kind==='performance_narrative');
  const records=card.feedback_history||[],latestNote=records[0]?.note||'';
  const takeaway=card.module==='indexing'?summary:explanation?.summary||summary;
  const supportingText=card.module==='indexing'?explanation?.summary:summary;
  const modelNotice=d.model?.status==='cached'?'复用当天的官方检查，本次未重新生成 AI 解读。':d.model?.status==='disabled'?'当前未启用 AI 解读，以下依据保存的事实与规则判断。':'AI 解读暂未完成，当前依据保存的事实与规则判断。';
  const snapshots=card.module==='indexing'?`<section class="card ai-detail-proof"><div class="ai-section-heading"><div><span class="ai-eyebrow">证据</span><h3>检查快照对照</h3></div></div><div class="ai-comparisons">${evidence.filter(e=>e.checked_at).map(e=>`<div><span class="ai-eyebrow">${esc(time(e.checked_at))}</span><h4>${esc(label(e.state))}</h4><p>执行：${esc(label(e.execution_status))}<br>Google 判定：${esc(e.official?.verdict||'未知')}<br>canonical：${esc(e.official?.googleCanonical||'未返回')}</p></div>`).join('')}</div>${link(d.inspection_link,'Google 官方检查入口')}</section>`:'';
  const stale=card.latest_run_id&&card.latest_run_id!==card.run_id;
  const validCheck=d.latest_valid?.checked_at||(card.category!=='check_failed'?d.checked_at:null);
  const checkLabel=d.latest_valid?.checked_at?'上次有效检查':'本次检查';
  const notice=card.identity_changed?'文章地址或检查口径已变化。以下是历史结果，需要按当前地址重新核查。':stale?'本轮尚无有效结论，当前保留上次结果。':'';
  return `<article class="ai-page ai-detail">
    <a class="ai-back" href="${esc(back)}">← 返回见解列表</a>
    <header class="ai-detail-header"><span class="ai-eyebrow">${esc(card.project_name)} · ${names[card.module]}</span><h2>${esc(card.title)}</h2><div class="ai-detail-meta"><span class="ai-category" data-category="${esc(card.category)}">${esc(label(card.category))}</span>${d.provenance==='synthetic'?'<span class="ai-demo-badge">合成演示</span>':''}<span>${card.module==='performance'?`相邻完整月 ${esc(d.period?.baseline||'未知')} → ${esc(d.period?.comparison||'未知')}`:card.module==='news'?`发布 ${d.published_at?esc(time(d.published_at)):'日期待核查'}`:validCheck?`${checkLabel} ${esc(time(validCheck))}`:'暂无有效检查'}</span></div></header>
    ${notice?`<p class="ai-detail-alert" role="note">${esc(notice)}</p>`:''}
    <div class="ai-detail-layout">
      <div class="ai-detail-content" role="region" aria-label="见解内容" data-detail-zone="content">
        <section class="card ai-content-hero"><span class="ai-zone-label">内容 · ${card.module==='news'?'项目解读':'核心结论'}</span><h3>${esc(label(card.category))}</h3><p class="ai-takeaway">${esc(takeaway)}</p>${explanation&&supportingText!==takeaway?`<div class="ai-saved-fact"><span>${card.module==='indexing'?'AI 补充解读':card.module==='news'?'报道摘要':'保存的事实'}</span><p>${esc(supportingText)}</p></div>`:''}${!explanation?`<p class="ai-model-notice">${modelNotice}</p>`:`<p class="ai-model-notice">使用模型 ${esc(d.model.model||"已配置模型")}${d.model.fallback_used?" · 已使用备用模型":""}</p>`}</section>
        ${checks.length||actions.length?`<section class="card ai-next-steps"><span class="ai-zone-label">建议 · 下一步</span><h3>接下来可以做什么</h3>${block('优先核查',checks,'ai-check-list')}${block('可考虑的动作',actions,'ai-action-list')}</section>`:''}
        ${card.module==='news'?`<section class="card ai-detail-proof"><span class="ai-zone-label">内容 · 项目关联</span><h3>与项目的关系</h3><p>${esc(d.relevance?.explanation||'现有材料不足以确认相关性，待核查。')}</p>${block('选题线索',d.topic_angles||[])}</section>`:''}
        ${block('可能原因 · 待核查',explanation?.hypotheses,'card ai-hypotheses')}
        ${card.module==='performance'?performanceHistoryEvidence(d)+performanceEvidence(d):''}${snapshots}
        ${card.module==='news'?newsEvidence(d):''}
      </div>
      <aside class="ai-detail-sidebar">
        <section class="card ai-detail-actions" aria-label="见解操作" data-detail-zone="actions"><span class="ai-zone-label">操作</span><h3>查看与处理</h3><div class="ai-source-actions">${link(card.url,card.module==='news'?'阅读报道原文':'打开文章','btn')}${card.module==='indexing'?`<button type="button" class="btn btn-primary" data-inspect="${esc(card.entity_key)}">检查此 URL</button>`:''}</div><p data-inspect-status role="status"></p><h4>人工处理状态</h4><div class="ai-feedback" role="group" aria-label="人工处理">${['unread','useful','ignored','handled'].map(action=>`<button type="button" class="btn" data-action="${action}" aria-pressed="${card.feedback===action}">${esc(label(action))}</button>`).join('')}</div><p data-feedback-status role="status">当前：${esc(label(card.feedback))}</p><label class="ai-note-field">处理备注（可选）<textarea data-feedback-note aria-label="处理备注（可选）" maxlength="1000" placeholder="记录判断依据或后续安排">${esc(latestNote)}</textarea></label><button type="button" class="btn" data-save-note>保存备注</button><div data-feedback-history>${feedbackHistory(records,label,time)}</div></section>
        ${limitations.length?`<section class="ai-detail-notes" aria-label="备注与说明" data-detail-zone="notes"><span class="ai-zone-label">说明</span><h3>使用这条见解时</h3>${list(limitations)}</section>`:''}
      </aside>
    </div>
    <details class="ai-detail-technical" data-detail-zone="technical"><summary>技术记录与完整证据 <span>生成信息、口径与原始 JSON</span></summary><p>生成 ${esc(time(card.generated_at))}。以下记录用于追溯本次结果。</p>${narrative?`<details class="ai-evidence"><summary>AI 解读依据</summary><p>定性事实可追溯到保存的指标；数值和月份见上方对照。</p>${list(narrative.facts||[])}</details>`:''}${evidence.map(e=>`<details class="ai-evidence"><summary>${esc(e.id)}${e.source?' · '+esc(e.source):''}</summary><pre>${json(e)}</pre></details>`).join('')}<details class="ai-evidence"><summary>完整判断与技术口径</summary><pre>${json(d)}</pre></details></details>
  </article>`;
}
