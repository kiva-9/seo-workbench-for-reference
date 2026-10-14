-- 列表记录独立于凭证标识，重置一个客户端不会影响其他客户端。
CREATE TABLE mcp_tokens_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  token_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);
INSERT INTO mcp_tokens_next (user_id, name, token_id, token_hash, created_at, rotated_at, revoked_at, last_used_at)
SELECT user_id, '默认 Token', token_id, token_hash, created_at, rotated_at, revoked_at, last_used_at FROM mcp_tokens;
DROP TABLE mcp_tokens;
ALTER TABLE mcp_tokens_next RENAME TO mcp_tokens;
CREATE INDEX idx_mcp_tokens_user ON mcp_tokens(user_id, id);
CREATE INDEX idx_mcp_tokens_active ON mcp_tokens(user_id) WHERE revoked_at IS NULL;

-- 数据库兜底覆盖不同应用实例及绕过签发服务的写入，活动凭证轮换不占新名额。
CREATE TRIGGER mcp_tokens_insert_limit BEFORE INSERT ON mcp_tokens
WHEN NEW.revoked_at IS NULL AND (SELECT COUNT(*) FROM mcp_tokens WHERE user_id = NEW.user_id AND revoked_at IS NULL) >= 5
BEGIN SELECT RAISE(ABORT, 'MCP_TOKEN_LIMIT'); END;
CREATE TRIGGER mcp_tokens_update_limit BEFORE UPDATE OF user_id, revoked_at ON mcp_tokens
WHEN NEW.revoked_at IS NULL AND (OLD.revoked_at IS NOT NULL OR NEW.user_id <> OLD.user_id)
  AND (SELECT COUNT(*) FROM mcp_tokens WHERE user_id = NEW.user_id AND revoked_at IS NULL AND id <> OLD.id) >= 5
BEGIN SELECT RAISE(ABORT, 'MCP_TOKEN_LIMIT'); END;
