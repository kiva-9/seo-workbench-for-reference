const { fail, hash } = require('../contracts');
const {historyFacts}=require('./history');

const MODEL_INPUT_VERSION = 'performance-narrative-v4';
const CATEGORY_FACTS = {
  review: '规则已形成复盘候选，仍需人工核查内容经验是否可复用。',
  optimize: '规则已形成优化候选，变化原因尚未确认。',
  observe: '规则结果为继续观察，现有证据未形成强候选结论。',
  unknown: '规则结果为无法判断，关键证据或比较口径需要核查。',
};
const METRICS = [
  ['gsc', 'gsc_clicks', '搜索点击'], ['gsc', 'gsc_impressions', '搜索展示量'],
  ['gsc', 'gsc_ctr', '搜索点击率'], ['gsc', 'gsc_position', '平均搜索排名'],
  ['ga4', 'ga4_pageviews', '页面浏览'], ['ga4', 'ga4_key_events', '关键事件'],
];

function topic(value,maxLength){
  // Version numbers identify the article topic; they are not performance measurements.
  return String(value||'').normalize('NFKC').replace(/https?:\/\/\S+/g,'').slice(0,maxLength).replace(/\d+(?:\.\d+)?/g,'[编号]');
}

function metricFact(label, change, rank = false) {
  if (!change) return `${label}缺少可比完整月值，变化未知，不能当作零。`;
  if (change.baseline === 0 && change.current === 0) return `${label}相邻完整月均为零，不能计算增长比例。`;
  if (change.baseline === 0) return `${label}基期为零，比较期已出现数据，不能计算增长比例。`;
  if (change.current === 0) return `${label}比较期降至零。`;
  if (change.current > change.baseline) return rank ? `${label}向后变化。` : `${label}有所增加。`;
  if (change.current < change.baseline) return rank ? `${label}向前变化。` : `${label}有所减少。`;
  return `${label}未发生变化。`;
}

function buildNarrative(card) {
  const comparison = card.evidence.find(item => item.kind === 'deterministic_comparison');
  if (!comparison || !CATEGORY_FACTS[card.category]) fail('INVALID_CARD', '文章规则证据不完整');
  const facts = [CATEGORY_FACTS[card.category]];
  facts.push(comparison.comparable.gsc ? '搜索来源具备可比的完整月记录。' : '搜索来源尚不具备可比完整月记录，未判断变化方向。');
  facts.push(comparison.comparable.ga4 ? '页面行为来源具备可比的完整月记录。' : '页面行为来源尚不具备可比完整月记录，未判断变化方向。');
  for (const [source, key, label] of METRICS) {
    facts.push(metricFact(label, comparison.comparable[source] ? comparison.changes[key] : null, key === 'gsc_position'));
  }
  if (card.maturity.age_days === null) facts.push('文章成熟度无法确认。');
  else facts.push(card.maturity.mature ? '文章已满足项目设置的成熟观察条件。' : '文章尚未满足项目设置的成熟观察条件。');
  if (card.reasons.includes('low_sample')) facts.push('搜索点击样本较少，不能据此判定表现差。');
  if (card.reasons.includes('zero_baseline')) facts.push('搜索点击基期为零，需要继续积累样本，不能强判表现。');
  if (card.reasons.includes('rules_disabled')) facts.push('项目自动候选规则已关闭，当前保留事实观察。');
  if (card.reasons.includes('below_candidate_thresholds')) facts.push('当前变化没有满足项目暂定的候选条件。');
  facts.push(...historyFacts(card));

  const limitations = [
    '平均搜索排名反映展示加权结果，不能替代具体关键词的排名证据。',
    '缺少查询构成、搜索结果页和页面改动证据，变化原因仅能通过后续核查确认。',
    '文章证据没有页面语种或查询词明细，不能据此推断网站定位。',
    '当前月观察不参与完整月变化或候选判断。',
    '候选规则为项目暂定规则，仍需结合历史样本校准。',
  ];
  if (card.category === 'observe') limitations.push('继续观察不等于表现差，不据此直接建议改站或改语种。');
  if (card.category === 'unknown') limitations.push('当前无法判断不等于表现差。');
  if (!comparison.comparable.gsc) limitations.push('搜索指标不可比较，不能用未完成覆盖或旧成功值补齐当前事实。');
  if (!comparison.comparable.ga4) limitations.push('页面行为指标不可比较，不能用未完成覆盖或旧成功值补齐当前事实。');
  if (comparison.comparable.gsc && (!card.sources.gsc.baseline.fresh || !card.sources.gsc.current.fresh)) limitations.push('搜索指标新鲜度未满足项目要求，需先复核同步。');
  if (!card.maturity.full_lifetime_coverage) limitations.push('上线期没有覆盖完整比较周期，不直接比较月度总量。');
  if (!card.maturity.mature) limitations.push('尚不能作成熟文章的强候选判断。');
  if (card.reasons.includes('latest_sync_failed')) limitations.push('文章最新同步有异常，需先核查同步状态。');

  // 身份由真实快照决定，但模型只看到不含数值含义的字母 token。
  const token = hash({ version: MODEL_INPUT_VERSION, evidence: card.evidence }).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  const model = {
    id: `performance-narrative:${token}`, kind: 'performance_narrative', category: card.category,
    article_context:{article_title:topic(card.evidence[0].title,500),registered_keyword:topic(card.evidence[0].registered_keyword,1000)},
    facts, limitations, recommended_checks: [...card.recommended_checks], suggested_actions: [...card.suggested_actions],
  };
  // 追溯关系留在本地；独立副本避免模型适配器改变将要保存的证据。
  const stored = { ...structuredClone(model), source_evidence_ids: card.evidence.map(item => item.id) };
  return { stored, model };
}

module.exports = { MODEL_INPUT_VERSION, buildNarrative };
