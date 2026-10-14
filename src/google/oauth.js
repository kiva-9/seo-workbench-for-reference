// oauth.js —— Google OAuth 多账号授权：拼授权链接、换 token、按账号缓存并自动刷新 access_token
// 全部用 Node 内置 fetch，零第三方依赖

const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// 授权类错误需要向上冒泡（提示用户重新授权），其余错误只做告警
function isAuthError(e) {
  return /令牌刷新失败|未授权|授权已失效|尚未配置/.test(e.message);
}

function createOAuth(db,{beforeRequest=()=>{}}={}) {
  const fetchGoogle=async (url,options={})=>{await beforeRequest();return fetch(url,{...options,signal:options.signal||AbortSignal.timeout(15000)});};
  // 内存中的 access_token 缓存：accountId -> { token, expiresAt }
  const tokenCache = new Map();
  // 正在刷新中的 token：accountId -> Promise，避免并发抓取时重复刷新
  const refreshing = new Map();

  async function getClientConfig() {
    const clientId = await db.getSetting('gsc_client_id', '');
    const clientSecret = await db.getSetting('gsc_client_secret', '');
    return { clientId, clientSecret };
  }

  async function assertClientConfigured() {
    const { clientId, clientSecret } = await getClientConfig();
    if (!clientId || !clientSecret) {
      throw new Error('尚未配置 Google Cloud 客户端 ID / 密钥，请先到「设置」页填写');
    }
    return { clientId, clientSecret };
  }

  // 拼接授权链接（redirect 回本服务的回调地址）
  async function buildAuthUrl(redirectUri, state) {
    const { clientId } = await assertClientConfigured();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
      include_granted_scopes: 'true',
    });
    return `${OAUTH_AUTH_URL}?${params.toString()}`;
  }

  // 用授权码换 token（首次连接账号）。ownerUserId：这个谷歌账号归哪个用户所有——
  // 只在新建账号那一支写入，重新授权已存在的账号只刷新 token，不改动原有 owner
  // （防止别人重新走一遍授权流程就"偷"走账号归属）。
  async function exchangeCode(code, redirectUri, ownerUserId) {
    const { clientId, clientSecret } = await assertClientConfigured();
    const resp = await fetchGoogle(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`换取授权失败: ${data.error_description || data.error || resp.status}`);

    const user = await fetchUserInfo(data.access_token);
    if (!user.email) throw new Error('未能读取该账号的邮箱，请确认授权时勾选了邮箱权限');

    // 保存或更新账号（refresh_token 覆盖更新，保证最新）
    const existing = await db.getAccountByEmail(user.email);
    const refreshToken = data.refresh_token || existing?.refresh_token;
    if (!refreshToken) throw new Error('未获得刷新令牌，请重新授权（必须勾选同意且授权时账号需支持离线访问）');
    if (existing && db.getUser) {
      const actor = await db.getUser(ownerUserId);
      if (!actor || (actor.role !== 'admin' && existing.owner_user_id !== ownerUserId)) throw new Error('该 Google 账号已由其他成员连接，请由连接者重新授权');
    }
    let id;
    if (existing) {
      const changed = await db.renewAccountAuthorization(existing.id, ownerUserId, refreshToken, db.now());
      if (!changed) throw new Error('该 Google 账号已由其他成员连接，请由连接者重新授权');
      id = existing.id;
    } else {
      id = await db.insert('google_accounts', { email: user.email, refresh_token: refreshToken, connected_at: db.now(), owner_user_id: ownerUserId ?? null });
    }

    tokenCache.delete(id);
    cacheToken(id, data.access_token, data.expires_in, (await db.getAccount(id)).auth_revision);
    return db.getAccount(id);
  }

  async function fetchUserInfo(accessToken) {
    const resp = await fetchGoogle(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) throw new Error('获取账号邮箱失败');
    return resp.json();
  }

  function cacheToken(accountId, accessToken, expiresIn, authRevision) {
    tokenCache.set(accountId, {
      token: accessToken,
      authRevision,
      expiresAt: Date.now() + (expiresIn || 3600) * 1000 - 60 * 1000,
    });
  }

  function forgetAccount(accountId) {
    tokenCache.delete(accountId);
    refreshing.delete(accountId);
  }

  // 获取有效 access_token（过期自动用 refresh_token 刷新，并发调用共用同一次刷新）
  async function getAccessToken(accountId) {
    const id = Number(accountId);
    const liveAccount = await db.getAccount(id);
    if (!liveAccount || !liveAccount.refresh_token) throw new Error('该账号未授权或授权已失效');
    const cached = tokenCache.get(id);
    if (cached && cached.authRevision === liveAccount.auth_revision && cached.expiresAt > Date.now()) return cached.token;
    if (refreshing.has(id)) return refreshing.get(id);

    const p = (async () => {
      const account = liveAccount;
      if (!account || !account.refresh_token) throw new Error('该账号未授权或授权已失效');
      const { clientId, clientSecret } = await assertClientConfigured();
      const resp = await fetchGoogle(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: account.refresh_token,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.access_token) {
        const error = new Error(`令牌刷新失败（账号可能已取消授权，HTTP ${resp.status}），请重试或重新授权`);
        error.transient = resp.status === 429 || resp.status >= 500;
        throw error;
      }
      const current = await db.getAccount(id);
      if (!current || current.auth_revision !== account.auth_revision) throw new Error('账号授权已变化，请重试');
      cacheToken(id, data.access_token, data.expires_in, account.auth_revision);
      return data.access_token;
    })().finally(() => refreshing.delete(id));

    refreshing.set(id, p);
    return p;
  }

  return { buildAuthUrl, exchangeCode, getAccessToken, forgetAccount };
}

module.exports = { createOAuth, isAuthError };
