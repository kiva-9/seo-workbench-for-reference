const ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const MAX_RESPONSE_BYTES = 256 * 1024;
const ERRORS = {
  GOOGLE_NOT_CONFIGURED:'Google 授权适配器未配置',
  GOOGLE_AUTHORIZATION_MISSING:'Google 账号没有可用授权',
  INSPECTION_FORBIDDEN:'Google 未授予此 property 的 URL Inspection 访问权',
  INSPECTION_QUOTA:'Google URL Inspection 配额已用完',
  INSPECTION_TIMEOUT:'Google URL Inspection 检查超时',
  INSPECTION_INVALID_REQUEST:'Google 拒绝了检查参数，请复核 URL 与 property',
  INSPECTION_RESPONSE_INVALID:'Google 检查响应格式无效',
  INSPECTION_RESPONSE_LIMIT:'Google 检查响应超过大小上限',
  INSPECTION_NETWORK:'Google URL Inspection 网络请求失败',
  INSPECTION_UNAVAILABLE:'Google URL Inspection 服务暂不可用',
};
function inspectionError(code,httpStatus=null) {
  return Object.assign(new Error(ERRORS[code]||'Google URL Inspection 检查失败'),{
    code,...(httpStatus===null?{}:{http_status:httpStatus}),definitive:true,
  });
}
async function readJson(response) {
  const length=Number(response.headers?.get('content-length'));
  if(Number.isFinite(length)&&length>MAX_RESPONSE_BYTES)throw inspectionError('INSPECTION_RESPONSE_LIMIT');
  const reader=response.body?.getReader();
  if(!reader)throw inspectionError('INSPECTION_RESPONSE_INVALID');
  const chunks=[];let size=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>MAX_RESPONSE_BYTES){await reader.cancel().catch(()=>{});throw inspectionError('INSPECTION_RESPONSE_LIMIT');}
      chunks.push(Buffer.from(value));
    }
  }finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}
  catch{throw inspectionError('INSPECTION_RESPONSE_INVALID');}
}
function createInspectionAdapter({getAccessToken,fetchImpl=global.fetch,assertActive=async()=>{}}={}) {
  return async ({accountId,inspectionUrl,siteUrl,languageCode='en-US',signal}) => {
    if(typeof getAccessToken!=='function')throw inspectionError('GOOGLE_NOT_CONFIGURED');
    await assertActive();
    let token;
    try{token=await getAccessToken(accountId);}
    catch(error){await assertActive();if(['STALE_AUTHORIZATION','FORBIDDEN'].includes(error.code))throw error;
      throw inspectionError('GOOGLE_AUTHORIZATION_MISSING');}
    await assertActive();
    if(typeof token!=='string'||!token)throw inspectionError('GOOGLE_AUTHORIZATION_MISSING');
    const timeout=AbortSignal.timeout(15000),requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
    try{
      await assertActive();
      const response=await fetchImpl(ENDPOINT,{method:'POST',redirect:'error',signal:requestSignal,
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        body:JSON.stringify({inspectionUrl,siteUrl,languageCode}),
      });
      await assertActive();
      if(!response.ok){
        const code=response.status===401||response.status===403?'INSPECTION_FORBIDDEN'
          :response.status===429?'INSPECTION_QUOTA':response.status>=500?'INSPECTION_UNAVAILABLE'
            :'INSPECTION_INVALID_REQUEST';
        await response.body?.cancel().catch(()=>{});
        throw inspectionError(code,response.status);
      }
      const data=await readJson(response);await assertActive();return data;
    }catch(error){
      await assertActive();
      if(['STALE_AUTHORIZATION','FORBIDDEN'].includes(error.code)||ERRORS[error.code])throw error;
      throw inspectionError(requestSignal.aborted?'INSPECTION_TIMEOUT':'INSPECTION_NETWORK');
    }
  };
}
module.exports={createInspectionAdapter,inspectionError,ENDPOINT,MAX_RESPONSE_BYTES};
