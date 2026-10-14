const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { fail } = require('../services/mcp-common');
const { MAX_ACTIVE_MCP_TOKENS, MAX_MCP_TOKEN_NAME_LENGTH } = require('../lib/mcp-token-policy');
const hashToken = token => createHash('sha256').update(token).digest('hex');

function tokenStatus(row) {
  return { id: Number(row.id), name: row.name, active: !row.revoked_at, token_id: row.token_id,
    created_at: row?.created_at || null, rotated_at: row?.rotated_at || null,
    revoked_at: row?.revoked_at || null, last_used_at: row?.last_used_at || null };
}
function credentials() {
  const tokenId = randomBytes(12).toString('hex');
  const token = `spm_${tokenId}_${randomBytes(32).toString('base64url')}`;
  return { tokenId, token, hash: hashToken(token) };
}
function recordId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || !/^\d+$/.test(String(value))) fail('VALIDATION_ERROR', 'Token 记录 ID 无效');
  return id;
}
function createPatService(db) {
  return {
    status: async userId => {
      const items = (await db.listMcpTokens(userId)).map(tokenStatus);
      return { items, active_count: items.filter(t => t.active).length, limit: MAX_ACTIVE_MCP_TOKENS,
        max_name_length: MAX_MCP_TOKEN_NAME_LENGTH };
    },
    issue: async (userId, value) => {
      const name = typeof value === 'string' ? value.trim() : '';
      if (!name || name.length > MAX_MCP_TOKEN_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
        fail('VALIDATION_ERROR', `请填写 1–${MAX_MCP_TOKEN_NAME_LENGTH} 字的 Token 名称，不能包含控制字符`);
      }
      const { tokenId, token, hash } = credentials();
      const now = new Date().toISOString();
      const result = await db.createMcpToken(userId, tokenId, hash, now, name);
      if (!Number(result.changes)) fail('CONFLICT', `每个账号最多 ${MAX_ACTIVE_MCP_TOKENS} 个有效 Token，请先撤销不再使用的 Token`);
      return { ...tokenStatus({ id: result.lastInsertRowid, name, token_id: tokenId, created_at: now }), token };
    },
    reset: async (userId, value) => {
      const id = recordId(value), row = await db.getMcpToken(userId, id);
      if (!row) fail('NOT_FOUND', 'Token 不存在或不可访问');
      if (row.revoked_at) fail('CONFLICT', '此 Token 已撤销，请创建新的 Token');
      const { tokenId, token, hash } = credentials();
      const now = new Date().toISOString();
      const result = await db.resetMcpToken(userId, id, row.token_id, tokenId, hash, now);
      if (!Number(result.changes)) fail('CONFLICT', '此 Token 已变化，请刷新后重试');
      return { ...tokenStatus({ ...row, token_id: tokenId, rotated_at: now, last_used_at: null }), token };
    },
    revoke: async (userId, value) => {
      const id = recordId(value), row = await db.getMcpToken(userId, id);
      if (!row) fail('NOT_FOUND', 'Token 不存在或不可访问');
      const now = new Date().toISOString();
      await db.revokeMcpToken(userId, id, now);
      return tokenStatus({ ...row, revoked_at: row.revoked_at || now });
    },
    authenticate: async authorization => {
      const match = /^Bearer (spm_([a-f0-9]{24})_[A-Za-z0-9_-]{43})$/.exec(authorization || '');
      if (!match) return null;
      const row = await db.getMcpTokenById(match[2]);
      const expected = Buffer.from(row?.token_hash || '0'.repeat(64), 'hex');
      const actual = Buffer.from(hashToken(match[1]), 'hex');
      if (!timingSafeEqual(actual, expected) || !row) return null;
      const time = new Date().toISOString();
      const cutoff = new Date(Date.parse(time) - 5 * 60_000).toISOString();
      if (!row.last_used_at || row.last_used_at < cutoff) await db.touchMcpToken(row.token_id, time, cutoff);
      return Object.freeze({ user_id: row.user_id, current_role: row.role, channel: 'mcp',
        token_id: row.token_id, request_id: randomUUID() });
    },
  };
}
module.exports = { createPatService, tokenStatus, hashToken };
