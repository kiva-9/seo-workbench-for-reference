// Always create a new temporary database; existing business data is never an input.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'seo-ai-demo-'));
fs.writeFileSync(path.join(dir,'.ai-insights-demo'),'synthetic-only\n',{mode:0o600});
Object.assign(process.env,{SPM_DATA_DIR:dir,AI_DEMO_MODE:'true',AI_EXTERNAL_ENABLED:'false',AI_SCHEDULE_ENABLED:'false',AI_INSIGHTS_ENABLED:'true',AI_MODEL_KEY:'',AI_MODEL_NAME:'',MCP_BACKGROUND_ENABLED:'false',CF_ACCESS_TEAM_DOMAIN:'',CF_ACCESS_AUD:'',PUBLIC_HOST:'',HOST:'127.0.0.1'});
const db=require('../src/db');
const {parseSettings}=require('../src/insights/contracts');
const {createInsights}=require('../src/insights');
const {createDemoAdapters}=require('../src/insights/demo');
const {buildArticleFingerprints}=require('../src/lib/article-fingerprint');
async function seed(){
  await db.db.prepare("INSERT INTO users(id,email,role,name) VALUES(1,'local@localhost','member','演示使用者'),(2,'private@demo.test','member','隔离账号')").run();
  await db.db.prepare("INSERT INTO google_accounts(id,email,refresh_token,owner_user_id,connected_at) VALUES(1,'synthetic@demo.test','synthetic-never-used',1,'2026-10-01')").run();
  for(const [pid,name,domain]of [[1,'北岸冷链 · 合成演示','cold.demo.test'],[2,'远山机器人 · 合成演示','robot.demo.test'],[3,'隔离项目 · 不应可见','private.demo.test']]){
    await db.db.prepare("INSERT INTO google_resources(account_id,source,resource_key,permission_level,stream_state,generation,last_seen_at) VALUES(1,'gsc',?,'siteOwner','complete','synthetic','2026-10-12')").run('sc-domain:'+domain);
    await db.db.prepare('INSERT INTO projects(id,name,website,gsc_site,gsc_account_id,ga4_account_id,ga4_property_id,owner_user_id,created_at) VALUES(?,?,?,?,1,1,?,?,?)').run(pid,name,'https://'+domain,'sc-domain:'+domain,'properties/'+pid,pid===3?2:1,'2026-01-01');
    const project=await db.getProject(pid),fps=buildArticleFingerprints(project);
    for(const [n,title,before,after,published]of [[1,'核心指南：成熟文章下滑',100,60,'2026-01-01'],[2,'产品教程：可复盘的增长',100,160,'2026-01-01'],[3,'低样本文章：从零起量',0,5,'2026-01-01'],[4,'新文章：仍需观察',10,15,'2026-09-15'],[5,'等待基线：尚无完整指标',null,null,'2026-01-01'],[6,'标题机会：CTR 回落',100,70,'2026-01-01'],[7,'稳定文章：继续观察',50,53,'2026-01-01']]){
      const id=pid*100+n,url=`https://${domain}/guide-${n}`;
      await db.db.prepare('INSERT INTO project_articles(id,project_id,url,title,published_at,status,metrics_dirty,last_synced_at) VALUES(?,?,?,?,?,\'active\',0,?)').run(id,pid,url,title,published,'2026-10-05T00:00:00Z');
      if(before===null)continue;
      for(const [month,end,clicks]of [['2026-08','2026-08-31',before],['2026-09','2026-09-30',after]]){
        await db.db.prepare(`INSERT INTO project_article_monthly_metrics(article_id,month,month_start,month_end,gsc_clicks,gsc_impressions,gsc_ctr,gsc_position,ga4_pageviews,ga4_key_events,gsc_status,gsc_cover_start,gsc_cover_end,gsc_fetched_at,gsc_finalized,gsc_config_fingerprint,ga4_status,ga4_cover_start,ga4_cover_end,ga4_fetched_at,ga4_finalized,ga4_config_fingerprint,fetch_revision)
          VALUES(?,?,?,?,?,1000,?,8,?,2,'complete',?,?,'2026-10-05T00:00:00Z',1,?,'complete',?,?,'2026-10-05T00:00:00Z',1,?,1)`).run(id,month,month+'-01',end,clicks,clicks/1000,clicks*2,month+'-01',end,fps.gsc,month+'-01',end,fps.ga4);
      }
    }
    const config=parseSettings({background:{industry:pid===1?'冷链设备':'工业机器人',products:'公开合成产品资料',promotion:'节能与应用场景'},keywords:pid===1?['冷链','节能']:['机器人','自动化'],sources:[{id:'demo-feed',name:'合成行业资讯',url:'https://news.demo.test/feed-'+pid+'.xml',approved:true}],model:{enabled:true,data_approved:true,daily_calls:100,daily_cost:10,call_cost_limit:.05}});
    const initial=createInsights({db,google:{},config:{AI_EXTERNAL_ENABLED:false},adapters:createDemoAdapters({baseline:true}),now:()=> '2026-10-10T03:00:00.000Z'});
    await initial.saveSettings(pid,pid===3?2:1,0,config);await initial.enqueue(pid,pid===3?2:1,'indexing');await initial.runOnce();
    const current=createInsights({db,google:{},config:{AI_EXTERNAL_ENABLED:false},adapters:createDemoAdapters(),now:()=> '2026-10-12T04:00:00.000Z'});
    for(const module of ['performance','news','indexing']){await current.enqueue(pid,pid===3?2:1,module);await current.runOnce();}
  }
  if(process.argv.includes('--admin'))await db.db.prepare("UPDATE users SET role='admin' WHERE id=1").run();
  console.log('合成演示已生成；所有模型、RSS、Google 响应来自固定 mock。');console.log('临时数据目录：'+dir);
  const failed=await db.db.prepare("SELECT module,status,error_code FROM ai_insight_runs WHERE status IN ('failed','cancelled','uncertain')").all();if(failed.length)throw new Error('演示任务未完成：'+JSON.stringify(failed));
  db.close();
  if(process.argv.includes('--seed-only'))return;
  if(process.argv.includes('--admin'))console.log('管理员演示模式：可查看所有合成项目并管理模型配置。');
  const port=process.env.PORT||'8588';console.log(`演示入口：http://127.0.0.1:${port}/#/ai-insights`);
  const child=spawn('npm',['run','dev'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:port},stdio:'inherit'});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>{process.exitCode=code||0;});
}
seed().catch(error=>{console.error(error.message);try{db.close();}catch{}process.exitCode=1;});
