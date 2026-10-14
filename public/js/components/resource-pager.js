// 搜索和翻页只替换当前页；已读资源身份独立保留，选择不会因筛选改变。
export function createResourcePager({resources,pages,loadPage,isActive=()=>true,onChange=()=>{}}) {
  const byId=new Map(resources.map(row=>[row.id,row]));
  const states=Object.fromEntries(Object.entries(pages).map(([source,info])=>[source,{...info,q:'',loading:false,error:null,revision:0}]));
  async function load(source,{q=states[source].q,page=1}={},delay=0) {
    const state=states[source],revision=++state.revision;
    state.controller?.abort();
    const controller=state.controller=new AbortController();
    if(q!==state.q)state.ids=[];
    state.q=q;state.requested_page=page;state.loading=true;state.error=null;
    onChange(source);
    const active=()=>isActive()&&revision===state.revision;
    try {
      if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
      if(!active())return;
      const result=await loadPage({source,q,page,page_size:state.page_size},{signal:controller.signal});
      if(!active())return;
      for(const resource of result.items)byId.set(resource.id,resource);
      Object.assign(state,{ids:result.items.map(r=>r.id),total:result.total,page:result.page});
    }catch(error){if(active()&&error.name!=='AbortError')state.error=error.message;}
    finally{if(active()){state.loading=false;onChange(source);}}
  }
  return {byId,states,load};
}
