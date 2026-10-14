// MCP 查询在 SQL 内先限定实时项目权限，分析只在有界集合上进行。
module.exports = (db) => {
  const access = (actor, alias = 'p') => actor.current_role === 'admin'
    ? { sql: '1=1', args: [] }
    : { sql: `(${alias}.owner_user_id = ? OR EXISTS (SELECT 1 FROM project_copywriters member WHERE member.project_id = ${alias}.id AND member.user_id = ? AND member.revoked_at IS NULL))`, args: [actor.user_id, actor.user_id] };
  const scoped = (actor, input = {}, alias = 'p') => {
    const a = access(actor, alias);
    if (input.project_ids) { a.sql += ` AND ${alias}.id IN (${input.project_ids.map(() => '?').join(',')})`; a.args.push(...input.project_ids); }
    return a;
  };
  const search = (conditions, args, pattern, fields) => {
    if (!pattern) return;
    conditions.push(`(${fields.map(f => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    args.push(...fields.map(() => pattern));
  };
  const articleWhere = (actor, input, type) => {
    const a = scoped(actor, input);
    const conditions = [a.sql], args = [...a.args];
    if (input.status && input.status !== 'all') { conditions.push('a.status = ?'); args.push(input.status); }
    if (input.copywriter_user_id) { conditions.push('c.user_id = ?'); args.push(input.copywriter_user_id); }
    if (input.unassigned) conditions.push('a.copywriter_id IS NULL');
    if (input.missing_published_at) conditions.push("TRIM(COALESCE(a.published_at,'')) = ''");
    if (input.published_from) { conditions.push('a.published_at >= ? AND a.published_at <= ?'); args.push(input.published_from, input.published_to); }
    if (input.article_ids) { conditions.push('a.id IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(input.article_ids)); }
    if (input.domain) { conditions.push('a.domain = ?'); args.push(input.domain); }
    const fields = ['a.url', 'a.title', type === 'internal' ? 'a.keyword' : 'a.anchor_text', 'p.name'];
    search(conditions, args, input.pattern, fields);
    return { sql: conditions.join(' AND '), args };
  };
  const articleFrom = type => `${type === 'internal' ? 'project_articles' : 'project_external_articles'} a JOIN projects p ON p.id = a.project_id LEFT JOIN project_copywriters c ON c.id = a.copywriter_id LEFT JOIN users u ON u.id = c.user_id LEFT JOIN project_monitor_sync_state s ON s.project_id = p.id`;
  const articleFields = `a.*, c.user_id AS copywriter_user_id, u.name AS copywriter_name, u.email AS copywriter_email, p.name AS project_name, p.owner_user_id, p.account_id, p.gsc_account_id, p.gsc_site, p.ga4_account_id, p.ga4_property_id, p.key_event_names, s.config_revision AS monitor_config_revision, s.last_attempt_at AS project_last_attempt_at, s.last_success_at AS project_last_success_at, s.last_error AS project_last_error`;
  const personalWhere = (actor, input, alias) => {
    const a = access(actor);
    const conditions = [`((${alias}.project_id IS NOT NULL AND ${a.sql}) OR (${alias}.project_id IS NULL AND ${actor.current_role === 'admin' ? '1=1' : `${alias}.owner_user_id = ?`}))`];
    const args = [...a.args];
    if (actor.current_role !== 'admin') args.push(actor.user_id);
    if (input.scope === 'personal') conditions.push(`${alias}.project_id IS NULL`);
    if (input.scope === 'project') { conditions.push(`${alias}.project_id = ?`); args.push(input.project_id); }
    return { conditions, args };
  };
  const page = input => [input.page_size, (input.page - 1) * input.page_size];
  const order = (field, direction, tie = 'a.id') => `(${field} IS NULL) ASC, ${field} ${direction === 'asc' ? 'ASC' : 'DESC'}, ${tie} ASC`;
  return {
    async projects(actor, input) {
      const a = access(actor), conditions = [a.sql], args = [...a.args];
      if (input.status !== 'all') { conditions.push('p.status = ?'); args.push(input.status); }
      search(conditions, args, input.pattern, ['p.name', 'p.website']);
      const where = conditions.join(' AND ');
      const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM projects p WHERE ${where}`).get(...args)).n);
      const rows = await db.prepare(`SELECT p.* FROM projects p WHERE ${where} ORDER BY ${order('p.' + input.sort, input.direction, 'p.id')} LIMIT ? OFFSET ?`).all(...args, ...page(input));
      return { rows, total };
    },
    async projectsInScope(actor, input) {
      const a = scoped(actor, input);
      return db.prepare(`SELECT p.*, s.config_revision AS monitor_config_revision, s.last_attempt_at, s.last_success_at, s.last_error FROM projects p LEFT JOIN project_monitor_sync_state s ON s.project_id = p.id WHERE ${a.sql} ORDER BY p.id LIMIT 21`).all(...a.args);
    },
    async projectCounts(id, today) {
      return db.prepare(`SELECT
        (SELECT COUNT(*) FROM project_articles WHERE project_id = ? AND status = 'active') AS internal_active,
        (SELECT COUNT(*) FROM project_articles WHERE project_id = ? AND status = 'inactive') AS internal_inactive,
        (SELECT COUNT(*) FROM project_external_articles WHERE project_id = ? AND status = 'active') AS external_active,
        (SELECT COUNT(*) FROM project_external_articles WHERE project_id = ? AND status = 'inactive') AS external_inactive,
        (SELECT COUNT(*) FROM tasks WHERE project_id = ? AND status = 'todo') AS open_tasks,
        (SELECT COUNT(*) FROM tasks WHERE project_id = ? AND status = 'todo' AND due_date < ?) AS overdue_tasks,
        (SELECT COUNT(*) FROM links WHERE project_id = ?) AS links`).get(id, id, id, id, id, id, today, id);
    },
    async projectState(id) {
      return db.prepare('SELECT * FROM project_monitor_sync_state WHERE project_id = ?').get(id);
    },
    async activeJobs(actor, input) {
      const a = scoped(actor, input);
      return db.prepare(`SELECT j.job_id, j.project_id, j.status, j.updated_at, NULL AS operation_id
        FROM article_monitor_sync_jobs j JOIN projects p ON p.id = j.project_id
        WHERE ${a.sql} AND j.status IN ('queued','running')
        UNION ALL SELECT NULL AS job_id, p.id AS project_id, op.status, op.updated_at, op.id AS operation_id
        FROM business_operations op JOIN projects p ON EXISTS (SELECT 1 FROM json_each(op.project_ids_json) scope WHERE scope.value = p.id)
        WHERE ${a.sql} AND op.kind = 'sync' AND op.status IN ('queued','running','cancel_requested')
          AND ${actor.current_role === 'admin' ? '1=1' : 'op.user_id = ?'}
        ORDER BY project_id LIMIT 101`).all(...a.args, ...a.args, ...(actor.current_role === 'admin' ? [] : [actor.user_id]));
    },
    async articles(actor, input, bounded = false) {
      const type = input.article_type, a = articleWhere(actor, input, type);
      if (bounded) return db.prepare(`SELECT ${articleFields} FROM ${articleFrom(type)} WHERE ${a.sql} ORDER BY a.project_id, a.id LIMIT 1001`).all(...a.args);
      const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${articleFrom(type)} WHERE ${a.sql}`).get(...a.args)).n);
      const rows = await db.prepare(`SELECT ${articleFields} FROM ${articleFrom(type)} WHERE ${a.sql} ORDER BY ${order(input.sort === 'sort_order' ? 'COALESCE(a.sort_order,a.id)' : 'a.' + input.sort, input.direction)} LIMIT ? OFFSET ?`).all(...a.args, ...page(input));
      return { rows, total };
    },
    async article(actor, ref) {
      const a = access(actor);
      return db.prepare(`SELECT ${articleFields} FROM ${articleFrom(ref.article_type)} WHERE ${a.sql} AND a.project_id = ? AND a.id = ?`).get(...a.args, ref.project_id, ref.article_id);
    },
    async history(actor, input) {
      const a = articleWhere(actor, input, 'internal');
      return db.prepare(`SELECT h.article_id,h.url,h.url_changed_at FROM project_article_url_history h JOIN project_articles a ON a.id = h.article_id JOIN projects p ON p.id = a.project_id LEFT JOIN project_copywriters c ON c.id = a.copywriter_id WHERE ${a.sql} ORDER BY h.article_id,h.url_changed_at,h.id LIMIT 2001`).all(...a.args);
    },
    async monthly(actor, input, from, to) {
      const a = articleWhere(actor, input, 'internal'), conditions = [a.sql], args = [...a.args];
      if (from) { conditions.push('m.month >= ? AND m.month <= ?'); args.push(from, to); }
      return db.prepare(`SELECT m.* FROM project_article_monthly_metrics m JOIN project_articles a ON a.id = m.article_id JOIN projects p ON p.id = a.project_id LEFT JOIN project_copywriters c ON c.id = a.copywriter_id WHERE ${conditions.join(' AND ')} ORDER BY m.article_id,m.month LIMIT 48001`).all(...args);
    },
    async current(actor, input) {
      const a = articleWhere(actor, input, 'internal');
      return db.prepare(`SELECT m.* FROM project_article_current_metrics m JOIN project_articles a ON a.id = m.article_id JOIN projects p ON p.id = a.project_id LEFT JOIN project_copywriters c ON c.id = a.copywriter_id WHERE ${a.sql} ORDER BY m.article_id LIMIT 1001`).all(...a.args);
    },
    async externalDaily(actor, input, from, to, aggregate = true) {
      const a = scoped(actor, input), conditions = [a.sql], args = [...a.args];
      if (input.domain) { conditions.push('m.domain = ?'); args.push(input.domain); }
      if (from) { conditions.push('m.date >= ? AND m.date <= ?'); args.push(from, to); }
      if (input.period?.mode === 'months' && !input.period.include_provisional) {
        conditions.push(`EXISTS (SELECT 1 FROM project_external_month_state settled
          WHERE settled.project_id = m.project_id AND settled.domain = m.domain
            AND settled.month = substr(m.date,1,7) AND settled.finalized = 1)`);
      }
      const fields = aggregate ? 'm.project_id,m.domain,m.source,m.config_fingerprint,SUM(m.value) AS value,COUNT(*) AS days,MIN(m.date) AS start,MAX(m.date) AS end,MAX(m.fetched_at) AS fetched_at' : 'm.*';
      return db.prepare(`SELECT ${fields} FROM project_external_daily_metrics m JOIN projects p ON p.id = m.project_id WHERE ${conditions.join(' AND ')} ${aggregate ? 'GROUP BY m.project_id,m.domain,m.source,m.config_fingerprint' : ''} ORDER BY m.project_id,m.domain LIMIT ${aggregate ? 201 : 18001}`).all(...args);
    },
    async externalMonths(actor, input, from, to) {
      const a = scoped(actor, input), conditions = [a.sql], args = [...a.args];
      if (input.domain) { conditions.push('m.domain = ?'); args.push(input.domain); }
      if (from) { conditions.push('m.month >= ? AND m.month <= ?'); args.push(from, to); }
      return db.prepare(`SELECT m.* FROM project_external_month_state m JOIN projects p ON p.id = m.project_id WHERE ${conditions.join(' AND ')} ORDER BY m.project_id,m.domain,m.month LIMIT 2401`).all(...args);
    },
    async freezes(actor, input) {
      const a = scoped(actor, input), conditions = [a.sql], args = [...a.args];
      if (input.domain) { conditions.push('f.domain = ?'); args.push(input.domain); }
      if (input.article_ids) { conditions.push('f.article_id IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(input.article_ids)); }
      return db.prepare(`SELECT f.* FROM project_external_article_freezes f JOIN projects p ON p.id = f.project_id WHERE ${conditions.join(' AND ')} ORDER BY f.article_id,f.segment_revision LIMIT 2001`).all(...args);
    },
    async tasks(actor, input, today, bounded = false) {
      const a = personalWhere(actor, input, 't');
      if (input.project_ids) { a.conditions.push(`t.project_id IN (${input.project_ids.map(() => '?').join(',')})` + (input.include_personal ? ' OR t.project_id IS NULL' : '')); a.conditions[a.conditions.length-1] = '(' + a.conditions.at(-1) + ')'; a.args.push(...input.project_ids); }
      if (input.include_personal === false) a.conditions.push('t.project_id IS NOT NULL');
      if (input.status !== 'all') { a.conditions.push('t.status = ?'); a.args.push(input.status); }
      if (input.priority) { a.conditions.push('t.priority = ?'); a.args.push(input.priority); }
      if (input.overdue !== undefined) { a.conditions.push(input.overdue ? "t.status = 'todo' AND t.due_date < ?" : "NOT (t.status = 'todo' AND t.due_date IS NOT NULL AND t.due_date < ?)"); a.args.push(today); }
      if (input.due_from) { a.conditions.push('t.due_date >= ? AND t.due_date <= ?'); a.args.push(input.due_from, input.due_to); }
      search(a.conditions, a.args, input.pattern, ['t.title','t.description']);
      const where = a.conditions.join(' AND ');
      if (bounded) return db.prepare(`SELECT t.*,p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE ${where} ORDER BY t.id LIMIT 1001`).all(...a.args);
      const summary = await db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS todo,SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done,SUM(CASE WHEN t.status = 'todo' AND t.due_date < ? THEN 1 ELSE 0 END) AS overdue FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE ${where}`).get(today, ...a.args);
      const field = input.sort === 'priority' ? "CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END" : 't.' + input.sort;
      const rows = await db.prepare(`SELECT t.*,p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE ${where} ORDER BY ${order(field,input.direction,'t.id')} LIMIT ? OFFSET ?`).all(...a.args,...page(input));
      return { rows, summary };
    },
    async personalEntity(actor, type, id) {
      const alias = type === 'tasks' ? 't' : 'l', a = personalWhere(actor, {}, alias);
      return db.prepare(`SELECT ${alias}.*,p.name AS project_name FROM ${type} ${alias} LEFT JOIN projects p ON p.id = ${alias}.project_id WHERE ${a.conditions.join(' AND ')} AND ${alias}.id = ?`).get(...a.args,id);
    },
    async links(actor, input, tagsOnly = false) {
      const a = personalWhere(actor, input, 'l');
      search(a.conditions,a.args,input.pattern,['l.title','l.url','l.notes']);
      if (input.tag) { a.conditions.push("instr(',' || COALESCE(l.tags,'') || ',', ',' || ? || ',') > 0"); a.args.push(input.tag); }
      const where = a.conditions.join(' AND ');
      if (tagsOnly) return db.prepare(`SELECT l.tags FROM links l LEFT JOIN projects p ON p.id = l.project_id WHERE ${where} ORDER BY l.id LIMIT 2001`).all(...a.args);
      const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM links l LEFT JOIN projects p ON p.id = l.project_id WHERE ${where}`).get(...a.args)).n);
      const rows = await db.prepare(`SELECT l.* FROM links l LEFT JOIN projects p ON p.id = l.project_id WHERE ${where} ORDER BY ${order('l.' + input.sort,input.direction,'l.id')} LIMIT ? OFFSET ?`).all(...a.args,...page(input));
      return { rows, total };
    },
    async members(id, input) {
      const where = input.status === 'all' ? '' : input.status === 'revoked' ? ' AND c.revoked_at IS NOT NULL' : ' AND c.revoked_at IS NULL';
      const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM project_copywriters c WHERE c.project_id = ?${where}`).get(id)).n);
      const rows = await db.prepare(`SELECT c.*,u.name,u.email,(SELECT COUNT(*) FROM project_articles a WHERE a.copywriter_id = c.id) AS article_count,(SELECT COUNT(*) FROM project_external_articles a WHERE a.copywriter_id = c.id) AS external_article_count FROM project_copywriters c JOIN users u ON u.id = c.user_id WHERE c.project_id = ?${where} ORDER BY c.id LIMIT ? OFFSET ?`).all(id,...page(input));
      return { rows,total };
    },
    async users(input, projectId) {
      const conditions = ['u.deleted_at IS NULL'],args=[];
      search(conditions,args,input.pattern,['u.name','u.email']);
      if (input.role && input.role !== 'all') { conditions.push('u.role = ?'); args.push(input.role); }
      const where = conditions.join(' AND ');
      const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${where}`).get(...args)).n);
      const fields = projectId ? 'u.id AS user_id,u.name,u.email,EXISTS(SELECT 1 FROM project_copywriters c WHERE c.project_id = ? AND c.user_id = u.id AND c.revoked_at IS NULL) AS on_roster' : 'u.id,u.name,u.email,u.role,u.revision';
      const rows = await db.prepare(`SELECT ${fields} FROM users u WHERE ${where} ORDER BY ${order('u.' + (input.sort || 'id'),input.direction || 'asc','u.id')} LIMIT ? OFFSET ?`).all(...(projectId ? [projectId] : []),...args,...page(input));
      return {rows,total};
    },
    async user(id) { return db.prepare('SELECT id,name,email,role FROM users WHERE id = ? AND deleted_at IS NULL').get(id); },
    async accounts(actor) { return db.prepare(`SELECT id,email,note FROM google_accounts WHERE ${actor.current_role === 'admin' ? '1=1' : 'owner_user_id = ?'} ORDER BY id LIMIT 101`).all(...(actor.current_role === 'admin' ? [] : [actor.user_id])); },
  };
};
