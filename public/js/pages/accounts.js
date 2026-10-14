import {API} from '../api.js';
import {beginPageRender} from '../page-lifecycle.js';

const syncLabels={queued:'等待同步',running:'同步中',succeeded:'目录已同步',partial:'部分同步失败',failed:'同步失败',cancelled:'授权变化，已取消'};
export async function renderAccounts(el) {
  const isCurrent=beginPageRender(el);
  const [accounts,settings]=await Promise.all([API.accounts(),API.settings()]);if(!isCurrent())return;
  const msg=new URLSearchParams(location.hash.split('?')[1]||'').get('msg');
  el.innerHTML=`<div class="page-head"><div><h2>谷歌账号中心</h2><p class="page-desc">连接账号后自动发现可访问的网站，再到候选池确认项目。</p></div>
    <div class="page-actions"><a class="btn" href="#/project-candidates">项目候选</a><button class="btn btn-primary" id="conn-btn" ${settings.clientIdConfigured?'':'disabled'}>＋ 连接谷歌账号</button></div></div>
    ${msg?`<div class="notice notice-ok">${esc(msg)}</div>`:''}
    ${settings.clientIdConfigured?'':`<div class="notice notice-warn">需要先到 <a href="#/settings">设置</a> 填入 Google Cloud 客户端 ID 和密钥，随后即可连接账号并发现资源。</div>`}
    <div class="account-list" id="acc-list">${accounts.length?`<div class="grid">${accounts.map(a=>`<article class="card acc-card"><div class="acc-avatar">${esc(a.email[0].toUpperCase())}</div>
      <div class="info"><div class="email">${esc(a.email)}</div><div class="muted">连接于 ${(a.connected_at||'').slice(0,10)}</div>${a.note?`<div class="acc-note">${esc(a.note)}</div>`:''}
        <div class="resource-summary"><span class="tag tag-gray">GSC ${a.gsc_count}</span><span class="tag tag-gray">GA4 ${a.ga4_count}</span><span class="tag ${a.resource_sync_status==='succeeded'?'tag-green':'tag-amber'}">${syncLabels[a.resource_sync_status]||'目录尚未同步'}</span></div>
        ${a.resource_sync_at?`<div class="hint">目录更新：${esc(a.resource_sync_at.slice(0,19).replace('T',' '))}</div>`:''}</div>
      <div class="acc-actions"><button class="btn btn-sm" data-sync="${a.id}" ${['queued','running'].includes(a.resource_sync_status)?'disabled':''}>${['failed','partial','cancelled'].includes(a.resource_sync_status)?'重试同步':'刷新目录'}</button>
        <button class="btn btn-sm" data-resources="${a.id}">查看资源</button><button class="btn btn-sm" data-note="${a.id}">备注</button><button class="btn btn-sm btn-danger" data-del="${a.id}">断开</button></div></article>`).join('')}</div>`:
      '<div class="card empty"><div class="big">👤</div>还没有连接谷歌账号<p class="muted">授权完成后，资源目录和项目候选会自动生成。</p></div>'}</div>
    <div class="card"><h3>账号与项目权限</h3><ul class="note-list"><li>GSC 和 GA4 可以使用不同的账号。目录同步只发现资源，业务指标沿项目原有流程抓取。</li>
      <li>所有成员均可查看网站候选；认领后默认成为负责人，项目成员可以使用已授予该项目的资源。</li><li>连接者或管理员管理账号。断开时会暂停对应项目来源，项目和历史数据会保留。</li></ul></div>`;
  el.querySelector('#conn-btn').onclick=async()=>{try{const {url}=await API.oauthStart();if(isCurrent())window.open(url,'_blank','noopener');}catch(error){if(isCurrent())toast(error.message,'err');}};
  el.querySelectorAll('[data-sync]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await API.syncAccountResources(button.dataset.sync);if(isCurrent()){toast('资源目录同步已开始','ok');renderAccounts(el);}}catch(error){if(isCurrent()){toast(error.message,'err');button.disabled=false;}}});
  el.querySelectorAll('[data-resources]').forEach(button=>button.onclick=()=>showResources(button.dataset.resources,isCurrent));
  el.querySelectorAll('[data-note]').forEach(button=>button.onclick=()=>{
    const account=accounts.find(a=>a.id===Number(button.dataset.note));
    openModal(`<div class="modal-head"><h3>账号备注 · ${esc(account.email)}</h3><button class="modal-x" onclick="closeModal()">×</button></div><textarea id="acc-note-input" rows="3">${esc(account.note||'')}</textarea><div class="form-actions"><button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" id="acc-note-save">保存</button></div>`);
    const save=document.querySelector('#acc-note-save'),input=document.querySelector('#acc-note-input');save.onclick=async()=>{save.disabled=true;try{await API.updateAccountNote(account.id,input.value.trim());if(!input.isConnected||!isCurrent())return;closeModal();renderAccounts(el);}catch(error){if(input.isConnected){toast(error.message,'err');save.disabled=false;}}};
  });
  el.querySelectorAll('[data-del]').forEach(button=>button.onclick=async()=>{
    try{const impact=await API.accountDisconnectImpact(button.dataset.del);if(!isCurrent())return;
      const details=impact.projects.map(p=>`${esc(p.name)}（${[p.gsc?'GSC':'',p.ga4?'GA4':''].filter(Boolean).join(' / ')||'旧账号引用'}）`).join('<br>');
      confirmDialog('断开 Google 账号',`将暂停 ${impact.projects.length} 个项目的对应来源，保留项目、文章和历史指标。重新连接后可在资源匹配中恢复。${details?`<div class="hint">${details}</div>`:''}`,async()=>{
        try{await API.deleteAccount(button.dataset.del);if(isCurrent()){toast('账号已断开，业务数据已保留','ok');renderAccounts(el);}}catch(error){if(isCurrent())toast(error.message,'err');}
      });
    }catch(error){if(isCurrent())toast(error.message,'err');}
  });
  if(accounts.some(a=>['queued','running'].includes(a.resource_sync_status))){
    let timer;
    const poll=()=>{if(!isCurrent())return;if(document.querySelector('#modal-mask').classList.contains('hidden'))renderAccounts(el);else timer=setTimeout(poll,2000);};
    timer=setTimeout(poll,2000);
    window.addEventListener('seo-route-change',()=>clearTimeout(timer),{once:true});
  }
}
async function showResources(id,isCurrent) {
  try{
    const data=await API.accountResources(id);if(!isCurrent())return;
    openModal(`<div class="modal-head"><h3>账号资源目录</h3><button class="modal-x" onclick="closeModal()">×</button></div>
      <p class="hint">${data.job?syncLabels[data.job.status]:'尚未同步'} · ${data.resources.filter(r=>r.state==='available').length} 个可用资源</p>
      ${data.sources.filter(s=>s.last_error).map(s=>`<div class="notice notice-warn account-sync-error">${s.source.toUpperCase()}：${esc(s.last_error)}。已保留最后成功的目录，可关闭后重试同步。</div>`).join('')}
      ${data.resources.length?data.resources.map(r=>`<div class="resource-catalog-row"><strong>${r.source.toUpperCase()} · ${esc(r.display_name||r.resource_key)} <span class="tag ${r.state==='available'?'tag-green':'tag-red'}">${r.state==='available'?'可访问':'已移除'}</span></strong>
        <div class="muted">${esc(r.resource_key)}${r.permission_level?' · '+esc(r.permission_level):''}</div><div class="muted">${esc(r.scope_note)}</div>
        <div class="resource-hosts">${r.hostnames.map(h=>`<a class="tag tag-blue" href="#/project-candidates?status=all&q=${encodeURIComponent(h)}" onclick="closeModal()">${esc(h)}</a>`).join(' ')}${!r.hostnames.length?'<span class="muted">未发现网站地址，可在项目资源匹配中人工选择。</span>':''}</div>
        ${r.stream_state==='error'?'<div class="hint">数据流读取失败，保留上次网站信息。</div>':''}</div>`).join(''):'<div class="empty">目录为空。请刷新目录，或检查 Google 账号的资源权限。</div>'}
      <div class="form-actions"><button class="btn" onclick="closeModal()">关闭</button><a class="btn btn-primary" href="#/project-candidates" onclick="closeModal()">前往项目候选</a></div>`);
  }catch(error){if(isCurrent())toast(error.message,'err');}
}
