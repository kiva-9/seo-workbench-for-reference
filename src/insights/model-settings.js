const fs=require('node:fs');
const path=require('node:path');
const {randomBytes,createCipheriv,createDecipheriv}=require('node:crypto');
const {withAtomicGuard}=require('../lib/atomic-guard');
const {fail,hash}=require('./contracts');
const {createModelAdapter}=require('./model');
const {checkedUrl}=require('./news/safe-fetch');
const {publicProfile,prepareProfiles}=require('./model-profiles');
const {createRuntimeSettings}=require('./runtime-settings');
const ADMIN="EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND deleted_at IS NULL)";
const KEY_FILE='.ai-model-key';

function baseUrl(raw){
  if(typeof raw!=='string'||raw.length>2000)fail('VALIDATION_ERROR','Base URL 格式无效',400);
  let url;try{const parsed=new URL(raw.trim());if(parsed.hash)throw new Error();url=checkedUrl(raw.trim());}catch{fail('VALIDATION_ERROR','Base URL 需要公共 HTTPS 地址',400);}
  if(url.protocol!=='https:'||url.search||url.hash||/\/chat\/completions\/?$/.test(url.pathname))fail('VALIDATION_ERROR','请填写 HTTPS API 基础地址，例如 https://api.openai.com/v1',400);
  return url.href.replace(/\/+$/,'');
}
function environmentBase(config){
  try{const url=new URL(config.AI_MODEL_ENDPOINT||'https://api.openai.com/v1/chat/completions');url.username='';url.password='';url.search='';url.hash='';return url.href.replace(/\/chat\/completions\/?$/,'').replace(/\/+$/,'');}
  catch{return 'https://api.openai.com/v1';}
}
function createModelSettings({db,config={},dataDir,encryptionKey,now=()=>new Date().toISOString(),modelOptions={}}){
  const b=db.db;
  const runtimeSettings=createRuntimeSettings({db,config,now});
  async function assertAdmin(actorId){if(!await b.prepare(`SELECT 1 WHERE ${ADMIN}`).get(actorId))fail('FORBIDDEN','仅管理员可管理模型配置',403);}
  function key(create=false){
    if(encryptionKey){if(!Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32)fail('MODEL_KEY_UNAVAILABLE','模型密钥加密配置不可用',503);return encryptionKey;}
    const directory=dataDir||process.env.SPM_DATA_DIR||path.join(config.ROOT_DIR||path.resolve(__dirname,'../..'),'data');
    const file=path.join(directory,KEY_FILE);
    try{
      if(create&&!fs.existsSync(file)){
        fs.mkdirSync(directory,{recursive:true});
        try{fs.writeFileSync(file,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
      }
      const value=fs.readFileSync(file);if(value.length!==32)throw new Error();return value;
    }catch{fail('MODEL_KEY_UNAVAILABLE','模型密钥加密文件不可用；恢复文件或重新保存 API Key',503);}
  }
  function encrypt(value){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(true),iv);cipher.setAAD(Buffer.from('seo-ai-model-v1'));
    const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    return JSON.stringify({v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
  }
  function decrypt(value){
    try{const box=JSON.parse(value);if(box.v!==1)throw new Error();const decipher=createDecipheriv('aes-256-gcm',key(),Buffer.from(box.iv,'base64'));decipher.setAAD(Buffer.from('seo-ai-model-v1'));decipher.setAuthTag(Buffer.from(box.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(box.data,'base64')),decipher.final()]).toString('utf8');}
    catch{fail('MODEL_KEY_UNAVAILABLE','模型 API Key 无法解密，请管理员恢复加密文件或重新保存',503);}
  }
  const read=()=>b.prepare('SELECT * FROM ai_model_configuration WHERE id=1').get();
  const readProfiles=()=>b.prepare('SELECT * FROM ai_model_profiles ORDER BY rowid,id').all();
  const profileStatement=row=>b.prepare(`INSERT INTO ai_model_profiles(id,label,base_url,model_name,encrypted_api_key,enabled,input_rate,output_rate,call_ceiling) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,base_url=excluded.base_url,model_name=excluded.model_name,encrypted_api_key=excluded.encrypted_api_key,enabled=excluded.enabled,input_rate=excluded.input_rate,output_rate=excluded.output_rate,call_ceiling=excluded.call_ceiling`).bind(row.id,row.label,row.base_url,row.model_name,row.encrypted_api_key,row.enabled,row.input_rate,row.output_rate,row.call_ceiling);
  function publicConfig(row){
    return {version:row?.version||0,base_url:row?.base_url||environmentBase(config),model_name:row?.model_name??config.AI_MODEL_NAME??'',key_configured:row?!!row.encrypted_api_key:!!config.AI_MODEL_KEY,enabled:row?!!row.enabled:!!(config.AI_MODEL_KEY&&config.AI_MODEL_NAME),input_rate:row?.input_rate??(row?null:config.AI_MODEL_INPUT_RATE??null),output_rate:row?.output_rate??(row?null:config.AI_MODEL_OUTPUT_RATE??null),call_ceiling:row?.call_ceiling??config.AI_MODEL_CALL_CEILING??0,source:row?'saved':'environment',updated_at:row?.updated_at??null,updated_by:row?.updated_by??null,external_enabled:!!config.AI_EXTERNAL_ENABLED,synthetic:!!config.AI_DEMO_MODE};
  }
  async function get(actorId){
    const row=await b.prepare(`SELECT c.* FROM (SELECT 1) singleton LEFT JOIN ai_model_configuration c ON c.id=1 WHERE ${ADMIN}`).get(actorId);
    if(!row)fail('FORBIDDEN','仅管理员可管理模型配置',403);
    const saved=row.version?row:null,profiles=await readProfiles();await assertAdmin(actorId);
    if(!saved&&config.AI_MODEL_NAME)profiles.push({id:'environment',label:config.AI_MODEL_NAME,base_url:environmentBase(config),model_name:config.AI_MODEL_NAME,encrypted_api_key:!!config.AI_MODEL_KEY,enabled:Number(!!config.AI_MODEL_KEY),input_rate:config.AI_MODEL_INPUT_RATE??null,output_rate:config.AI_MODEL_OUTPUT_RATE??null,call_ceiling:config.AI_MODEL_CALL_CEILING??0});
    const runtime=await runtimeSettings.read();await assertAdmin(actorId);
    return {...publicConfig(saved),external_enabled:runtime.external_enabled,external_configuration:runtime,profiles:profiles.map(publicProfile),selected_model_id:saved?.selected_model_id??(config.AI_MODEL_NAME&&!saved?'environment':null),fallback_model_id:saved?.fallback_model_id??null};
  }
  async function saveProfiles(actorId,raw){
    await assertAdmin(actorId);const old=await read();
    if(raw.version!==(old?.version||0))fail('CONFLICT','模型配置已更新，请刷新后重试',409);
    const oldRows=await readProfiles();
    if(!old&&config.AI_MODEL_NAME)oldRows.push({id:'environment',base_url:environmentBase(config),encrypted_api_key:config.AI_MODEL_KEY?encrypt(config.AI_MODEL_KEY):null});
    const {profiles,selected,fallback,actions}=prepareProfiles(raw,oldRows,{baseUrl,encrypt});
    const at=now(),version=raw.version+1;
    const statements=profiles.map(profileStatement);
    statements.push(b.prepare(`INSERT INTO ai_model_configuration(id,version,base_url,model_name,encrypted_api_key,enabled,input_rate,output_rate,call_ceiling,updated_by,updated_at,selected_model_id,fallback_model_id) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,base_url=excluded.base_url,model_name=excluded.model_name,encrypted_api_key=excluded.encrypted_api_key,enabled=excluded.enabled,input_rate=excluded.input_rate,output_rate=excluded.output_rate,call_ceiling=excluded.call_ceiling,updated_by=excluded.updated_by,updated_at=excluded.updated_at,selected_model_id=excluded.selected_model_id,fallback_model_id=excluded.fallback_model_id`).bind(version,selected?.base_url||environmentBase(config),selected?.model_name||'',selected?.encrypted_api_key||null,Number(raw.enabled),selected?.input_rate??null,selected?.output_rate??null,selected?.call_ceiling||0,actorId,at,selected?.id||null,fallback?.id||null));
    const ids=profiles.map(p=>p.id);
    statements.push(b.prepare(`DELETE FROM ai_model_profiles${ids.length?' WHERE id NOT IN ('+ids.map(()=>'?').join(',')+')':''}`).bind(...ids));
    statements.push(b.prepare('INSERT INTO ai_model_config_events(version,actor_id,base_url,model_name,key_action,created_at,profiles_json) VALUES(?,?,?,?,?,?,?)').bind(version,actorId,selected?.base_url||'',selected?.model_name||'',actions.find(a=>a.id===selected?.id)?.key_action||'kept',at,JSON.stringify({selected: selected?.id||null,fallback:fallback?.id||null,profiles:profiles.map(publicProfile),actions})));
    try{await b.batchAtomic(withAtomicGuard(b,statements,`${ADMIN} AND COALESCE((SELECT version FROM ai_model_configuration WHERE id=1),0)=?`,[actorId,raw.version]));}
    catch(error){if(!/CHECK constraint/.test(error.message))throw error;await assertAdmin(actorId);fail('CONFLICT','模型配置已更新，请刷新后重试',409);}
    return get(actorId);
  }
  async function save(actorId,raw){
    if(raw&&Object.hasOwn(raw,'profiles'))return saveProfiles(actorId,raw);
    await assertAdmin(actorId);
    const allowed=['version','base_url','model_name','api_key','clear_key','enabled','input_rate','output_rate','call_ceiling'];
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!allowed.includes(k))||!Number.isSafeInteger(raw.version)||raw.version<0||typeof raw.model_name!=='string'||raw.model_name.length>200||/[\r\n]/.test(raw.model_name)||typeof raw.enabled!=='boolean'||(raw.clear_key!==undefined&&typeof raw.clear_key!=='boolean'))fail('VALIDATION_ERROR','模型配置格式无效',400);
    for(const name of ['input_rate','output_rate'])if(raw[name]!==null&&(!Number.isFinite(raw[name])||raw[name]<0||raw[name]>1000))fail('VALIDATION_ERROR','模型价格需要为非负数或留空',400);
    if(!Number.isFinite(raw.call_ceiling)||raw.call_ceiling<0||raw.call_ceiling>10)fail('VALIDATION_ERROR','单次费用上限无效',400);
    if(raw.api_key!==undefined&&(typeof raw.api_key!=='string'||raw.api_key.length>4096||/[^\x21-\x7e]/.test(raw.api_key)))fail('VALIDATION_ERROR','API Key 格式无效',400);
    if(raw.clear_key&&raw.api_key)fail('VALIDATION_ERROR','不能同时替换和清除 API Key',400);
    const url=baseUrl(raw.base_url),old=await read();
    if(raw.version!==(old?.version||0))fail('CONFLICT','模型配置已更新，请刷新后重试',409);
    const oldBase=old?.base_url||environmentBase(config);
    if(url!==oldBase&&!raw.api_key&&!raw.clear_key&&(old?.encrypted_api_key||(!old&&config.AI_MODEL_KEY)))fail('VALIDATION_ERROR','修改 Base URL 时必须重新填写或清除 API Key，避免发送给错误供应商',400);
    let secret=old?.encrypted_api_key||null,action='kept';
    if(raw.clear_key){secret=null;action='cleared';}
    else if(raw.api_key){secret=encrypt(raw.api_key);action='replaced';}
    else if(!old&&config.AI_MODEL_KEY)secret=encrypt(config.AI_MODEL_KEY);
    if(raw.enabled&&(!secret||!raw.model_name.trim()))fail('VALIDATION_ERROR','启用模型前需要模型名称和 API Key',400);
    const at=now(),version=raw.version+1;
    const profileId=old?.selected_model_id||'default';
    const statements=[profileStatement({id:profileId,label:raw.model_name.trim()||'默认模型',base_url:url,model_name:raw.model_name.trim(),encrypted_api_key:secret,enabled:Number(raw.enabled),input_rate:raw.input_rate,output_rate:raw.output_rate,call_ceiling:raw.call_ceiling}),b.prepare(`INSERT INTO ai_model_configuration(id,version,base_url,model_name,encrypted_api_key,enabled,input_rate,output_rate,call_ceiling,updated_by,updated_at,selected_model_id) VALUES(1,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,base_url=excluded.base_url,model_name=excluded.model_name,encrypted_api_key=excluded.encrypted_api_key,enabled=excluded.enabled,input_rate=excluded.input_rate,output_rate=excluded.output_rate,call_ceiling=excluded.call_ceiling,updated_by=excluded.updated_by,updated_at=excluded.updated_at,selected_model_id=excluded.selected_model_id`).bind(version,url,raw.model_name.trim(),secret,Number(raw.enabled),raw.input_rate,raw.output_rate,raw.call_ceiling,actorId,at,profileId),b.prepare('INSERT INTO ai_model_config_events(version,actor_id,base_url,model_name,key_action,created_at) VALUES(?,?,?,?,?,?)').bind(version,actorId,url,raw.model_name.trim(),action,at)];
    try{await b.batchAtomic(withAtomicGuard(b,statements,`${ADMIN} AND COALESCE((SELECT version FROM ai_model_configuration WHERE id=1),0)=?`,[actorId,raw.version]));}
    catch(error){if(!/CHECK constraint/.test(error.message))throw error;await assertAdmin(actorId);fail('CONFLICT','模型配置已更新，请刷新后重试',409);}
    return get(actorId);
  }
  async function runtime(){
    const row=await read();
    if(!row)return {version:0,adapter:createModelAdapter(config,modelOptions)};
    if(!row.enabled||!row.encrypted_api_key)return {version:row.version,adapter:null};
    function adapterFor(profile){
      let adapter;
      try{adapter=createModelAdapter({...config,AI_MODEL_NAME:profile.model_name,AI_MODEL_KEY:decrypt(profile.encrypted_api_key),AI_MODEL_ENDPOINT:profile.base_url+'/chat/completions',AI_MODEL_INPUT_RATE:profile.input_rate,AI_MODEL_OUTPUT_RATE:profile.output_rate,AI_MODEL_CALL_CEILING:profile.call_ceiling},modelOptions);}
      catch{adapter=async()=>fail('MODEL_KEY_UNAVAILABLE','模型密钥不可用',503);adapter.preflight=()=>fail('MODEL_KEY_UNAVAILABLE','模型密钥不可用',503);adapter.identity={model:profile.model_name,provider_hash:hash(profile.base_url),key_unavailable:true};}
      adapter.identity={...adapter.identity,configuration_version:row.version,profile_id:profile.id};return adapter;
    }
    const adapter=adapterFor({...row,id:row.selected_model_id});
    if(row.fallback_model_id){
      const fallback=await b.prepare('SELECT * FROM ai_model_profiles WHERE id=? AND enabled=1').get(row.fallback_model_id);
      if(fallback?.encrypted_api_key){adapter.fallback=adapterFor(fallback);adapter.identity.fallback=adapter.fallback.identity;}
    }
    return {version:row.version,adapter};
  }

  async function configured(){const row=await read();return row?!!(row.enabled&&row.model_name&&row.encrypted_api_key):!!(config.AI_MODEL_NAME&&config.AI_MODEL_KEY);}
  return {get,save,runtime,configured,assertAdmin,runtimeSettings};
}
module.exports={createModelSettings,baseUrl,KEY_FILE};
