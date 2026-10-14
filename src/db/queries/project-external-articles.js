// project-external-articles.js —— 外链文章/平台日数据查询（任务10）
// 平台身份 = 项目 × 域名。日数据按（项目,域名,日期,来源,指纹）分行存：
// 换指纹旧行不删，当前 SUM 只算当前指纹。写入守卫与站内月度同构（修订/指纹不匹配不生效）。
// 冻结行为在任务11；本文件只提供结构读写在任务11 之前必需的部分。

const { normalizeDomain } = require('../../lib/domain');
const { articleStart } = require('../../lib/external-windows');
const { businessDay } = require('../../lib/business-dates');

module.exports = (db) => ({
  // ============ 读 ============

  listExternalArticles: async (projectId) => db.prepare(
    'SELECT * FROM project_external_articles WHERE project_id = ? ORDER BY created_at ASC, id ASC'
  ).all(projectId),

  getExternalArticle: async (id) => db.prepare('SELECT * FROM project_external_articles WHERE id = ?').get(id),

  findExternalArticleByUrl: async (projectId, url) =>
    db.prepare('SELECT * FROM project_external_articles WHERE project_id = ? AND url = ?').get(projectId, url),

  // 项目下出现过的平台域名（含 inactive 文章的域名——窗口按完整登记清单切，任务11）
  listProjectDomains: async (projectId) => db.prepare(
    'SELECT DISTINCT domain FROM project_external_articles WHERE project_id = ? ORDER BY domain'
  ).all(projectId),

  // 当前指纹下的平台日数据和（users / events 分别 SUM；旧指纹行天然被 WHERE 排除）
  sumDailyByDomain: async (projectId, domain, startDate, endDate, fingerprint) => db.prepare(
    `SELECT source, SUM(value) AS total, COUNT(*) AS days, MIN(date) AS first_day, MAX(date) AS last_day
     FROM project_external_daily_metrics
     WHERE project_id = @pid AND domain = @domain AND date >= @start AND date <= @end
       AND config_fingerprint = @fp
     GROUP BY source`
  ).all({ pid: projectId, domain, start: startDate, end: endDate, fp: fingerprint }),

  // 平台月状态（任务11 的定稿/覆盖判断用）
  getMonthState: async (projectId, domain, month) =>
    db.prepare('SELECT * FROM project_external_month_state WHERE project_id = ? AND domain = ? AND month = ?').get(projectId, domain, month),

  listMonthStates: async (projectId) => db.prepare(
    'SELECT * FROM project_external_month_state WHERE project_id = ? ORDER BY month DESC, domain'
  ).all(projectId),

  // 归档（只读核对）：旧 id → 新文章映射 + 累计 + 水位
  // ============ 写：登记 ============

  // 配置变化（关键事件集合）→ 项目下外链标 dirty
  markExternalArticlesDirty: async (projectId, at) => {
    const info = await db.prepare(
      'UPDATE project_external_articles SET metrics_dirty = 1, updated_at = @at WHERE project_id = @pid'
    ).run({ pid: projectId, at });
    return Number(info.changes || 0);
  },

  createExternalArticle: async (projectId, data, at) => {
    const url = String(data.url ?? '').trim();
    const domain = data.domain || normalizeDomain(url);
    if (!url) throw new Error('URL 必填');
    if (!domain) throw new Error('无法从 URL 解析域名（需要合法 http(s):// 地址）');
    // 初始活跃段从「有效发布起点」开始（缺/未来发布日回落到登记日）——任务11 第3条
    const day = businessDay(new Date(at));
    const startInfo = articleStart({ published_at: data.published_at ?? null, created_at: at }, day);
    const segmentStart = startInfo.start || day;
    const info = await db.prepare(
      `INSERT INTO project_external_articles
        (project_id, url, domain, domain_source, title, title_source, anchor_text, notes, copywriter_id,
         published_at, status, active_segment_started_at, segment_revision, registry_revision,
         metrics_dirty, created_at, updated_at)
       VALUES (@pid, @url, @domain, @source, @title, @titleSource, @anchor, @notes, @cw, @pub, 'active',
         @seg, 1, 1, 1, @at, @at)`
    ).run({
      pid: projectId, url, domain, source: data.domain_source || 'auto',
      title: data.title ?? null, titleSource: String(data.title || '').trim() ? 'manual' : null, anchor: data.anchor_text ?? null, notes: data.notes ?? null,
      cw: data.copywriter_id ?? null, pub: data.published_at ?? null, seg: segmentStart, at,
    });
    return Number(info.lastInsertRowid);
  },

  // ============ 写：平台日数据（守卫） ============

  // 单来源多行日数据写入。rows: [{ date, value }]。
  // 只写当前指纹的行；旧指纹行保留在表里但不进当前 SUM（SUM 侧按指纹过滤）。
  // 返回 bound statement（调用方按「域名×来源×日期块」单元 batchAtomic）。
  dailyWriteStmt(source, projectId, domain, rows, { fingerprint, fetchedAt }) {
    const named = {
      pid: projectId, domain, src: source, fp: fingerprint,
      fa: fetchedAt || new Date().toISOString(),
      rows: JSON.stringify(rows.map(r=>({date:r.date,value:Number(r.value||0)}))),
    };
    const sql = 'INSERT INTO project_external_daily_metrics ' +
      '(project_id, domain, date, source, value, config_fingerprint, fetched_at) ' +
      // WHERE true 不能省：INSERT…SELECT 后面直接跟 ON CONFLICT，SQLite 解析器会歧义报错
      "SELECT @pid, @domain, json_extract(s.value,'$.date'), @src, json_extract(s.value,'$.value'), @fp, @fa FROM json_each(@rows) AS s WHERE true " +
      'ON CONFLICT (project_id, domain, date, source, config_fingerprint) DO UPDATE SET ' +
      'value = excluded.value, fetched_at = excluded.fetched_at';
    return db.prepare(sql).bind(named);
  },

  // 月状态 UPSERT（守卫：项目归属由调用方保证；这里按 (project, domain, month) 写）
  monthStateStmt(projectId, domain, month, patch) {
    const at = new Date().toISOString();
    const cols = ['users_status', 'events_status', 'users_cover_start', 'users_cover_end',
      'events_cover_start', 'events_cover_end', 'users_fetched_at', 'events_fetched_at',
      'users_fingerprint', 'events_fingerprint', 'finalized', 'error'];
    const named = { pid: projectId, domain, month, at };
    const provided = cols.filter((c) => c in patch && patch[c] !== undefined);
    for (const c of provided) named[c] = patch[c];
    // INSERT 与 DO UPDATE 两条路径都带本次提供的列——不然首次插入后，
    // 后续只写另一来源的 patch 永远补不上先写来源的覆盖/指纹列
    const insertCols = ['project_id', 'domain', 'month', ...provided, 'updated_at'];
    const insertVals = ['@pid', '@domain', '@month', ...provided.map((c) => '@' + c), '@at'];
    const updateSets = provided.map((c) => c + ' = @' + c);
    const sql = 'INSERT INTO project_external_month_state (' + insertCols.join(', ') + ') ' +
      'VALUES (' + insertVals.join(', ') + ') ' +
      'ON CONFLICT (project_id, domain, month) DO UPDATE SET ' +
      [...updateSets, 'updated_at = @at'].join(', ');
    return db.prepare(sql).bind(named);
  },

  // 同步结束清 dirty（守卫：登记修订没变才清）
  clearExternalDirty: async (articleId, expectedRevision) => {
    const info = await db.prepare(
      'UPDATE project_external_articles SET metrics_dirty = 0 WHERE id = @id AND registry_revision = @rev'
    ).run({ id: articleId, rev: expectedRevision });
    return Number(info.changes || 0) > 0;
  },


  // ============ 读：管理清单（任务12） ============

  countExternalArticles: async (projectId) =>
    Number((await db.prepare('SELECT COUNT(*) AS n FROM project_external_articles WHERE project_id = ?').get(projectId)).n),

  // 管理清单分页 + 搜索（服务端分页，不停用记录也可管理）
  listExternalArticlesPaged: async (projectId, { q = '', status = '', page = 1, pageSize = 50 } = {}) => {
    // 列名都带 a. 前缀： LEFT JOIN 之后裸 project_id/status/url 会歧义
    const conds = ['a.project_id = @pid'];
    const named = { pid: projectId };
    if (q && String(q).trim()) {
      conds.push('(a.url LIKE @q OR a.title LIKE @q OR a.anchor_text LIKE @q)');
      named.q = `%${String(q).trim()}%`;
    }
    if (status && ['active', 'inactive'].includes(status)) {
      conds.push('a.status = @status');
      named.status = status;
    }
    const cond = conds.join(' AND ');
    const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM project_external_articles a WHERE ${cond}`).get(named)).n);
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
    const p = Math.max(Number(page) || 1, 1);
    const rows = await db.prepare(
      `SELECT a.*, u.name AS copywriter_name, u.email AS copywriter_email
       FROM project_external_articles a
       LEFT JOIN project_copywriters c ON c.id = a.copywriter_id
       LEFT JOIN users u ON u.id = c.user_id
       WHERE ${cond} ORDER BY a.created_at ASC, a.id ASC LIMIT @lim OFFSET @off`
    ).all({ ...named, lim: size, off: (p - 1) * size });
    return { rows, total, page: p, pageSize: size };
  },

  // ============ 写：登记编辑（任务12） ============

  // 元数据 + 文案师指派。URL / 域名不走这里（见 changeExternalArticleUrl / freezes.changeArticleDomain）。
  updateExternalArticle: async (articleId, patch, at) => {
    const cols = ['title', 'anchor_text', 'notes', 'published_at', 'copywriter_id'];
    const sets = [];
    const named = { id: articleId, at };
    for (const c of cols) {
      if (c in patch) { sets.push(`${c} = @${c}`); named[c] = patch[c] ?? null; }
    }
    if (!sets.length) return 0;
    if ('title' in patch) sets.push("title_source = 'manual'", 'title_fetch_status = NULL', 'title_fetch_error = NULL');
    sets.push('updated_at = @at');
    const info = await db.prepare(
      `UPDATE project_external_articles SET ${sets.join(', ')} WHERE id = @id`
    ).run(named);
    return Number(info.changes || 0);
  },

  // 改 URL：auto 域名文章 = 换平台（先按旧域名关段再开新域名段）；manual 域名文章只改 URL。
  async changeExternalArticleUrl(articleId, newUrl, at, { planOnly = false, ignorePlatform = false } = {}) {
    const url = String(newUrl ?? '').trim();
    if (!url) throw new Error('URL 必填');
    const article = await db.prepare('SELECT * FROM project_external_articles WHERE id = ?').get(articleId);
    if (!article) throw new Error('外链文章不存在');
    if (article.url === url) return { ok: true, changed: false };
    const clash = await db.prepare(
      'SELECT id FROM project_external_articles WHERE project_id = ? AND url = ? AND id != ?'
    ).get(article.project_id, url, articleId);
    if (clash) throw new Error('该 URL 已在本项目登记');
    const newDomain = normalizeDomain(url);
    if (!newDomain) throw new Error('无法从新 URL 解析域名');
    if (!ignorePlatform && article.domain_source === 'auto' && newDomain !== article.domain) {
      // 换平台需要冻结语义（关旧段开新段），由路由层调 freezes.changeArticleDomain 编排
      return { ok: false, reason: 'platform-change-required', newDomain };
    }
    const statement = db.prepare(
      `UPDATE project_external_articles SET url = @url, updated_at = @at,
         title = CASE WHEN title_source IS NOT 'manual' THEN NULL ELSE title END,
         title_fetch_status = CASE WHEN title_source IS NOT 'manual' THEN 'pending' ELSE title_fetch_status END,
         title_fetch_attempts = CASE WHEN title_source IS NOT 'manual' THEN 0 ELSE title_fetch_attempts END,
         title_fetch_error = CASE WHEN title_source IS NOT 'manual' THEN NULL ELSE title_fetch_error END,
         title_fetched_at = CASE WHEN title_source IS NOT 'manual' THEN NULL ELSE title_fetched_at END,
         title_source = CASE WHEN title_source IS NOT 'manual' THEN NULL ELSE title_source END
       WHERE id = @id`
    ).bind({ url, at, id: articleId });
    if (planOnly) return { ok: true, changed: true, statements: [statement] };
    const info = (await db.batchAtomic([statement]))[0];
    return { ok: Number(info.changes || 0) > 0, changed: true };
  },

  // 地址及平台变化共享完整原子计划，避免关闭旧段后地址写入失败。
  async buildExternalUrlChangeUnit(articleId, newUrl, at, opts = {}) {
    const direct = await this.changeExternalArticleUrl(articleId, newUrl, at, { planOnly: true });
    if (direct.ok) return direct;
    if (direct.reason !== 'platform-change-required') return direct;
    const domain = await this.buildExternalDomainChangeUnit(articleId, direct.newDomain, { ...opts, domainSource: 'auto' });
    if (!domain.ok) return domain;
    const address = await this.changeExternalArticleUrl(articleId, newUrl, at, { planOnly: true, ignorePlatform: true });
    return { ok: true, changed: true, statements: [...domain.statements, ...address.statements], platformChanged: true, frozenSegments: domain.frozenSegments };
  },

  // 批量指派（集合 UPDATE + 名单资格 EXISTS，同语句校验；模式 fill_empty/overwrite）
  assignExternalArticles: async (projectId, articleIds, copywriterId, mode = 'fill_empty', at) => {
    const ids = [...new Set((articleIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return { ok: false, reason: '没有指定文章' };
    // node:sqlite 的命名参数对象要求键与 SQL 精确匹配（多给键会抛 Unknown named
    // parameter），所以所有权查询单独构造只含 pid + id 的参数对象
    const idParams = {};
    const inList = ids.map((id, i) => { idParams['a' + i] = id; return '@a' + i; }).join(',');
    const own = await db.prepare(`SELECT id FROM project_external_articles WHERE project_id = @pid AND id IN (${inList})`).all({ pid: projectId, ...idParams });
    const ownIds = new Set(own.map((r) => Number(r.id)));
    const rejected = ids.filter((id) => !ownIds.has(id));
    if (rejected.length) return { ok: false, reason: '这些文章不属于该项目', rejected };
    const fillOnly = mode !== 'overwrite';
    const info = await db.prepare(
      `UPDATE project_external_articles SET copywriter_id = @cw, updated_at = @at
       WHERE project_id = @pid AND id IN (${inList})
         AND (@cw IS NULL
           OR EXISTS (SELECT 1 FROM project_copywriters c
                      WHERE c.project_id = @pid AND c.id = @cw AND c.revoked_at IS NULL))
       ${fillOnly ? 'AND copywriter_id IS NULL' : ''}`
    ).run({ pid: projectId, cw: copywriterId ?? null, at, ...idParams });
    return { ok: true, updated: Number(info.changes || 0) };
  },

  // 删除单篇：若是平台最后一条登记，同单元清理平台日数据与月状态
  // （冻结行随文章外键级联；重新登记必须重新判定覆盖，不能复用旧 complete）
  async deleteExternalArticle(articleId) {
    const article = await db.prepare('SELECT * FROM project_external_articles WHERE id = ?').get(articleId);
    if (!article) return { ok: false, reason: '外链文章不存在' };
    const at = new Date().toISOString();
    const results = await db.batchAtomic([
      db.prepare('DELETE FROM project_external_article_freezes WHERE article_id = ?').bind(articleId),
      db.prepare('DELETE FROM project_external_articles WHERE id = ?').bind(articleId),
      // 平台没有登记文章了才清日数据/月状态（NOT EXISTS 保证不影响仍登记的域名）
      db.prepare(
        `DELETE FROM project_external_daily_metrics
         WHERE project_id = @pid AND domain = @domain
           AND NOT EXISTS (SELECT 1 FROM project_external_articles WHERE project_id = @pid AND domain = @domain)`
      ).bind({ pid: article.project_id, domain: article.domain }),
      db.prepare(
        `DELETE FROM project_external_month_state
         WHERE project_id = @pid AND domain = @domain
           AND NOT EXISTS (SELECT 1 FROM project_external_articles WHERE project_id = @pid AND domain = @domain)`
      ).bind({ pid: article.project_id, domain: article.domain }),
    ]);
    return {
      ok: Number(results[1].changes || 0) > 0,
      cleanedPlatform: Number(results[2].changes || 0) > 0 || Number(results[3].changes || 0) > 0,
    };
  },
});
