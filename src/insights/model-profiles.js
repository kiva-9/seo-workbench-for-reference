const {fail}=require('./contracts');

function publicProfile(row){
  return {id:row.id,label:row.label,base_url:row.base_url,model_name:row.model_name,
    key_configured:!!row.encrypted_api_key,enabled:!!row.enabled,
    input_rate:row.input_rate,output_rate:row.output_rate,call_ceiling:row.call_ceiling};
}

function prepareProfiles(raw,oldRows,{baseUrl,encrypt}){
  const allowed=['version','profiles','selected_model_id','fallback_model_id','enabled'];
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!allowed.includes(k))||
    !Number.isSafeInteger(raw.version)||raw.version<0||typeof raw.enabled!=='boolean'||
    !Array.isArray(raw.profiles)||raw.profiles.length>20)fail('VALIDATION_ERROR','模型条目配置格式无效',400);
  const seen=new Set(),actions=[];
  const profiles=raw.profiles.map(value=>{
    const fields=['id','label','base_url','model_name','api_key','clear_key','enabled','input_rate','output_rate','call_ceiling'];
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k))||
      typeof value.id!=='string'||!/^[-\w]{1,80}$/.test(value.id)||seen.has(value.id)||
      typeof value.label!=='string'||!value.label.trim()||value.label.length>160||
      typeof value.model_name!=='string'||value.model_name.length>200||/[\r\n]/.test(value.model_name)||
      typeof value.enabled!=='boolean'||(value.clear_key!==undefined&&typeof value.clear_key!=='boolean'))fail('VALIDATION_ERROR','模型条目格式无效或 ID 重复',400);
    seen.add(value.id);
    for(const name of ['input_rate','output_rate'])if(value[name]!==null&&(!Number.isFinite(value[name])||value[name]<0||value[name]>1000))fail('VALIDATION_ERROR','模型价格需要为非负数或留空',400);
    if(!Number.isFinite(value.call_ceiling)||value.call_ceiling<0||value.call_ceiling>10)fail('VALIDATION_ERROR','单次费用上限无效',400);
    if(value.api_key!==undefined&&(typeof value.api_key!=='string'||value.api_key.length>4096||/[^\x21-\x7e]/.test(value.api_key)))fail('VALIDATION_ERROR','API Key 格式无效',400);
    if(value.clear_key&&value.api_key)fail('VALIDATION_ERROR','不能同时替换和清除 API Key',400);
    const url=baseUrl(value.base_url),old=oldRows.find(row=>row.id===value.id);
    if(old?.encrypted_api_key&&url!==old.base_url&&!value.api_key&&!value.clear_key)fail('VALIDATION_ERROR','修改 Base URL 时必须重新填写或清除 API Key',400);
    const secret=value.clear_key?null:value.api_key?encrypt(value.api_key):old?.encrypted_api_key||null;
    const enabled=value.clear_key?false:value.enabled;
    if(enabled&&(!secret||!value.model_name.trim()))fail('VALIDATION_ERROR','启用模型条目前需要模型名称和 API Key',400);
    actions.push({id:value.id,key_action:value.clear_key?'cleared':value.api_key?'replaced':'kept'});
    return {id:value.id,label:value.label.trim(),base_url:url,model_name:value.model_name.trim(),encrypted_api_key:secret,
      enabled:Number(enabled),input_rate:value.input_rate,output_rate:value.output_rate,call_ceiling:value.call_ceiling};
  });
  const selected=profiles.find(p=>p.id===raw.selected_model_id),fallback=profiles.find(p=>p.id===raw.fallback_model_id);
  if((raw.selected_model_id!==null&&!selected)||(raw.fallback_model_id!==null&&!fallback)||
    (fallback&&(!fallback.enabled||!fallback.encrypted_api_key||fallback.id===selected?.id))||
    (raw.enabled&&(!selected?.enabled||!selected.encrypted_api_key)))fail('VALIDATION_ERROR','请选择可用的主模型与不同的备用模型',400);
  return {profiles,selected,fallback,actions};
}

module.exports={publicProfile,prepareProfiles};
