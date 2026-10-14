// server.js —— 服务入口：环境自检 → 打开数据库 → 启动清理与自动备份 → 监听端口 → 安全退出
// 启动后浏览器访问 http://localhost:8477
// 业务代码都在 src/ 下：路由 src/routes、数据库 src/db、Google 抓取 src/google。

// 只支持 CI 和部署使用的 Node 主版本，在读取配置和打开数据库之前检查。
(function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 24) {
    console.error(`\n[启动失败] 需要 Node.js 24.x，当前为 v${process.versions.node}`);
    console.error('请到 https://nodejs.org 安装 Node.js 24 后重试。\n');
    process.exit(1);
  }
})();

const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

// 项目根目录下有 .env 就读进来（有哪些变量见 .env.example）。已经在环境里设置的变量优先，
// .env 不覆盖——部署平台、测试脚本传进来的值不会被本地文件改掉。必须在加载配置之前做。
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(envFile, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const config = require('./src/config');
try { require('./src/services/node-runtime').validateNodeRuntime(config); }
catch (error) { console.error('[启动失败]', error.message); process.exit(1); }
const db = require('./src/db');
const google = require('./src/google')(db);
const cfAccess = require('./src/middleware/cf-access')();
const createApp = require('./src/app');

const app = createApp({ db, google, cfAccess });

// 启动段（清理孤儿 → 自动备份 → 监听）包进 async main：db 层已异步化，
// 备份是同步的所以顺序不变，listen 仍在最后一步，任一步失败进程带着非零码退出。
async function main() {
  const backgroundHeld = config.MAINTENANCE_MODE || config.DEPLOYMENT_HOLD;
  if (!backgroundHeld) {
  // 无检查点的旧任务过期后释放；持久队列在后台启动后自动恢复。
  try {
    const stale = await db.failStaleJobs();
    if (stale) console.log(`[启动清理] ${stale} 个同步任务因服务重启中断，已标记失败`);
  } catch (e) {
    console.error('[启动清理] 同步任务清理失败：', e?.message);
  }

  // 兜住删 URL 时漏清的衍生数据（孤儿指标）
  const orphans = await db.pruneOrphans();
  const orphanTotal = Object.values(orphans).reduce((a, b) => a + b, 0);
  if (orphanTotal) {
    const detail = Object.entries(orphans).filter(([, n]) => n).map(([t, n]) => `${t}: ${n}`).join(', ');
    console.log(`[启动清理] 移除 ${orphanTotal} 条孤儿指标（对应的 URL 已被删除）—— ${detail}`);
  }

  // 启动时自动备份：快照到 data/backups/<时间戳>/。失败不阻断启动。
  try {
    const b = db.backup();
    console.log(`[自动备份] 已保存到 ${b.path}（保留最近 ${b.keep} 份）`);
  } catch (e) {
    console.error('[自动备份] 失败：', e?.message);
  }
  }

  const server = app.listen(config.PORT, config.HOST, () => {
    console.log(`文案工作台已启动: http://localhost:${config.PORT}`);
    console.log('按 Ctrl+C 停止服务');
  });
  const { startLocalBackground } = require('./src/services/local-background');
  const background = backgroundHeld ? {wake(){},stop:()=>Promise.resolve()}
    : startLocalBackground(app.locals.mcpContext);
  app.locals.mcpContext.wakeOperations = background.wake;
  const {startResourceSyncBackground}=require('./src/services/google-resource-sync');
  const resources=backgroundHeld?{wake(){},stop:()=>Promise.resolve()}:startResourceSyncBackground({db,google});
  app.locals.wakeResourceSync=resources.wake;
  const { startArticleSyncBackground } = require('./src/services/article-sync-queue');
  const articles = startArticleSyncBackground(app.locals.articleQueue, { enabled: !backgroundHeld });
  app.locals.articleQueue.wake = articles.wake;

  const {startInsightBackground}=require('./src/insights/background');
  const insights=startInsightBackground(app.locals.insights,{enabled:config.AI_INSIGHTS_ENABLED&&!backgroundHeld,onError:code=>console.error('[AI 见解后台]',code)});
  app.locals.wakeInsights=insights.wake;

  // 先停止新请求和后台认领，让已执行的单元完成后再关闭数据库。
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    const backgroundStopped = Promise.all([background.stop(),resources.stop(),insights.stop(),articles.stop()]);
    console.log(`\n收到 ${signal}，正在安全退出…`);
    server.close(async () => {
      await backgroundStopped;
      db.close();
      console.log('数据已保存，再见。');
      process.exit(0);
    });
    // 兜底：5 秒内没关干净就强制退出，但仍然先落盘
    setTimeout(() => { db.close(); process.exit(0); }, 5000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => console.error('[未处理的 Promise 拒绝]', reason));
main().catch((e) => {
  console.error('[启动失败]', e);
  process.exit(1);
});
