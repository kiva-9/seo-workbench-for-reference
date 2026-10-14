const {withAtomicGuard} = require('../lib/atomic-guard');
const {checkResourceBinding} = require('./project-resource-access');

async function createConfiguredProject(db,data,user) {
  const backend=db.db,writes=[];
  for(const [source,account,key] of [['gsc','gsc_account_id','gsc_site'],['ga4','ga4_account_id','ga4_property_id']]){
    const guard=await checkResourceBinding(db,{source,accountId:data[account],resourceKey:data[key],actor:{user_id:user.id,current_role:user.role}});
    if(guard)writes.push(...withAtomicGuard(backend,[],guard.sql,guard.args));
  }
  const record={...data,owner_user_id:user.id,created_at:db.now()},fields=Object.keys(record);
  writes.push(backend.prepare(`INSERT INTO projects(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`).bind(...fields.map(f=>record[f]??null)));
  const results=await backend.batchAtomic(withAtomicGuard(backend,writes,'SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)',[user.id]));
  return Number(results[results.length-2].lastInsertRowid);
}
module.exports={createConfiguredProject};
