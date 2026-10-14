const {randomUUID} = require('node:crypto');
const {withAtomicGuard} = require('../lib/atomic-guard');
const {refreshProjectCandidates} = require('./resource-catalog');

const ACTIVE = "status IN ('queued','running')";
function syncError(status,message) { return Object.assign(new Error(message),{status}); }
function publicResourceJob(job) {
  if (!job) return null;
  const cursor = JSON.parse(job.cursor_json);
  return {id:job.id,account_id:job.account_id,status:job.status,phase:cursor.phase||'gsc',units_done:job.units_done,
    errors:JSON.parse(job.errors_json),created_at:job.created_at,updated_at:job.updated_at,finished_at:job.finished_at};
}
async function enqueueResourceSync(db,accountId,userId) {
  const account = await db.getAccount(accountId);
  const actor = await db.getUser(userId);
  if (!account) throw syncError(404,'账号不存在');
  if (!actor||(actor.role!=='admin'&&account.owner_user_id!==userId)) throw syncError(403,'无权刷新此账号');
  const at = new Date().toISOString();
  const id = randomUUID();
  await db.db.batchAtomic(withAtomicGuard(db.db,[
    db.db.prepare(`UPDATE google_resource_sync_jobs SET status='cancelled',finished_at=?,updated_at=?,lease_token=NULL,lease_until=NULL
      WHERE account_id=? AND auth_revision<>? AND ${ACTIVE}`).bind(at,at,accountId,account.auth_revision),
    db.db.prepare(`INSERT INTO google_resource_sync_jobs(id,account_id,requested_by,auth_revision,cursor_json,created_at,updated_at)
      SELECT ?,?,?,?,'{"phase":"gsc"}',?,? WHERE NOT EXISTS(SELECT 1 FROM google_resource_sync_jobs WHERE account_id=? AND ${ACTIVE})`).bind(id,accountId,userId,account.auth_revision,at,at,accountId),
  ],'SELECT EXISTS(SELECT 1 FROM google_accounts a JOIN users u ON u.id=? AND u.deleted_at IS NULL WHERE a.id=? AND a.auth_revision=? AND (u.role=\'admin\' OR a.owner_user_id=u.id))',[userId,accountId,account.auth_revision]));
  return publicResourceJob(await db.getActiveResourceSyncJob(accountId));
}

function catalogUpsert(backend,job,source,rows,at) {
  return backend.prepare(`INSERT INTO google_resources(account_id,source,resource_key,display_name,account_display_name,permission_level,stream_state,generation,last_seen_at)
    SELECT ?,?,json_extract(value,'$.resource_key'),COALESCE(json_extract(value,'$.display_name'),''),COALESCE(json_extract(value,'$.account_display_name'),''),
      COALESCE(json_extract(value,'$.permission_level'),''),?, ?,? FROM json_each(?) WHERE 1
    ON CONFLICT(account_id,source,resource_key) DO UPDATE SET display_name=excluded.display_name,account_display_name=excluded.account_display_name,
      permission_level=excluded.permission_level,state='available',stream_state=excluded.stream_state,revision=google_resources.revision+1,generation=excluded.generation,last_seen_at=excluded.last_seen_at`).bind(job.account_id,source,source==='gsc'?'complete':'pending',job.id,at,JSON.stringify(rows));
}
function domainsInsert(backend,resourceId,domains) {
  return backend.prepare(`INSERT INTO google_resource_domains(resource_id,stream_key,stream_type,website,hostname)
    SELECT ?,json_extract(value,'$.stream_key'),json_extract(value,'$.stream_type'),COALESCE(json_extract(value,'$.website'),''),COALESCE(json_extract(value,'$.hostname'),'') FROM json_each(?) WHERE 1
    ON CONFLICT(resource_id,stream_key) DO UPDATE SET stream_type=excluded.stream_type,website=excluded.website,hostname=excluded.hostname`).bind(resourceId,JSON.stringify(domains));
}
function nextToken(cursor,next) {
  const seen=cursor.tokens||[];
  if (next&&(seen.includes(next)||seen.length>=1000)) throw new Error('Google 分页游标重复或超出目录上限，请重试');
  cursor.tokens=next?[...seen,next]:[];
  cursor.pageToken=next||'';
}

