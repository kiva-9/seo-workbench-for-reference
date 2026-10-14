// 仅在内存中复用同一身份的短期读取；失效前发出的响应不能重新填充缓存。
export function createReadCache({ttl=30_000,limit=40,now=Date.now}={}) {
  const entries=new Map();
  let identity=null,generation=0,writes=0,settled=Promise.resolve(),releaseWrites;
  const clone=value=>structuredClone(value);
  const staleIdentity=()=>new DOMException('登录身份已变化，请重新读取','AbortError');
  function clear() {
    generation++;
    for(const entry of entries.values())entry.controller?.abort();
    entries.clear();
  }
  function peek(key) {
    const entry=entries.get(key);
    return identity!==null&&!writes&&entry?.expires>now()?clone(entry.data):null;
  }
  async function load(key,fetcher) {
    const owner=identity;
    while(writes)await settled;
    if(owner!==identity)throw staleIdentity();
    // 启动时尚未确认身份的请求不进入共享缓存。
    if(identity===null)return fetcher({});
    const value=peek(key);
    if(value!==null)return value;
    let entry=entries.get(key);
    if(!entry?.promise){
      const version=generation,controller=new AbortController();
      entry={controller};
      entry.promise=Promise.resolve().then(()=>fetcher({signal:controller.signal})).then(data=>{
        if(owner!==identity)throw staleIdentity();
        if(version!==generation)return load(key,fetcher);
        if(entries.get(key)===entry){entry.data=data;entry.expires=now()+ttl;delete entry.promise;delete entry.controller;}
        return data;
      },error=>{
        if(owner!==identity)throw staleIdentity();
        if(version!==generation)return load(key,fetcher);
        if(entries.get(key)===entry)entries.delete(key);
        throw error;
      });
      entries.delete(key);entries.set(key,entry);
      if(entries.size>limit)entries.delete(entries.keys().next().value);
    }
    const version=generation,data=await entry.promise;
    if(owner!==identity)throw staleIdentity();
    if(version!==generation||writes)return load(key,fetcher);
    return clone(data);
  }
  return {
    peek,load,clear,
    setIdentity(user){
      const next=user?JSON.stringify([user.id,user.role]):null;
      if(next!==identity){identity=next;clear();}
    },
    beginWrite({blockReads=true}={}){
      if(blockReads&&writes++===0)settled=new Promise(resolve=>releaseWrites=resolve);
      clear();let ended=false;
      return ()=>{if(ended)return;ended=true;clear();if(blockReads&&--writes===0)releaseWrites();};
    },
  };
}
