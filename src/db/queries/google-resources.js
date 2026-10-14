const {candidateHostnameSql} = require('../../lib/resource-domain');
const candidateHost=candidateHostnameSql('c.hostname'),domainHost=candidateHostnameSql('d.hostname');
// www 仅参与同站归组；子域覆盖仍按 GSC 属性的原始域名判断。
const CANDIDATE_RESOURCE_SCOPE = `(${domainHost}=${candidateHost} OR (r.source='gsc' AND substr(r.resource_key,1,10)='sc-domain:' AND d.hostname<>'' AND substr(${candidateHost},-length(d.hostname)-1)='.'||d.hostname))`;
const RESOURCE_SELECT = `SELECT r.id,r.account_id,r.source,r.resource_key,r.display_name,r.account_display_name,
  r.permission_level,r.state,r.revision,r.stream_state,r.generation,r.last_seen_at,a.email,a.note,a.auth_revision,
  COALESCE((SELECT json_group_array(json_object('stream_key',d.stream_key,'type',d.stream_type,'website',d.website,'hostname',d.hostname))
    FROM google_resource_domains d WHERE d.resource_id=r.id),'[]') AS domains_json
  FROM google_resources r JOIN google_accounts a ON a.id=r.account_id`;
const PROJECT_RESOURCE_ACCESS = `(?=1 OR a.owner_user_id=? OR EXISTS(
  SELECT 1 FROM project_resource_grants g WHERE g.project_id=? AND g.source=r.source
    AND g.account_id=r.account_id AND g.resource_key=r.resource_key AND g.revoked_at IS NULL))`;

module.exports = db => ({
  getGoogleResource: id => db.prepare(RESOURCE_SELECT + ' WHERE r.id=?').get(id),
  findGoogleResource: (accountId,source,key) => db.prepare(RESOURCE_SELECT + ' WHERE r.account_id=? AND r.source=? AND r.resource_key=?').get(accountId,source,key),
  listAccountResources: accountId => db.prepare(RESOURCE_SELECT + ' WHERE r.account_id=? ORDER BY r.source,r.resource_key').all(accountId),
  listAvailableResources: () => db.prepare(RESOURCE_SELECT + " WHERE r.state='available' ORDER BY r.source,r.resource_key,r.account_id").all(),
  listCandidateResources: candidateId => db.prepare(RESOURCE_SELECT + ` WHERE r.state='available' AND EXISTS(
    SELECT 1 FROM google_resource_domains d JOIN project_candidates c ON ${CANDIDATE_RESOURCE_SCOPE} WHERE d.resource_id=r.id AND c.id=?)
    ORDER BY r.source,r.resource_key,r.account_id`).all(candidateId),
  listProjectResourceChoices: (projectId,userId,isAdmin,ids=null) => db.prepare(RESOURCE_SELECT + ` WHERE r.state='available' AND ${PROJECT_RESOURCE_ACCESS}
    ${ids===null?'':'AND r.id IN (SELECT value FROM json_each(?))'}
    ORDER BY r.source,r.resource_key,r.account_id`).all(isAdmin?1:0,userId,projectId,...(ids===null?[]:[JSON.stringify(ids)])),
  projectCurrentResourceChoices: (projectId,userId,isAdmin) => db.prepare(RESOURCE_SELECT + ` JOIN projects p ON p.id=?
    WHERE r.state='available' AND ${PROJECT_RESOURCE_ACCESS} AND
    ((r.source='gsc' AND r.account_id=COALESCE(p.gsc_account_id,p.account_id) AND r.resource_key=p.gsc_site)
      OR (r.source='ga4' AND r.account_id=COALESCE(p.ga4_account_id,p.account_id) AND r.resource_key=p.ga4_property_id))`).all(projectId,isAdmin?1:0,userId,projectId),
  hasResourceGrant: (projectId,source,accountId,key) => db.prepare(`SELECT 1 FROM project_resource_grants WHERE project_id=? AND source=? AND account_id=? AND resource_key=? AND revoked_at IS NULL`).get(projectId,source,accountId,key),
  getResourceSyncJob: id => db.prepare('SELECT * FROM google_resource_sync_jobs WHERE id=?').get(id),
  getActiveResourceSyncJob: accountId => db.prepare("SELECT * FROM google_resource_sync_jobs WHERE account_id=? AND status IN ('queued','running')").get(accountId),
  getLatestResourceSyncJob: accountId => db.prepare('SELECT * FROM google_resource_sync_jobs WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(accountId),
  listResourceSyncSources: accountId => db.prepare('SELECT * FROM google_resource_sync_sources WHERE account_id=? ORDER BY source').all(accountId),
  resourceAccountImpact: accountId => db.prepare(`SELECT p.id,p.name,
    CASE WHEN COALESCE(p.gsc_account_id,p.account_id)=? AND COALESCE(p.gsc_site,'')<>'' THEN 1 ELSE 0 END AS gsc,
    CASE WHEN COALESCE(p.ga4_account_id,p.account_id)=? AND COALESCE(p.ga4_property_id,'')<>'' THEN 1 ELSE 0 END AS ga4
    FROM projects p WHERE p.account_id=? OR p.gsc_account_id=? OR p.ga4_account_id=? ORDER BY p.id`).all(accountId,accountId,accountId,accountId,accountId),
});
module.exports.RESOURCE_SELECT = RESOURCE_SELECT;
module.exports.CANDIDATE_RESOURCE_SCOPE = CANDIDATE_RESOURCE_SCOPE;