async function runResourceSyncUnit({db,google}) {
  const backend = db.db;
  const now = new Date();
  const at=now.toISOString();
  // 过期授权的任务先终止，避免旧运行占住每账号唯一活动位置。
  await backend.prepare(`UPDATE google_resource_sync_jobs SET status='cancelled',finished_at=?,updated_at=?,lease_token=NULL,lease_until=NULL
    WHERE ${ACTIVE} AND NOT EXISTS(SELECT 1 FROM google_accounts a JOIN users u ON u.id=google_resource_sync_jobs.requested_by AND u.deleted_at IS NULL
      WHERE a.id=account_id AND a.auth_revision=google_resource_sync_jobs.auth_revision AND (u.role='admin' OR a.owner_user_id=u.id))`).run(at,at);
  const job=await backend.prepare(`SELECT * FROM google_resource_sync_jobs WHERE ${ACTIVE} AND (lease_until IS NULL OR lease_until<=?) ORDER BY created_at,id LIMIT 1`).get(at);
  if (!job) return false;
  const lease=randomUUID();
  const acquired=await backend.prepare(`UPDATE google_resource_sync_jobs SET status='running',lease_token=?,lease_until=?,updated_at=?
    WHERE id=? AND ${ACTIVE} AND (lease_until IS NULL OR lease_until<=?)`).run(lease,new Date(now.getTime()+60000).toISOString(),at,job.id,at);
  if (!acquired.changes) return false;
  const cursor=JSON.parse(job.cursor_json);
  let errors=JSON.parse(job.errors_json);
  const phase=cursor.phase||'gsc';
  const writes=[];
  let terminal=false;
  try {
    if (phase==='gsc') {
      const rows=await google.discoverGscSites(job.account_id);
      writes.push(catalogUpsert(backend,job,'gsc',rows,at));
      // 目录身份作为 JSON 集合绑定，一次校验全部所选资源。
      writes.push(backend.prepare(`DELETE FROM google_resource_domains WHERE resource_id IN (SELECT id FROM google_resources WHERE account_id=? AND source='gsc' AND generation=?)`).bind(job.account_id,job.id));
      writes.push(backend.prepare(`INSERT INTO google_resource_domains(resource_id,stream_key,stream_type,website,hostname)
        SELECT r.id,json_extract(d.value,'$.stream_key'),json_extract(d.value,'$.stream_type'),json_extract(d.value,'$.website'),json_extract(d.value,'$.hostname')
        FROM json_each(?) x JOIN google_resources r ON r.account_id=? AND r.source='gsc' AND r.resource_key=json_extract(x.value,'$.resource_key')
        JOIN json_each(x.value,'$.domains') d`).bind(JSON.stringify(rows),job.account_id));
      writes.push(backend.prepare("UPDATE google_resources SET state='removed' WHERE account_id=? AND source='gsc' AND generation<>?").bind(job.account_id,job.id));
      cursor.gscOk=true;cursor.phase='properties';
      writes.push(backend.prepare(`INSERT INTO google_resource_sync_sources(account_id,source,last_success_at,last_error) VALUES (?,'gsc',?,NULL)
        ON CONFLICT(account_id,source) DO UPDATE SET last_success_at=excluded.last_success_at,last_error=NULL`).bind(job.account_id,at));
    } else if (phase==='properties') {
      const page=await google.discoverGa4PropertiesPage(job.account_id,cursor.pageToken||'');
      nextToken(cursor,page.nextPageToken);
      writes.push(catalogUpsert(backend,job,'ga4',page.resources,at));
      if (!page.nextPageToken) {
        writes.push(backend.prepare("UPDATE google_resources SET state='removed' WHERE account_id=? AND source='ga4' AND generation<>?").bind(job.account_id,job.id));
        cursor.ga4Ok=true;cursor.phase='streams';cursor.afterResourceId=0;
      }
    } else if (phase==='streams') {
      const property=await backend.prepare("SELECT id,resource_key FROM google_resources WHERE account_id=? AND source='ga4' AND generation=? AND id>? ORDER BY id LIMIT 1").get(job.account_id,job.id,cursor.afterResourceId||0);
      if (!property) { terminal=true;cursor.phase='done'; }
      else {
        const page=await google.discoverGa4StreamsPage(job.account_id,property.resource_key,cursor.pageToken||'');
        nextToken(cursor,page.nextPageToken);
        cursor.streams=[...(cursor.streams||[]),...page.streams];
        if(cursor.streams.length>5000||JSON.stringify(cursor.streams).length>1000000) throw new Error('GA4 数据流目录过大，请缩小资源范围');
        if(!page.nextPageToken) {
          writes.push(backend.prepare('DELETE FROM google_resource_domains WHERE resource_id=?').bind(property.id));
          writes.push(domainsInsert(backend,property.id,cursor.streams));
          const state=cursor.streams.some(s=>s.hostname)?'complete':cursor.streams.some(s=>s.stream_type==='WEB_DATA_STREAM')?'no_website':'app_only';
          writes.push(backend.prepare('UPDATE google_resources SET stream_state=?,revision=revision+1 WHERE id=?').bind(state,property.id));
          cursor.afterResourceId=property.id;delete cursor.streams;
        }
      }
    } else { throw new Error('目录任务阶段无效'); }
    cursor.retries=0;
  } catch(error) {
    if(error.transient&&(cursor.retries||0)<3) {
      cursor.retries=(cursor.retries||0)+1;
      await commitUnit(db,job,lease,[],cursor,errors,'queued',new Date(Date.now()+1000*2**cursor.retries).toISOString());
      return true;
    }
    const source=phase==='gsc'?'gsc':'ga4';
    // 只存可读的错误，不存请求体、令牌或 Google 原始响应。
    const message=error.name==='TimeoutError'||error.name==='AbortError'?'Google 目录请求超时，请重试':String(error.message||'目录同步失败').slice(0,300);
    errors=[...errors,{source,phase,message}];
    writes.push(backend.prepare(`INSERT INTO google_resource_sync_sources(account_id,source,last_error) VALUES (?,?,?)
      ON CONFLICT(account_id,source) DO UPDATE SET last_error=excluded.last_error`).bind(job.account_id,source,message));
    if(phase==='gsc') cursor.phase='properties';
    else if(phase==='properties') {terminal=true;cursor.phase='done';}
    else {
      const property=await backend.prepare("SELECT id FROM google_resources WHERE account_id=? AND source='ga4' AND generation=? AND id>? ORDER BY id LIMIT 1").get(job.account_id,job.id,cursor.afterResourceId||0);
      if(property){writes.push(backend.prepare("UPDATE google_resources SET stream_state='error',revision=revision+1 WHERE id=?").bind(property.id));cursor.afterResourceId=property.id;}
      else terminal=true;
    }
    cursor.pageToken='';cursor.tokens=[];cursor.retries=0;delete cursor.streams;
  }
  if(terminal&&cursor.ga4Ok&&!errors.some(e=>e.source==='ga4'))writes.push(backend.prepare(`INSERT INTO google_resource_sync_sources(account_id,source,last_success_at,last_error) VALUES (?,'ga4',?,NULL)
    ON CONFLICT(account_id,source) DO UPDATE SET last_success_at=excluded.last_success_at,last_error=NULL`).bind(job.account_id,at));
  const status=terminal?(errors.length?(cursor.gscOk||cursor.ga4Ok?'partial':'failed'):'succeeded'):'queued';
  const committed=await commitUnit(db,job,lease,writes,cursor,errors,status);
  if(committed&&terminal)await refreshProjectCandidates(db);
  return true;
}

