// current-user.js —— 识别当前用户，挂到 req.user = { id, email, role }
//
// 团队模式（配了 CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD）：身份来自 Cloudflare Access 验证过的 JWT
// （cf-access.js 验签名），不信任明文邮箱头，也不在应用里做登录页/密码。
// 单用户模式（没配）：所有请求都记在固定的本机用户名下，行为就是一个人用的本地工具。

const { wrap } = require('../lib/http');

function createCurrentUser({ db, cfAccess, config }) {
  return wrap(async (req, res, next) => {
    req.logoutUrl = config.CF_ACCESS_ENABLED ? '/cdn-cgi/access/logout' : null;
    let email = null;
    if (config.CF_ACCESS_ENABLED) {
      email = await cfAccess.verifyRequest(req, { teamDomain: config.CF_ACCESS_TEAM_DOMAIN, aud: config.CF_ACCESS_AUD });
    } else {
      email = config.LOCAL_USER_EMAIL;
    }
    if (email) {
      const user = await db.getOrCreateUser(email);
      if (user) req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
      else req.accountDeleted = true;
    }
    next();
  });
}

function requireUser(req, res, next) {
  if (req.accountDeleted) return res.status(403).json({ error: '此登录账号已删除，请联系管理员', code: 'ACCOUNT_DELETED', logout_url: req.logoutUrl });
  // 团队模式下 Cloudflare Access 已经挡在前面，这条基本不会触发，是兜底。
  if (!req.user) return res.status(401).json({ error: '未登录' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  next();
}

module.exports = { createCurrentUser, requireUser, requireAdmin };
