// config.js —— 服务端配置：全部来自环境变量，不设就是本机单用户的默认值
//
// 数据目录（SPM_DATA_DIR）刻意不在这里读，见 src/db/connection.js：
// 测试要先设好环境变量再加载数据库，放在这里会被更早的 import 提前固定成真实数据目录。

const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

const CF_ACCESS_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN || '';
const CF_ACCESS_AUD = process.env.CF_ACCESS_AUD || '';
const DEPLOYMENT_HOLD = process.env.DEPLOYMENT_HOLD === 'true';

module.exports = {
  DEPLOYMENT_HOLD,
  MCP_ENABLED: process.env.MCP_ENABLED !== 'false',
  MCP_PHASE: Math.min(3, Math.max(1, Number(process.env.MCP_PHASE) || 1)),
  MCP_BACKGROUND_ENABLED: process.env.MCP_BACKGROUND_ENABLED === 'true',
  AI_INSIGHTS_ENABLED: process.env.AI_INSIGHTS_ENABLED !== 'false',
  AI_EXTERNAL_ENABLED: !DEPLOYMENT_HOLD && process.env.AI_EXTERNAL_ENABLED === 'true',
  AI_SCHEDULE_ENABLED: !DEPLOYMENT_HOLD && process.env.AI_SCHEDULE_ENABLED === 'true',
  AI_DEMO_MODE: process.env.AI_DEMO_MODE === 'true',
  AI_MODEL_KEY: process.env.AI_MODEL_KEY || '',
  AI_MODEL_NAME: process.env.AI_MODEL_NAME || '',
  AI_MODEL_ENDPOINT: process.env.AI_MODEL_ENDPOINT || 'https://api.openai.com/v1/chat/completions',
  AI_MODEL_INPUT_RATE: process.env.AI_MODEL_INPUT_RATE ? Number(process.env.AI_MODEL_INPUT_RATE) : null,
  AI_MODEL_OUTPUT_RATE: process.env.AI_MODEL_OUTPUT_RATE ? Number(process.env.AI_MODEL_OUTPUT_RATE) : null,
  AI_MODEL_CALL_CEILING: Number(process.env.AI_MODEL_CALL_CEILING || 0),
  ROOT_DIR,
  PUBLIC_DIR: path.join(ROOT_DIR, 'public'),

  // 端口可用 PORT 覆盖（默认 8477），便于同时起第二个实例。
  // 注意：OAuth 回调地址跟着实际端口走，Google Cloud 里登记的重定向 URI 也要一致。
  PORT: process.env.PORT ? Number(process.env.PORT) : 8477,
  HOST: process.env.HOST || '127.0.0.1',
  DEPLOYMENT_SHA: process.env.DEPLOYMENT_SHA || '',
  BACKUP_INTERVAL_HOURS: Number(process.env.BACKUP_INTERVAL_HOURS || 24),
  MAINTENANCE_MODE: process.env.SPM_MAINTENANCE_MODE === 'true',

  // 经反向代理部署到域名时，把域名加进 Host / Origin 白名单；不设就只接受本机访问
  PUBLIC_HOST: process.env.PUBLIC_HOST || '',

  // Cloudflare Access 团队域名 + Application Audience：两个都配了才启用团队模式
  // （身份来自 Cloudflare Access），否则是本机单用户模式。
  // 这是安全边界的引导配置，必须在应用第一次能从公网访问之前配好，所以只走环境变量、不走网页设置。
  CF_ACCESS_TEAM_DOMAIN,
  CF_ACCESS_AUD,
  CF_ACCESS_ENABLED: Boolean(CF_ACCESS_TEAM_DOMAIN && CF_ACCESS_AUD),
  // 单用户模式下所有请求都记在这个固定用户名下
  LOCAL_USER_EMAIL: 'local@localhost',

  // 批量抓取（抓取全部项目 / 反查全部外链 / 全部快照）时并行处理的项目数
  // （Google 配额很宽松，主要是别一次打太多）
  FETCH_CONCURRENCY: 3,
};
