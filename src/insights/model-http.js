const https=require('node:https');
const dns=require('node:dns').promises;
const {isIP}=require('node:net');
const {checkedUrl,isPublicAddress,pinnedLookup}=require('./news/safe-fetch');
function blocked(){return Object.assign(new Error('模型服务地址未通过网络校验'),{code:'MODEL_ENDPOINT_BLOCKED',definitive:true});}
async function modelFetch(raw,options,{lookup=dns.lookup,request=https.request}={}){
  let url;try{url=checkedUrl(String(raw));if(url.protocol!=='https:')throw new Error();}catch{throw blocked();}
  const host=url.hostname.replace(/^\[|\]$/g,''),{signal}=options;
  signal?.throwIfAborted();
  let addresses;
  try{addresses=isIP(host)?[{address:host,family:isIP(host)}]:await new Promise((resolve,reject)=>{
    const onAbort=()=>reject(signal.reason);signal?.addEventListener('abort',onAbort,{once:true});
    Promise.resolve(lookup(host,{all:true,verbatim:true})).then(resolve,reject).finally(()=>signal?.removeEventListener('abort',onAbort));
  });}catch(error){if(signal?.aborted)throw error;throw blocked();}
  signal?.throwIfAborted();
  if(!addresses?.length||addresses.some(a=>![4,6].includes(a.family)||!isPublicAddress(a.address)))throw blocked();
  const address=addresses[0];
  await options.beforeSend?.();
  signal?.throwIfAborted();
  // Pin the validated DNS answer while retaining the hostname for TLS and HTTP.
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:options.method,headers:{...options.headers,'Accept-Encoding':'identity'},agent:false,lookup:pinnedLookup(address.address,address.family),family:address.family,...(isIP(host)?{}:{servername:host}),signal,maxHeaderSize:8192},res=>{
      const chunks=[];let size=0;
      if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(new Error('不支持的模型响应压缩'));return;}
      res.on('data',chunk=>{size+=chunk.length;if(size>100000){req.destroy();reject(new Error('模型响应超过上限'));}else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>{
        try{const body=[204,205,304].includes(res.statusCode)?null:Buffer.concat(chunks);resolve(new Response(body,{status:res.statusCode,headers:{'content-type':'application/json'}}));}
        catch{reject(new Error('模型响应状态无效'));}
      });
    });
    req.on('error',reject);req.end(options.body);
  });
}
module.exports={modelFetch};
