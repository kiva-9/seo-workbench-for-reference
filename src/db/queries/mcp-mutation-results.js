// 缓存结果跟随记录的当前归属；个人记录后来移入项目时不能继续用旧缓存越权读取。
module.exports = db => ({
  projectAccessCount: (ids, uid) => db.prepare(`SELECT COUNT(*) AS count FROM projects p JOIN users u ON u.id=? AND u.deleted_at IS NULL
    WHERE p.id IN (SELECT value FROM json_each(?)) AND (u.role='admin' OR p.owner_user_id=u.id
      OR EXISTS(SELECT 1 FROM project_copywriters c WHERE c.project_id=p.id AND c.user_id=u.id AND c.revoked_at IS NULL))`)
    .get(uid, JSON.stringify(ids)),
  visibleResultCount: (refs, uid) => db.prepare(`WITH requested AS (
      SELECT json_extract(value,'$.kind') AS kind,json_extract(value,'$.id') AS id FROM json_each(?)
    ), records AS (
      SELECT r.kind,r.id,t.project_id,t.owner_user_id FROM requested r JOIN tasks t ON r.kind='task' AND t.id=r.id
      UNION ALL SELECT r.kind,r.id,l.project_id,l.owner_user_id FROM requested r JOIN links l ON r.kind='link' AND l.id=r.id
      UNION ALL SELECT r.kind,r.id,a.project_id,NULL FROM requested r JOIN project_articles a ON r.kind='internal' AND a.id=r.id
      UNION ALL SELECT r.kind,r.id,a.project_id,NULL FROM requested r JOIN project_external_articles a ON r.kind='external' AND a.id=r.id
      UNION ALL SELECT r.kind,r.id,p.id,p.owner_user_id FROM requested r JOIN projects p ON r.kind='project' AND p.id=r.id
    ) SELECT COUNT(*) AS count FROM records r JOIN users u ON u.id=? AND u.deleted_at IS NULL LEFT JOIN projects p ON p.id=r.project_id
      WHERE (r.project_id IS NULL AND (u.role='admin' OR r.owner_user_id=u.id))
        OR (p.id IS NOT NULL AND (u.role='admin' OR p.owner_user_id=u.id
          OR EXISTS(SELECT 1 FROM project_copywriters c WHERE c.project_id=p.id AND c.user_id=u.id AND c.revoked_at IS NULL)))`)
    .get(JSON.stringify(refs), uid),
});
