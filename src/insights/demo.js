const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
function demoOptions(){
  const dir=process.env.SPM_DATA_DIR;
  if(!dir)throw new Error('合成演示需要独立临时数据目录');
  const real=fs.realpathSync(dir),temp=fs.realpathSync(os.tmpdir());
  if(!real.startsWith(temp+path.sep+'seo-ai-demo-')||!fs.existsSync(path.join(real,'.ai-insights-demo')))throw new Error('仅允许演示脚本创建的临时目录启用合成模式');
  return {adapters:createDemoAdapters(),now:()=> '2026-10-12T04:00:00.000Z'};
}
function createDemoAdapters({baseline=false}={}){
  return {
    synthetic:true,
    model:async({evidence})=>({model:'synthetic-fixture',usage:{input_tokens:0,output_tokens:0,cost:0},output:{summary:'合成演示解读：证据显示值得人工核查的变化，可结合项目推广重点复盘。',evidenceIds:[evidence[0].id],hypotheses:['可能与页面内容或受众需求变化有关，尚未确认原因。'],recommendedChecks:['核对页面修改记录与对应来源口径。'],suggestedActions:['先验证证据，再确定是否调整选题或页面。'],limitations:['这是固定模型响应，用于验证流程，不代表真实模型质量。']}}),
    newsTransport:async({source})=>({statusCode:200,headers:{'content-type':'application/rss+xml'},body:`<?xml version="1.0"?><rss version="2.0"><channel><title>合成行业 feed</title><item><guid>demo-cold-1</guid><title>合成冷链设备推出节能新品</title><link>https://news.demo.test/cold-chain</link><description>冷链、节能与产品设计成为新品讨论重点。此条为合成材料。</description><pubDate>Mon, 12 Oct 2026 00:00:00 GMT</pubDate></item><item><guid>demo-robot-1</guid><title>合成工业机器人应用案例</title><link>https://news.demo.test/robotics</link><description>机器人、自动化与制造产线的应用案例。此条为合成材料。</description><pubDate>Sun, 11 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>`}),
    inspectUrl:async({articleId,inspectionUrl})=>{
      const n=articleId%100;
      if(!baseline&&n===3)throw Object.assign(new Error('合成权限错误'),{code:'INSPECTION_FORBIDDEN'});
      const verdict=baseline?(n===4?'NEUTRAL':'PASS'):(n===1?'NEUTRAL':'PASS');
      return {inspectionResult:{inspectionResultLink:'https://search.google.com/search-console',indexStatusResult:{verdict,coverageState:verdict==='PASS'?'Synthetic indexed':'Synthetic not indexed',googleCanonical:inspectionUrl,userCanonical:inspectionUrl,lastCrawlTime:baseline?'2026-10-09T00:00:00Z':'2026-10-11T00:00:00Z',indexingState:'INDEXING_ALLOWED'}}};
    },
  };
}
module.exports={demoOptions,createDemoAdapters};
