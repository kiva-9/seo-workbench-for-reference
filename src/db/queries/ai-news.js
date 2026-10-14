const {hash} = require('../../insights/contracts');

module.exports=backend=>({
  aiNewsCache:async(projectId,sourceIds,{limit=500}={})=>{
    if(!sourceIds.length)return [];
    const rows=await backend.prepare(`SELECT data_json FROM (SELECT data_json,source_id,id,fetched_at,ROW_NUMBER() OVER(PARTITION BY source_id ORDER BY fetched_at DESC,id) source_row FROM ai_news_items WHERE project_id=? AND source_id IN (${sourceIds.map(()=>'?').join(',')})) WHERE source_row<=? ORDER BY source_row,source_id,id LIMIT ?`).all(projectId,...sourceIds,Math.ceil(Math.min(500,limit)/sourceIds.length),Math.min(500,limit));
    return rows.map(row=>JSON.parse(row.data_json)).filter(row=>row&&typeof row.id==='string'&&typeof row.dedupe_key==='string');
  },
  aiNewsSourceHistory:async(projectId,sources)=>{
    if(!sources.length)return {};
    const rows=await backend.prepare(`SELECT result_json FROM ai_insight_runs WHERE project_id=? AND module='news' AND result_json IS NOT NULL ORDER BY finished_at DESC,created_at DESC,id DESC LIMIT 20`).all(projectId);
    const history={};
    for(const row of rows){
      const states=JSON.parse(row.result_json)?.counts?.sources;
      if(!Array.isArray(states))continue;
      for(const state of states)if(sources.some(source=>source.id===state.id&&source.url===state.url)&&!history[state.id]&&state.last_success_at)history[state.id]=state.last_success_at;
    }
    return history;
  },
  aiNewsStatements:(projectId,reports)=>reports.map(report=>backend.prepare(`
    INSERT INTO ai_news_items(id,project_id,source_id,dedupe_key,title,url,published_at,fetched_at,content_hash,data_json)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,dedupe_key) DO UPDATE SET
      source_id=excluded.source_id,title=excluded.title,url=excluded.url,published_at=excluded.published_at,
      fetched_at=excluded.fetched_at,content_hash=excluded.content_hash,data_json=excluded.data_json
  `).bind(hash([projectId,report.dedupe_key]),projectId,report.source_id,report.dedupe_key,report.title,report.url,report.published_at,report.fetched_at,report.content_hash,JSON.stringify(report))),
});
