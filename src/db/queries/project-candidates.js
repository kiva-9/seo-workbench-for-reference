const {candidateHostnameSql} = require('../../lib/resource-domain');
const host=candidateHostnameSql('c.hostname');
// 窗口一次归组别名，保留已认领入口和个人忽略，避免逐候选相关子查询。
const ranked=(where='')=>`WITH ranked AS (
  SELECT c.*,${host} AS canonical_hostname,
    MAX(COALESCE(pref.hidden,0)) OVER (PARTITION BY ${host}) AS group_hidden,
    ROW_NUMBER() OVER (PARTITION BY ${host} ORDER BY (c.resolved_project_id IS NOT NULL) DESC,c.id) AS position,
    u.name AS claimed_by_name,u.email AS claimed_by_email
  FROM project_candidates c LEFT JOIN project_candidate_preferences pref ON pref.candidate_id=c.id AND pref.user_id=?
  LEFT JOIN users u ON u.id=c.claimed_by ${where}) SELECT * FROM ranked WHERE position=1 ORDER BY canonical_hostname`;
const withCount=row=>row&&({...row,hidden:row.group_hidden,resource_count:row.fingerprint.split('|').filter(identity=>identity.endsWith(':available')).length});
const pageCte=`WITH grouped AS (
  SELECT ${host} AS canonical_hostname,
    COALESCE(MIN(CASE WHEN c.resolved_project_id IS NOT NULL THEN c.id END),MIN(c.id)) AS id,
    MAX(COALESCE(pref.hidden,0)) AS group_hidden
  FROM project_candidates c LEFT JOIN project_candidate_preferences pref ON pref.candidate_id=c.id AND pref.user_id=?
  WHERE instr(${host},?)>0 GROUP BY ${host}),
  candidates AS (SELECT c.*,g.canonical_hostname,g.group_hidden,u.name AS claimed_by_name,u.email AS claimed_by_email,
  CASE WHEN resolved_project_id IS NOT NULL THEN 'claimed'
    WHEN json_array_length(existing_project_ids)>0 THEN 'existing'
    WHEN instr(fingerprint,':available')=0 THEN 'unavailable' ELSE 'pending' END AS status
  FROM grouped g JOIN project_candidates c ON c.id=g.id LEFT JOIN users u ON u.id=c.claimed_by)`;
const visibleStatus=status=>status==='hidden'?'group_hidden=1':
  `group_hidden=0${status==='all'?'':` AND status='${['pending','existing','claimed','unavailable'].includes(status)?status:'invalid'}'`}`;
module.exports = db => ({
  getProjectCandidate: id => db.prepare(`SELECT c.* FROM project_candidates c WHERE ${host}=(SELECT ${candidateHostnameSql('hostname')} FROM project_candidates WHERE id=?)
    ORDER BY (c.resolved_project_id IS NOT NULL) DESC,c.id LIMIT 1`).get(id),
  setProjectCandidateHidden: (id,userId,hidden) => db.prepare(`INSERT INTO project_candidate_preferences(candidate_id,user_id,hidden)
    SELECT c.id,?,? FROM project_candidates c WHERE ${host}=(SELECT ${candidateHostnameSql('hostname')} FROM project_candidates WHERE id=?)
    ON CONFLICT(candidate_id,user_id) DO UPDATE SET hidden=excluded.hidden`).run(userId,hidden,id),
  listProjectCandidates:async userId=>(await db.prepare(ranked()).all(userId)).map(withCount),
  async pageProjectCandidates(userId,{status='pending',query='',page=1,pageSize=30}={}) {
    const size=Math.min(100,Math.max(1,parseInt(pageSize)||30)),requested=Math.min(1_000_000_000,Math.max(1,parseInt(page)||1)),where=visibleStatus(status);
    const statuses=['pending','existing','claimed','unavailable'];
    const counts=statuses.map(s=>`COALESCE(SUM(status='${s}' AND group_hidden=0),0) AS _${s}`).join(',');
    // 同一条语句复用归组结果，空页也保留计数；页数显式取整，兼容 Number 绑定为 REAL。
    const rows=await db.prepare(`${pageCte}, summary AS (
      SELECT ${counts},COALESCE(SUM(group_hidden=1),0) AS _hidden,COALESCE(SUM(${where}),0) AS _total FROM candidates),
      page AS (SELECT * FROM candidates WHERE ${where} ORDER BY canonical_hostname,id LIMIT ?
        OFFSET (SELECT (MIN(?,MAX(1,CAST((_total+?-1)/? AS INTEGER)))-1)*? FROM summary))
      SELECT summary.*,page.* FROM summary LEFT JOIN page ON 1 ORDER BY page.canonical_hostname,page.id`
    ).all(userId,query,size,requested,size,size,size);
    const total=rows[0]._total,tabs=Object.fromEntries([...statuses,'hidden'].map(s=>[s,rows[0]['_'+s]]));
    const items=rows.filter(r=>r.id!==null).map(row=>withCount(Object.fromEntries(Object.entries(row).filter(([key])=>!key.startsWith('_')))));
    return {items,total,counts:tabs,page:Math.min(requested,Math.max(1,Math.ceil(total/size))),page_size:size};
  },
  getProjectCandidateSummary:async(id,userId)=>withCount(await db.prepare(ranked(`WHERE ${host}=(SELECT ${candidateHostnameSql('hostname')} FROM project_candidates WHERE id=?)`)).get(userId,id)),
  listCandidateProjects:({id,role})=>db.prepare(`SELECT p.id,p.name FROM projects p WHERE ?=1 OR p.owner_user_id=? OR EXISTS(
    SELECT 1 FROM project_copywriters w WHERE w.project_id=p.id AND w.user_id=? AND w.revoked_at IS NULL) ORDER BY p.id`).all(role==='admin'?1:0,id,id),
  getProjectSourcePolicies: projectId => db.prepare('SELECT source,mode,updated_by,updated_at FROM project_source_policies WHERE project_id=? ORDER BY source').all(projectId),
});
