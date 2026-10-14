const {withAtomicGuard}=require('../lib/atomic-guard');
const {fail}=require('./contracts');
const ADMIN="EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND deleted_at IS NULL)";

function createRuntimeSettings({db,config={},now=()=>new Date().toISOString()}){
  const b=db.db;
  const read=async()=>{
    const row=await b.prepare('SELECT * FROM ai_runtime_configuration WHERE id=1').get();
    return {version:row?.version||0,external_enabled:!config.DEPLOYMENT_HOLD&&(row?!!row.external_enabled:!!config.AI_EXTERNAL_ENABLED),deployment_hold:!!config.DEPLOYMENT_HOLD,
      source:row?'saved':'environment',updated_at:row?.updated_at||null};
  };
  const assertAdmin=async actor=>{if(!await b.prepare(`SELECT 1 WHERE ${ADMIN}`).get(actor))fail('FORBIDDEN','仅管理员可修改外部调用开关',403);};
  const get=async actor=>{await assertAdmin(actor);const result=await read();await assertAdmin(actor);return result;};
  async function save(actor,raw){
    await assertAdmin(actor);
    if(config.DEPLOYMENT_HOLD)fail('DEPLOYMENT_PAUSED','服务暂时暂停外部请求，请稍后再试',503);
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['version','external_enabled'].includes(k))||!Number.isSafeInteger(raw.version)||raw.version<0||typeof raw.external_enabled!=='boolean')fail('VALIDATION_ERROR','外部调用开关配置无效',400);
    try{await b.batchAtomic(withAtomicGuard(b,[b.prepare(`INSERT INTO ai_runtime_configuration(id,version,external_enabled,updated_by,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,external_enabled=excluded.external_enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(raw.version+1,Number(raw.external_enabled),actor,now())],`${ADMIN} AND COALESCE((SELECT version FROM ai_runtime_configuration WHERE id=1),0)=?`,[actor,raw.version]));}
    catch(error){if(!/CHECK constraint/.test(error.message))throw error;await assertAdmin(actor);fail('CONFLICT','外部调用开关已更新，请重新读取',409);}
    return get(actor);
  }
  return {read,get,save};
}
module.exports={createRuntimeSettings};
