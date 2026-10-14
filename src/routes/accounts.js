// accounts.js —— 谷歌账号：OAuth 授权流程 + 已连接账号的管理 + 列出账号下的 GSC 站点 / GA4 资源

const crypto = require('node:crypto');
const express = require('express');
const { wrap, parseId, badId } = require('../lib/http');
const {enqueueResourceSync}=require('../services/google-resource-sync');
const {disconnectGoogleAccount}=require('../services/account-disconnect');

// state 用 Map 存，支持同时开多个授权窗口；一次性使用且有有效期。
// 值里带上发起授权的 ownerUserId，回调时用它把新连接的谷歌账号记到正确的人名下。
const STATE_TTL_MS = 10 * 60 * 1000;

module.exports = function accountRoutes({ db, google }) {
  const router = express.Router();
  const pendingStates = new Map();

  function rememberState(state, ownerUserId) {
    const nowMs = Date.now();
    for (const [k, v] of pendingStates) if (v.expiry < nowMs) pendingStates.delete(k);
    pendingStates.set(state, { expiry: nowMs + STATE_TTL_MS, ownerUserId });
  }
  // 返回 ownerUserId（校验通过）或 null（不存在/过期）
  function consumeState(state) {
    const entry = pendingStates.get(state);
    if (entry === undefined) return null;
    pendingStates.delete(state); // 一次性，防重放
    return entry.expiry >= Date.now() ? entry.ownerUserId : null;
  }

  // 用实际请求的 host 拼回调地址，不写死 localhost——部署到域名后就是那个域名。
  // state 里带上发起授权的用户 id，回调时用它把新账号记到正确的人名下
  // （OAuth 走整页跳转，用 state 传比依赖"跳转全程 cookie 不丢"更明确）。
  const redirectUriFor = (req) => `${req.protocol}://${req.get('host')}/oauth/callback`;
  const backToAccounts = (res, msg) => res.redirect('/#/accounts?msg=' + encodeURIComponent(msg));

  // 账号访问校验：owner 本人或 admin。协作者概念只作用于项目，不含谷歌账号——
  // 账号是连接它的人自己的凭证，共享项目不等于共享账号密钥。
  async function assertAccountAccess(req, res, id) {
    const acc = await db.getAccount(id);
    if (!acc) { res.status(404).json({ error: '账号不存在' }); return null; }
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && acc.owner_user_id !== req.user.id) {
      res.status(403).json({ error: '无权访问该账号' });
      return null;
    }
    return acc;
  }

  router.get('/api/oauth/start', wrap(async (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = redirectUriFor(req);
    const url = await google.buildAuthUrl(redirectUri, state); // 未配置客户端时会抛错，交给错误中间件
    rememberState(state, req.user.id);
    res.json({ url, redirectUri });
  }));

  router.get('/oauth/callback', wrap(async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return backToAccounts(res, `授权被拒绝: ${error}`);
    if (!code || typeof state !== 'string') {
      return backToAccounts(res, '授权校验失败或链接已过期，请重新发起授权');
    }
    const ownerUserId = consumeState(state);
    if (!ownerUserId) {
      return backToAccounts(res, '授权校验失败或链接已过期，请重新发起授权');
    }
    try {
      const acc = await google.exchangeCode(String(code), redirectUriFor(req), ownerUserId);
      await enqueueResourceSync(db,acc.id,ownerUserId);
      req.app.locals.wakeResourceSync?.();
      backToAccounts(res, `成功连接 ${acc.email}`);
    } catch (e) {
      backToAccounts(res, '连接失败: ' + e.message);
    }
  }));

  router.get('/api/accounts', wrap(async (req, res) => {
    res.json(await db.listAccounts({ ownerUserId: req.user.id, isAdmin: req.user.role === 'admin' }));
  }));

  // 更新账号备注（其它字段不可改，账号主体由 OAuth 决定）
  router.put('/api/accounts/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertAccountAccess(req, res, id))) return;
    const note = String(req.body?.note ?? '').trim();
    await db.update('google_accounts', id, { note });
    res.json({ ok: true, note });
  }));

  router.delete('/api/accounts/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertAccountAccess(req, res, id))) return;
    const detached = await disconnectGoogleAccount(db,await db.getAccount(id),req.user);
    google.forgetAccount(id);
    res.json({ ok: true, detachedProjects: detached });
  }));

  router.get('/api/accounts/:id/sites', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertAccountAccess(req, res, id))) return;
    try {
      res.json(await google.gscListSites(id));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }));

  router.get('/api/accounts/:id/properties', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertAccountAccess(req, res, id))) return;
    try {
      res.json(await google.ga4ListProperties(id));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }));

  // 列出某个 GA4 资源最近 90 天的事件名（项目配置关键事件时勾选用）
  router.get('/api/accounts/:id/properties/:propertyId/events', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return badId(res);
    if (!(await assertAccountAccess(req, res, id))) return;
    try {
      res.json(await google.ga4ListEvents(id, req.params.propertyId));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }));

  return router;
};
