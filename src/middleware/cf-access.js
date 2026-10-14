// cf-access.js —— 验证 Cloudflare Access 签发的 JWT，拿到经过验证的登录邮箱
// 团队模式下应用本身不做登录页，信任 Cloudflare Access 已经做完的身份验证。
//
// 不直接信任 Cf-Access-Authenticated-User-Email 这个明文头——如果源站曾经被绕过
// Cloudflare 直连访问，这个头可以被任意伪造冒充任何人。这里改成验证同时下发的
// Cf-Access-Jwt-Assertion：用 Cloudflare 的公钥验签名，没有 Cloudflare 的私钥
// 就签不出合法 token，安全性不依赖网络层能不能把源站锁到只让 Cloudflare 访问。
//
// 只用 Node 内置 crypto 做 RS256 验签，不额外加依赖。
const crypto = require('node:crypto');

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 小时刷新一次公钥缓存

function b64urlToBuffer(s) {
  return Buffer.from(s, 'base64url');
}

function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header, payload;
  try {
    header = JSON.parse(b64urlToBuffer(h).toString('utf8'));
    payload = JSON.parse(b64urlToBuffer(p).toString('utf8'));
  } catch {
    return null;
  }
  return { header, payload, signingInput: `${h}.${p}`, signature: s };
}

function jwkToPublicKey(jwk) {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

function rs256Verify(signingInput, key, signature) {
  return crypto.verify('RSA-SHA256', signingInput, key, signature);
}

module.exports = () => {
  let jwksCache = null; // { keys: Map<kid, KeyObject>, fetchedAt }

  async function getJwks(teamDomain) {
    if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`拉取 Cloudflare Access 公钥失败: ${res.status}`);
    const data = await res.json();
    const keys = new Map();
    for (const jwk of data.keys || []) {
      try { keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); }
      catch { /* 忽略解析失败的单个 key，不影响其它 kid */ }
    }
    jwksCache = { keys, fetchedAt: Date.now() };
    return keys;
  }

  // 校验一个请求带的 Cloudflare Access JWT，通过则返回经过验证的邮箱，否则返回 null。
  // teamDomain 形如 "yourteam.cloudflareaccess.com"，aud 是该 Access Application 的
  // Audience 标签，两者都从环境变量注入（见 src/config.js），不走网页设置。
  async function verifyRequest(req, { teamDomain, aud }) {
    const token = req.headers['cf-access-jwt-assertion'];
    if (!token) return null;
    const parsed = parseJwt(token);
    if (!parsed) return null;
    const { header, payload, signingInput, signature } = parsed;
    if (header.alg !== 'RS256' || !header.kid) return null;

    let keys;
    try { keys = await getJwks(teamDomain); } catch { return null; }
    const key = keys.get(header.kid);
    if (!key) return null;

    let ok;
    try {
      ok = rs256Verify(Buffer.from(signingInput), key, b64urlToBuffer(signature));
    } catch {
      return null;
    }
    if (!ok) return null;

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    if (payload.iss !== `https://${teamDomain}`) return null;
    const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audList.includes(aud)) return null;
    if (!payload.email) return null;

    return payload.email;
  }

  return { verifyRequest, _internal: { parseJwt, getJwks, jwkToPublicKey, rs256Verify } };
};
