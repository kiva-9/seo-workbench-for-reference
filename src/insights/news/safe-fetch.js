const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const {isIP} = require('node:net');

const FETCH_LIMITS = Object.freeze({timeout_ms:10000,max_bytes:1024*1024,max_redirects:3});
const REDIRECTS = new Set([301,302,303,307,308]);

function newsError(code) { return Object.assign(new Error(code), {code}); }

function ipv4Number(address) {
  return address.split('.').reduce((value,part)=>value*256+Number(part),0);
}

function ipv6Number(address) {
  let value=address.toLowerCase();
  if(value.includes('.')){
    const lastColon=value.lastIndexOf(':'),v4=ipv4Number(value.slice(lastColon+1));
    value=value.slice(0,lastColon+1)+Math.floor(v4/65536).toString(16)+':'+(v4%65536).toString(16);
  }
  const parts=value.split('::'),left=parts[0]?parts[0].split(':'):[],right=parts[1]?parts[1].split(':'):[];
  const words=parts.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left;
  return words.reduce((result,word)=>(result<<16n)+BigInt(parseInt(word,16)),0n);
}

function inV4Range(value,address,bits) {
  const size=2**(32-bits),start=ipv4Number(address);
  return value>=start&&value<start+size;
}

function inV6Range(value,address,bits) {
  return value>>BigInt(128-bits)===ipv6Number(address)>>BigInt(128-bits);
}

