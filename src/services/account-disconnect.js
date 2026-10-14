const {withAtomicGuard} = require('../lib/atomic-guard');
const {refreshProjectCandidates} = require('./resource-catalog');

async function disconnectGoogleAccount(db,account,user) {
  const backend=db.db,at=new Date().toISOString();
  const affected="SELECT id FROM projects WHERE account_id=? OR gsc_account_id=? OR ga4_account_id=?";
  const writes=[
    backend.prepare(`INSERT INTO project_monitor_sync_state(project_id,config_revision,updated_at)
      SELECT id,2,? FROM projects WHERE account_id=? OR gsc_account_id=? OR ga4_account_id=?
      ON CONFLICT(project_id) DO UPDATE SET config_revision=config_revision+1,updated_at=excluded.updated_at`).bind(at,account.id,account.id,account.id),
    backend.prepare(`UPDATE project_articles SET metrics_dirty=1,updated_at=? WHERE project_id IN (${affected})`).bind(at,account.id,account.id,account.id),
    backend.prepare(`UPDATE project_external_articles SET metrics_dirty=1,updated_at=? WHERE project_id IN (${affected})`).bind(at,account.id,account.id,account.id),
    backend.prepare(`UPDATE project_source_policies SET mode='disabled',updated_by=?,updated_at=? WHERE
      (source='gsc' AND project_id IN (SELECT id FROM projects WHERE COALESCE(gsc_account_id,account_id)=? AND COALESCE(gsc_site,'')<>'')) OR
      (source='ga4' AND project_id IN (SELECT id FROM projects WHERE COALESCE(ga4_account_id,account_id)=? AND COALESCE(ga4_property_id,'')<>''))`).bind(user.id,at,account.id,account.id),
    backend.prepare(`UPDATE projects SET
      gsc_site=CASE WHEN COALESCE(gsc_account_id,account_id)=? THEN NULL ELSE gsc_site END,
      ga4_property_id=CASE WHEN COALESCE(ga4_account_id,account_id)=? THEN NULL ELSE ga4_property_id END,
      gsc_account_id=CASE WHEN gsc_account_id=? THEN NULL ELSE gsc_account_id END,
      ga4_account_id=CASE WHEN ga4_account_id=? THEN NULL ELSE ga4_account_id END,
      account_id=CASE WHEN account_id=? THEN CASE WHEN gsc_account_id<>? THEN gsc_account_id WHEN ga4_account_id<>? THEN ga4_account_id ELSE NULL END ELSE account_id END
      WHERE account_id=? OR gsc_account_id=? OR ga4_account_id=?`).bind(account.id,account.id,account.id,account.id,account.id,account.id,account.id,account.id,account.id,account.id),
    backend.prepare('DELETE FROM google_accounts WHERE id=?').bind(account.id),
  ];
  const results=await backend.batchAtomic(withAtomicGuard(backend,writes,
    "SELECT EXISTS(SELECT 1 FROM google_accounts a JOIN users u ON u.id=? AND u.deleted_at IS NULL WHERE a.id=? AND a.auth_revision=? AND (u.role='admin' OR a.owner_user_id=u.id))",[user.id,account.id,account.auth_revision]));
  await refreshProjectCandidates(db);
  return Number(results[5].changes||0);
}
module.exports={disconnectGoogleAccount};
