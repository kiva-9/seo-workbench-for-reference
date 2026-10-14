const {resourceDto}=require('./resource-catalog');

function pickerResourceDto(row) {
  const resource=resourceDto(row);
  return Object.fromEntries(['id','account_id','source','resource_key','display_name','account_display_name',
    'permission_level','email','hostnames','shared_scope','stream_state'].map(key=>[key,resource[key]]));
}

async function resourcePickerPages(db,hostname,{compact=true,project=null,user=null}={}) {
  const pages={};
  const scope=project?{projectId:project.id,userId:user.id,isAdmin:user.role==='admin'}:{};
  for(const source of ['ga4','gsc'])pages[source]=await db.searchResourcePage({hostname,source,pageSize:25,...scope});
  // 唯一匹配的可用来源可能位于同名账号列表的后面，单独补入，不能误选首屏。
  const all=Object.values(pages).flatMap(p=>p.items),seen=new Set(all.map(r=>r.id));
  if(project){
    // 现有来源可能不匹配域名或位于尾页；仍按同一权限范围补回，不能预选推荐值。
    all.push(...(await db.projectCurrentResourceChoices(project.id,user.id,user.role==='admin')).filter(r=>!seen.has(r.id)));
  }else{
    const missing=Object.values(pages).map(p=>p.recommended_id).filter(id=>id&&!seen.has(id));
    if(missing.length)all.push(...await db.resourcesByIds(missing));
  }
  return {resources:all.map(compact?pickerResourceDto:resourceDto),resource_pages:Object.fromEntries(Object.entries(pages)
    .map(([source,{items,...meta}])=>[source,{...meta,ids:items.map(r=>r.id)}]))};
}

module.exports={pickerResourceDto,resourcePickerPages};
