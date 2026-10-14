// 在打开数据库之前校验网络部署，避免配置遗漏时以本地默认账号对外提供业务。
function validateNodeRuntime(config) {
  if (!Number.isInteger(config.PORT) || config.PORT < 1 || config.PORT > 65535) throw new Error('PORT 必须为有效端口');
  const loopback = ['127.0.0.1','::1','localhost'].includes(config.HOST);
  if ((config.CF_ACCESS_TEAM_DOMAIN || config.CF_ACCESS_AUD) && !config.CF_ACCESS_ENABLED) {
    throw new Error('Cloudflare Access 的团队域名和 AUD 必须同时配置');
  }
  if ((!loopback || config.PUBLIC_HOST) && (!config.PUBLIC_HOST || !config.CF_ACCESS_ENABLED)) {
    throw new Error('网络部署必须配置 PUBLIC_HOST 和 Cloudflare Access');
  }
  if (config.PUBLIC_HOST && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(config.PUBLIC_HOST)) {
    throw new Error('PUBLIC_HOST 只填写小写域名，不包含协议、端口或路径');
  }
  if (config.DEPLOYMENT_SHA && !/^[a-f0-9]{40}$/.test(config.DEPLOYMENT_SHA)) throw new Error('DEPLOYMENT_SHA 必须为完整 Git SHA');
  if (!Number.isFinite(config.BACKUP_INTERVAL_HOURS) || config.BACKUP_INTERVAL_HOURS < 1 || config.BACKUP_INTERVAL_HOURS > 168) {
    throw new Error('BACKUP_INTERVAL_HOURS 必须在 1 到 168 小时之间');
  }
}
module.exports = { validateNodeRuntime };
