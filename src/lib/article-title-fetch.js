// article-title-fetch.js —— 出网抓一次标题（有界：浏览器 UA、跟随重定向、8s、前 128KB）
//
// 限制读取字节和重定向次数，避免异常源站占满单次执行资源。
// 返回 { title, via } 或 { error: 稳定码 }——错误码是失败导出的桶：
//   timeout / network / http_<状态码> / redirected_home / error_page / login_wall / no_title …
// 字节上限用流式读取实现，不等整个 body。

const {
  TITLE_FETCH_HEADERS, extractArticleTitle, redirectedTitleToRoot,
} = require('./article-title');

const TITLE_FETCH_TIMEOUT_MS = 8000;
const TITLE_FETCH_MAX_BYTES = 131072; // 128 KB——<head> 在文档最前面

function publicTitleUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || /\.(?:localhost|local|internal|test|invalid)$/.test(host)) return null;
  if (host.includes(':')) {
    const first=parseInt(host.split(':')[0],16);
    // Only IPv6 global unicast can be an article source; local/mapped/documentation ranges are excluded.
    if(!Number.isFinite(first)||(first&0xe000)!==0x2000 || /^2001:(?:db8|0?2|0?10):/i.test(host))return null;
    return url;
  }
  const parts = host.split('.');
  if (parts.every(p => /^\d+$/.test(p))) {
    const [a,b,c] = parts.map(Number);
    if (parts.length!==4 || a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127)
      || (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && b===168)
      || (a===192 && b===0 && [0,2].includes(c)) || (a===192 && b===88 && c===99)
      || (a===198 && [18,19].includes(b)) || (a===198 && b===51 && c===100) || (a===203 && b===0 && c===113)) return null;
  } else if (parts.length<2) return null;
  return url;
}

async function fetchArticleTitle(url, { timeoutMs = TITLE_FETCH_TIMEOUT_MS, requirePublicDns = false, resolveHost } = {}) {
  let response;
  try {
    const signal=AbortSignal.timeout(Math.max(1, Math.min(TITLE_FETCH_TIMEOUT_MS, Math.ceil(timeoutMs))));
    let target=publicTitleUrl(url);
    if(!target)return {error:'unsafe_url'};
    for(let redirects=0;redirects<=5;redirects++) {
      let addresses;
      if(requirePublicDns) {
        const resolver=resolveHost || (async(host)=>require('node:dns/promises').lookup(host,{all:true}));
        try {
          signal.throwIfAborted();
          addresses=await new Promise((resolve,reject)=>{
            const abort=()=>reject(signal.reason);
            signal.addEventListener('abort',abort,{once:true});
            Promise.resolve().then(()=>resolver(target.hostname.replace(/^\[|\]$/g,'')))
              .then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
          });
        } catch { return {error:signal.aborted?'timeout':'dns_unavailable'}; }
        if(!addresses?.length || addresses.some(address=>{const ip=typeof address==='string'?address:address.address;
          return typeof ip!=='string' || !require('node:net').isIP(ip) || !publicTitleUrl(`https://${ip.includes(':')?`[${ip}]`:ip}/`);}))
          return {error:redirects?'unsafe_redirect':'unsafe_url'};
      }
      response = requirePublicDns
        ? await require('./pinned-title-request').pinnedTitleRequest(target,addresses,{headers:{...TITLE_FETCH_HEADERS,'Accept-Encoding':'identity'},signal})
        : await fetch(target.href, {headers:TITLE_FETCH_HEADERS,redirect:'manual',signal});
      if(![301,302,303,307,308].includes(response.status))break;
      await response.body?.cancel().catch(()=>{});
      const location=response.headers.get('location');
      if(!location)return {error:'redirect_without_location'};
      if(redirects===5)return {error:'too_many_redirects'};
      target=publicTitleUrl(new URL(location,target).href);
      if(!target)return {error:'unsafe_redirect'};
    }
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { error: 'timeout' };
    return { error: 'network' };
  }
  let responseError = !response.ok ? `http_${response.status}` : null;
  if (!responseError && redirectedTitleToRoot(url, response.url)) responseError = 'redirected_home';
  if (!responseError && response.url) {
    const finalPath = new URL(response.url).pathname;
    if (/\/(?:404|403|not-found|page-not-found|whoops|error)(?:\.html?)?\/?$/i.test(finalPath)) responseError = 'error_page';
    if (/\/(?:login|log-in|signin|sign-in)(?:\.html?)?\/?$/i.test(finalPath)) responseError = 'login_wall';
  }
  if (responseError) {
    await response.body?.cancel().catch(() => {});
    return { error: responseError };
  }
  try {
    const contentType = response.headers.get('content-type');
    const bytes = await readTitleBytes(response);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const headerCharset = /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType || ''))?.[1];
    const decoded = headerCharset && headerCharset.toLowerCase() !== 'utf-8'
      ? decodeWith(headerCharset, bytes)
      : html;
    return extractArticleTitle(decoded, { url });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { error: 'timeout' };
    return { error: 'network' };
  }
}

// 读到上限立即取消流，避免大文件或无限流占满内存。
async function readTitleBytes(response) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < TITLE_FETCH_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, TITLE_FETCH_MAX_BYTES - size);
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function decodeWith(label, bytes) {
  try { return new TextDecoder(label, { fatal: false }).decode(bytes); }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
}

module.exports = { fetchArticleTitle, publicTitleUrl, TITLE_FETCH_TIMEOUT_MS, TITLE_FETCH_MAX_BYTES };