function isPublicAddress(raw) {
  if(typeof raw!=='string'||raw.includes('%'))return false;
  const address=raw.replace(/^\[|\]$/g,''),family=isIP(address);
  if(family===4){
    const value=ipv4Number(address);
    if(address==='168.63.129.16')return false;
    return ![
      ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
      ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],
      ['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],
      ['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],
    ].some(([start,bits])=>inV4Range(value,start,bits));
  }
  if(family===6){
    const value=ipv6Number(address);
    // Only native global unicast is usable; this also excludes mapped and transition addresses.
    return inV6Range(value,'2000::',3)&&![
      ['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20],
    ].some(([start,bits])=>inV6Range(value,start,bits));
  }
  return false;
}

function checkedUrl(raw) {
  let url;
  try { url=new URL(raw); } catch { throw newsError('NEWS_URL_BLOCKED'); }
  const expectedPort=url.protocol==='https:'?'443':url.protocol==='http:'?'80':null;
  const hostname=url.hostname.replace(/^\[|\]$/g,'').toLowerCase().replace(/\.$/,'');
  if(!expectedPort||url.username||url.password||(url.port&&url.port!==expectedPort)||
    !hostname||hostname==='localhost'||/\.(?:localhost|local|internal)$/.test(hostname)||
    (isIP(hostname)?!isPublicAddress(hostname):!hostname.includes('.'))){
    throw newsError('NEWS_URL_BLOCKED');
  }
  url.hash='';
  return url;
}

function aborted(signal) {
  if(signal.aborted)throw newsError('NEWS_TIMEOUT');
}

function withinDeadline(promise,signal) {
  aborted(signal);
  return new Promise((resolve,reject)=>{
    const onAbort=()=>reject(newsError('NEWS_TIMEOUT'));
    signal.addEventListener('abort',onAbort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',onAbort));
  });
}

function pinnedLookup(address,family) {
  return (_host,options,callback)=>{
    if(typeof options==='function'){callback=options;options={};}
    if(options?.all)callback(null,[{address,family}]);
    else callback(null,address,family);
  };
}

function nodeTransport({url,address,family,signal,limits}) {
  return new Promise((resolve,reject)=>{
    const parsed=new URL(url),hostname=parsed.hostname.replace(/^\[|\]$/g,'');
    const client=parsed.protocol==='https:'?https:http;
    const request=client.request(parsed,{
      method:'GET',agent:false,family,lookup:pinnedLookup(address,family),signal,maxHeaderSize:8192,
      ...(isIP(hostname)?{}:{servername:hostname}),
      headers:{'User-Agent':'SEO-Workbench-Feed/1.0','Accept':'application/rss+xml, application/atom+xml, application/xml, text/xml','Accept-Encoding':'identity'},
    },response=>{
      if(REDIRECTS.has(response.statusCode)){
        const result={statusCode:response.statusCode,headers:response.headers,body:Buffer.alloc(0)};
        response.destroy();resolve(result);return;
      }
      const contentLength=Number(response.headers['content-length']);
      if(Number.isFinite(contentLength)&&contentLength>limits.max_bytes){response.destroy();reject(newsError('NEWS_RESPONSE_TOO_LARGE'));return;}
      const chunks=[];let size=0;
      response.on('data',chunk=>{
        size+=chunk.length;
        if(size>limits.max_bytes){response.destroy();request.destroy();reject(newsError('NEWS_RESPONSE_TOO_LARGE'));return;}
        chunks.push(chunk);
      });
      response.on('end',()=>resolve({statusCode:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
      response.on('error',reject);
    });
    request.on('error',reject);
    request.end();
  });
}

async function fetchFeed(source,{lookup=dns.lookup.bind(dns),transport=nodeTransport,limits=FETCH_LIMITS,assertActive=async()=>{}}={}) {
  if(source?.approved!==true)throw newsError('NEWS_SOURCE_UNAPPROVED');
  const initial=checkedUrl(source.url),origin=initial.origin;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),limits.timeout_ms);
  let current=initial;
  try{
    for(let redirects=0;;redirects++){
      await assertActive();aborted(controller.signal);
      const hostname=current.hostname.replace(/^\[|\]$/g,'');
      let addresses;
      try{
        addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:
          await withinDeadline(lookup(hostname,{all:true,verbatim:true}),controller.signal);
      }catch(error){if(error.code==='NEWS_TIMEOUT')throw error;throw newsError('NEWS_DNS_FAILED');}
      await assertActive();
      if(!Array.isArray(addresses)||!addresses.length||addresses.some(row=>!isPublicAddress(row.address)||isIP(row.address)!==row.family))throw newsError('NEWS_DNS_BLOCKED');
      const {address,family}=addresses[0];
      await assertActive();
      const result=await withinDeadline(transport({source,url:current.href,address,family,signal:controller.signal,limits,assertActive}),controller.signal);
      await assertActive();aborted(controller.signal);
      if(REDIRECTS.has(result?.statusCode)){
        if(redirects>=limits.max_redirects)throw newsError('NEWS_REDIRECT_LIMIT');
        if(typeof result.headers?.location!=='string'||!result.headers.location.trim())throw newsError('NEWS_REDIRECT_BLOCKED');
        let next;
        try { next=checkedUrl(new URL(result.headers?.location,current).href); } catch { throw newsError('NEWS_REDIRECT_BLOCKED'); }
        if(next.origin!==origin)throw newsError('NEWS_REDIRECT_BLOCKED');
        current=next;continue;
      }
      if(result?.statusCode!==200)throw newsError('NEWS_HTTP_FAILED');
      const encoding=result.headers?.['content-encoding'];
      if(encoding&&String(encoding).toLowerCase()!=='identity')throw newsError('NEWS_RESPONSE_ENCODING');
      if(typeof result.body!=='string'&&!Buffer.isBuffer(result.body))throw newsError('NEWS_RESPONSE_INVALID');
      const body=Buffer.isBuffer(result.body)?result.body:Buffer.from(result.body,'utf8');
      if(body.length>limits.max_bytes)throw newsError('NEWS_RESPONSE_TOO_LARGE');
      return {xml:body.toString('utf8'),url:current.href};
    }
  }catch(error){
    if(controller.signal.aborted)throw newsError('NEWS_TIMEOUT');
    if(error.code?.startsWith('NEWS_')||['STALE_AUTHORIZATION','FORBIDDEN'].includes(error.code))throw error;
    throw newsError('NEWS_NETWORK_FAILED');
  }finally{clearTimeout(timer);controller.abort();}
}

module.exports={FETCH_LIMITS,checkedUrl,isPublicAddress,fetchFeed,pinnedLookup};
