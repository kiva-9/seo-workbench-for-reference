const { BusinessError }=require('../services/mcp-common');

// 后台重试只处理来源失败；事务守卫和资源预算错误保留各自业务错误码。
async function sourceRequest(run) {
  try{return await run();}
  catch(error) {
    if(error instanceof BusinessError)throw error;
    const retryable=/timeout|network|fetch failed|ECONN|http_429|http_5\d\d/i.test(error.message||'')
      || error.status===429 || error.status>=500;
    const failure=new BusinessError('SOURCE_ERROR',String(error.message||error).slice(0,500),{},retryable);
    failure.status=error.status;failure.retry_after_seconds=error.retry_after_seconds;
    throw failure;
  }
}
function sourceResponseError(message,response) {
  const error=new Error(message);error.status=response.status;
  const raw=response.headers?.get?.('retry-after');
  if(raw) {
    const seconds=/^\d+$/.test(raw)?Number(raw):Math.ceil((Date.parse(raw)-Date.now())/1000);
    if(Number.isFinite(seconds)&&seconds>=0)error.retry_after_seconds=Math.min(seconds,86400);
  }
  return error;
}
module.exports={sourceRequest,sourceResponseError};