async function commitUnit(db,job,lease,writes,cursor,errors,status,retryAt=null) {
  const backend=db.db,at=new Date().toISOString();
  const finished=['succeeded','partial','failed'].includes(status)?at:null;
  writes.push(backend.prepare(`UPDATE google_resource_sync_jobs SET cursor_json=?,errors_json=?,status=?,units_done=units_done+1,lease_token=NULL,lease_until=?,updated_at=?,finished_at=? WHERE id=?`).bind(JSON.stringify(cursor),JSON.stringify(errors),status,retryAt,at,finished,job.id));
  try {
    await backend.batchAtomic(withAtomicGuard(backend,writes,`SELECT EXISTS(SELECT 1 FROM google_resource_sync_jobs j JOIN google_accounts a ON a.id=j.account_id JOIN users u ON u.id=j.requested_by AND u.deleted_at IS NULL
      WHERE j.id=? AND j.lease_token=? AND j.status='running' AND j.lease_until>? AND a.auth_revision=j.auth_revision AND (u.role='admin' OR a.owner_user_id=u.id))`,[job.id,lease,at]));
    return true;
  } catch(error) {
    if(/CHECK constraint failed/.test(error.message))return false;
    throw error;
  }
}

function startResourceSyncBackground(context) {
  let stopping=false,running=null,timer=null;
  const schedule=(delay=2000)=>{if(stopping)return;clearTimeout(timer);timer=setTimeout(tick,delay);timer.unref();};
  const tick=async()=>{
    if(stopping||running)return;
    running=runResourceSyncUnit(context);
    try {const worked=await running;schedule(worked?25:2000);}
    catch {schedule(3000);console.error('[资源目录] 后台单元失败，将在租约到期后恢复');}
    finally {running=null;}
  };
  schedule(25);
  return {wake(){if(!running)schedule(0);},async stop(){stopping=true;clearTimeout(timer);if(running)await running;}};
}
module.exports={enqueueResourceSync,runResourceSyncUnit,startResourceSyncBackground,publicResourceJob};
