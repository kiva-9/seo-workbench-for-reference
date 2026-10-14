const { MAX_ACTIVE_MCP_TOKENS } = require('../../lib/mcp-token-policy');
const publicColumns = 'id, name, token_id, created_at, rotated_at, revoked_at, last_used_at';

module.exports = (db) => ({
  listMcpTokens: async userId => db.prepare(`SELECT ${publicColumns} FROM mcp_tokens
    WHERE user_id = ? ORDER BY revoked_at IS NOT NULL, id DESC`).all(userId),
  getMcpToken: async (userId, id) => db.prepare(`SELECT ${publicColumns} FROM mcp_tokens WHERE user_id = ? AND id = ?`).get(userId, id),
  getMcpTokenById: async id => db.prepare(`SELECT t.*, u.role FROM mcp_tokens t
    JOIN users u ON u.id = t.user_id WHERE t.token_id = ? AND t.revoked_at IS NULL AND u.deleted_at IS NULL`).get(id),
  createMcpToken: async (userId, tokenId, hash, time, name) => db.prepare(`INSERT INTO mcp_tokens
    (user_id, name, token_id, token_hash, created_at) SELECT ?, ?, ?, ?, ?
    WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)
    AND (SELECT COUNT(*) FROM mcp_tokens WHERE user_id = ? AND revoked_at IS NULL) < ?`)
    .run(userId, name, tokenId, hash, time, userId, userId, MAX_ACTIVE_MCP_TOKENS),
  resetMcpToken: async (userId, id, oldTokenId, tokenId, hash, time) => db.prepare(`UPDATE mcp_tokens
    SET token_id = ?, token_hash = ?, rotated_at = ?, last_used_at = NULL
    WHERE user_id = ? AND id = ? AND token_id = ? AND revoked_at IS NULL`)
    .run(tokenId, hash, time, userId, id, oldTokenId),
  revokeMcpToken: async (userId, id, time) => db.prepare(`UPDATE mcp_tokens SET revoked_at = ?
    WHERE user_id = ? AND id = ? AND revoked_at IS NULL`).run(time, userId, id),
  touchMcpToken: async (id, time, cutoff) => db.prepare(`UPDATE mcp_tokens SET last_used_at = ?
    WHERE token_id = ? AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at < ?)`).run(time, id, cutoff),
});
