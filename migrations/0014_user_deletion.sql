-- 保留身份记录让历史署名与审计外键有效，并阻止旧登录会话自动重新建号。
ALTER TABLE users ADD COLUMN deleted_at TEXT;
ALTER TABLE users ADD COLUMN deleted_by INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN transferred_to_user_id INTEGER REFERENCES users(id);

-- 网络请求可能在删除前已开始；延迟的授权回调或业务写入不能再给停用账号挂数据。
CREATE TRIGGER projects_active_owner_insert BEFORE INSERT ON projects
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'OWNER_ACCOUNT_DELETED'); END;
CREATE TRIGGER projects_active_owner_update BEFORE UPDATE OF owner_user_id ON projects
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'OWNER_ACCOUNT_DELETED'); END;
CREATE TRIGGER tasks_active_owner_insert BEFORE INSERT ON tasks
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'OWNER_ACCOUNT_DELETED'); END;
CREATE TRIGGER tasks_active_owner_update BEFORE UPDATE OF owner_user_id ON tasks
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'OWNER_ACCOUNT_DELETED'); END;
CREATE TRIGGER links_active_owner_insert BEFORE INSERT ON links
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'OWNER_ACCOUNT_DELETED'); END;
CREATE TRIGGER links_active_owner_update BEFORE UPDATE OF owner_user_id ON links
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'OWNER_ACCOUNT_DELETED'); END;
CREATE TRIGGER google_accounts_active_owner_insert BEFORE INSERT ON google_accounts
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'OWNER_ACCOUNT_DELETED'); END;
CREATE TRIGGER google_accounts_active_owner_update BEFORE UPDATE OF owner_user_id ON google_accounts
WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'OWNER_ACCOUNT_DELETED'); END;
CREATE TRIGGER copywriters_active_user_insert BEFORE INSERT ON project_copywriters
WHEN NEW.revoked_at IS NULL AND EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'OWNER_ACCOUNT_DELETED'); END;
CREATE TRIGGER copywriters_active_user_update BEFORE UPDATE OF user_id,revoked_at ON project_copywriters
WHEN NEW.revoked_at IS NULL AND EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'OWNER_ACCOUNT_DELETED'); END;
