// 列表按命中平台批量汇总，明细复用同一口径；JSON 集合绑定批量读取所选平台。
const { buildFingerprint } = require('../../lib/external-fingerprint');

// 固化小范围 JSON 集合，避免 SQLite 将 CTE 内联后在每一行日指标上重复 json_extract。
const SCOPE = `WITH selected AS MATERIALIZED (
  SELECT CAST(json_extract(value,'$.project_id') AS INTEGER) AS project_id,
         json_extract(value,'$.domain') AS domain,
         json_extract(value,'$.fingerprint') AS fingerprint
  FROM json_each(?)
)`;

async function loadPlatformAggregates(db, platforms, { includeFreezes = true } = {}) {
  const result = new Map();
  for (let offset = 0; offset < platforms.length; offset += 500) {
    const scope = platforms.slice(offset, offset + 500).map(p => ({
      project_id: Number(p.project_id), domain: p.domain,
      fingerprint: p.fingerprint === undefined ? buildFingerprint(p.articles[0]) : p.fingerprint,
    }));
    const input = JSON.stringify(scope);
    const [daily, monthly, freezes] = await Promise.all([
      db.prepare(`${SCOPE}
        SELECT s.project_id,s.domain,
          EXISTS(SELECT 1 FROM project_external_daily_metrics m WHERE m.project_id=s.project_id AND m.domain=s.domain) AS any_rows,
          (SELECT json_group_array(json_object('source',source,'total',total,'days',days,'end',end,'fetched',fetched))
           FROM (SELECT source,SUM(value) AS total,COUNT(*) AS days,MAX(date) AS end,MAX(fetched_at) AS fetched
             FROM project_external_daily_metrics
             WHERE project_id=s.project_id AND domain=s.domain AND config_fingerprint=s.fingerprint
             GROUP BY source)) AS metrics
        FROM selected s`).all(input),
      db.prepare(`${SCOPE}
        SELECT m.project_id,m.domain,
          SUM(CASE WHEN m.users_status<>'complete' OR m.events_status<>'complete' THEN 1 ELSE 0 END) AS issues,
          MAX(CASE WHEN m.users_fingerprint=s.fingerprint THEN m.users_fetched_at END) AS users_fetched,
          MAX(CASE WHEN m.events_fingerprint=s.fingerprint THEN m.events_fetched_at END) AS events_fetched
        FROM selected s JOIN project_external_month_state m ON m.project_id=s.project_id AND m.domain=s.domain
        GROUP BY m.project_id,m.domain`).all(input),
      includeFreezes ? db.prepare(`${SCOPE}
        SELECT f.project_id,f.domain,COUNT(*) AS count
        FROM selected s JOIN project_external_article_freezes f ON f.project_id=s.project_id AND f.domain=s.domain
        GROUP BY f.project_id,f.domain`).all(input) : [],
    ]);
    const key = p => `${Number(p.project_id)}|${p.domain}`;
    const dailyByPlatform = new Map(daily.map(p => {
      const sources = new Map(JSON.parse(p.metrics).map(m=>[m.source,m]));
      const users = sources.get('users'), events = sources.get('events');
      return [key(p),{any_rows:p.any_rows,users_total:users?.total,users_days:users?.days,
        users_end:users?.end,users_fetched:users?.fetched,events_total:events?.total,
        events_end:events?.end,events_fetched:events?.fetched}];
    }));
    const monthlyByPlatform = new Map(monthly.map(p => [key(p),p]));
    const freezesByPlatform = new Map(freezes.map(p => [key(p),Number(p.count)]));
    for (const p of scope) {
      const d = dailyByPlatform.get(key(p)), m = monthlyByPlatform.get(key(p));
      const users = d?.users_total ?? null, events = d?.events_total ?? null;
      const aggregate = p.fingerprint ? {
        usersTotal: users === null ? null : Number(users),
        eventsTotal: events === null ? null : Number(events),
        days: Number(d?.users_days || 0),
        dataThrough: d?.users_end || d?.events_end || null,
        complete: Number(m?.issues || 0) === 0 && (users !== null || events !== null),
        staleConfig: users === null && events === null && Number(d?.any_rows || 0) > 0,
        lastSyncedAt: [d?.users_fetched,d?.events_fetched,m?.users_fetched,m?.events_fetched].filter(Boolean).sort().at(-1) || null,
      } : { usersTotal:null,eventsTotal:null,days:0,dataThrough:null,complete:false,staleConfig:true,lastSyncedAt:null };
      result.set(key(p),{ aggregate,freezeCount:freezesByPlatform.get(key(p)) || 0 });
    }
  }
  return result;
}

module.exports = { loadPlatformAggregates };
