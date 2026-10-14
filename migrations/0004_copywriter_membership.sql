-- 0004_copywriter_membership.sql —— 文案师名单 = 项目成员机制（用户 2026-09-28 决定）
--
-- 项目只有「文案师」一个角色：名单即成员、成员即访问权限，不再有「协作者」这个第二身份。
-- 本迁移做三件事：
--   1. project_copywriters 增加 revoked_at（NULL = 在册）。移出文案师时：有历史文章引用的
--      行保留并打 revoked_at（署名不断、无权访问），无引用的行直接删。
--   2. 存量 project_collaborators 全量迁进名单——原协作者原地变成文案师，权限不丢。
--      （本分支此前「启用即加协作者」的实现同步作废，改为名单自身承载权限。）
--   3. 此后所有项目访问校验只看 project_copywriters（canAccessProject / 列表可见性）。
-- 旧表 project_collaborators 保留到任务15退役；deleteProject 仍会清理它的遗留行。

ALTER TABLE project_copywriters ADD COLUMN revoked_at TEXT;

-- 存量协作者 → 名单（幂等；已在名单里的不动）
INSERT INTO project_copywriters (project_id, user_id, created_at)
SELECT project_id, user_id, COALESCE(added_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM project_collaborators
WHERE user_id IN (SELECT id FROM users)
ON CONFLICT(project_id, user_id) DO NOTHING;
