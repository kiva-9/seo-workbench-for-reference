const {candidateHostnameSql}=require('../../lib/resource-domain');
const {RESOURCE_SELECT}=require('./google-resources');

// 先筛选和分页资源身份，只有当页才读取数据流详情。
const scope=`WITH input(hostname,q,project_id,user_id,is_admin,source,ancestors,account_id) AS (VALUES(?,?,?,?,?,?,?,?)),
  matching AS (SELECT d.resource_id FROM input i JOIN google_resource_domains d ON ${candidateHostnameSql('d.hostname')}=i.hostname
    WHERE i.hostname<>''
    UNION SELECT d.resource_id FROM input i JOIN json_each(i.ancestors) parent
    JOIN google_resource_domains d ON d.hostname=parent.value JOIN google_resources r ON r.id=d.resource_id
    WHERE r.source='gsc' AND substr(r.resource_key,1,10)='sc-domain:'),
  scoped AS (SELECT r.id,r.source,r.resource_key,r.account_id,r.stream_state,
    (m.resource_id IS NOT NULL) AS matched
    FROM google_resources r JOIN google_accounts a ON a.id=r.account_id CROSS JOIN input i LEFT JOIN matching m ON m.resource_id=r.id
    WHERE r.state='available' AND (i.source='' OR r.source=i.source)
      AND (i.account_id=0 OR r.account_id=i.account_id)
      AND (i.project_id=0 OR i.is_admin=1 OR a.owner_user_id=i.user_id OR EXISTS(
        SELECT 1 FROM project_resource_grants g WHERE g.project_id=i.project_id AND g.source=r.source
          AND g.account_id=r.account_id AND g.resource_key=r.resource_key AND g.revoked_at IS NULL))
      AND (i.q='' OR instr(spm_lower(a.email),i.q)>0 OR instr(spm_lower(r.resource_key),i.q)>0
        OR instr(spm_lower(r.display_name),i.q)>0 OR instr(spm_lower(r.account_display_name),i.q)>0
        OR EXISTS(SELECT 1 FROM google_resource_domains d WHERE d.resource_id=r.id AND instr(spm_lower(d.hostname),i.q)>0)))`;

module.exports=db=>({
  async searchResourcePage({hostname='',q='',projectId=0,userId=0,isAdmin=false,source='',page=1,pageSize=25,accountId=0}={}) {
    const size=Math.min(100,Math.max(1,parseInt(pageSize)||25)),number=Math.min(1_000_000_000,Math.max(1,parseInt(page)||1));
    const labels=hostname.split('.'),ancestors=labels.slice(1).map((_,i)=>labels.slice(i+1).join('.'));
    const params=[hostname,String(q).trim().toLowerCase().slice(0,200),projectId,userId,isAdmin?1:0,source,JSON.stringify(ancestors),accountId];
    const [summary,rows]=await db.batch([
      db.prepare(`${scope} SELECT COUNT(*) AS total,COALESCE(SUM(matched),0) AS matched_count,
        COUNT(DISTINCT CASE WHEN matched THEN resource_key END) AS identity_count,
        (SELECT s.id FROM scoped s WHERE s.matched AND s.stream_state='complete'
          AND (s.source<>'ga4' OR (SELECT COUNT(DISTINCT ${candidateHostnameSql('d.hostname')})
            FROM google_resource_domains d WHERE d.resource_id=s.id AND d.hostname<>'')<=1)
          ORDER BY s.resource_key,s.account_id,s.id LIMIT 1) AS recommended_id FROM scoped`).bind(...params),
      db.prepare(`${scope}, selected AS (SELECT * FROM scoped ORDER BY matched DESC,resource_key,account_id,id
        LIMIT ? OFFSET (SELECT (MIN(?,MAX(1,CAST((COUNT(*)+?-1)/? AS INTEGER)))-1)*? FROM scoped))
        ${RESOURCE_SELECT} JOIN selected s ON s.id=r.id ORDER BY s.matched DESC,r.resource_key,r.account_id,r.id`).bind(...params,size,number,size,size,size),
    ]);
    const {total,matched_count,identity_count,recommended_id}=summary.results[0];
    return {items:rows.results,total,matched_count,recommended_id:identity_count===1?recommended_id:null,page:Math.min(number,Math.max(1,Math.ceil(total/size))),page_size:size};
  },
  resourcesByIds:ids=>db.prepare(RESOURCE_SELECT+" WHERE r.state='available' AND r.id IN (SELECT value FROM json_each(?)) ORDER BY r.source,r.resource_key,r.account_id,r.id").all(JSON.stringify(ids)),
});
