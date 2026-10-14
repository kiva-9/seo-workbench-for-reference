// 业务写入先形成有界计划，再把授权守卫与幂等回执放入同一原子单元。
const { normalizeTags } = require('../helpers');
const { articleStart } = require('../../lib/external-windows');
const { businessToday } = require('../../lib/business-dates');

const TABLES = { task: 'tasks', link: 'links', project: 'projects', internal: 'project_articles', external: 'project_external_articles' };
const FIELDS = {
  task: ['id', 'project_id', 'owner_user_id', 'title', 'description', 'status', 'priority', 'due_date', 'revision'],
  link: ['id', 'project_id', 'owner_user_id', 'title', 'url', 'notes', 'revision'],
  project: ['id', 'name', 'website', 'status', 'notes', 'owner_user_id', 'revision'],
};
function jsonLiteral(v) { return `'${JSON.stringify(v).replace(/'/g, "''")}'`; }
function dtoSql(type, alias = 'a') {
  if (type === 'internal' || type === 'external') {
    const fields = ['url', 'title', 'title_source', 'published_at', 'status', 'notes', 'revision', ...(type === 'internal' ? ['keyword'] : ['anchor_text', 'domain'])];
    return `json_object('ref',json_object('project_id',${alias}.project_id,'article_type','${type}','article_id',${alias}.id),` +
      fields.map((f) => `'${f}',${f === 'published_at' ? `nullif(${alias}.${f},'')` : ['notes','keyword','anchor_text'].includes(f) ? `coalesce(${alias}.${f},'')` : `${alias}.${f}`}`).join(',') +
      `,'registered_at',${alias}.created_at,'membership_id',${alias}.copywriter_id,'copywriter_user_id',(SELECT user_id FROM project_copywriters WHERE id=${alias}.copywriter_id))`;
  }
  let expr = `json_object(${FIELDS[type].map((f) => `'${f}',${f === 'due_date' ? `nullif(${alias}.${f},'')` : ['description','website','notes'].includes(f) ? `coalesce(${alias}.${f},'')` : `${alias}.${f}`}`).join(',')}`;
  if (type === 'task') expr += `,'overdue',json(CASE WHEN ${alias}.status <> 'done' AND ${alias}.due_date IS NOT NULL AND ${alias}.due_date <> '' AND ${alias}.due_date < '${businessToday()}' THEN 'true' ELSE 'false' END)`;
  if (type === 'link') expr += `,'tags',json((WITH RECURSIVE pieces(rest,tag) AS (
    SELECT COALESCE(${alias}.tags,'') || ',', NULL
    UNION ALL SELECT substr(rest,instr(rest,',')+1),substr(rest,1,instr(rest,',')-1) FROM pieces WHERE rest<>''
  ) SELECT json_group_array(trim(tag)) FROM pieces WHERE tag IS NOT NULL AND trim(tag)<>''))`;

  return expr + ')';
}
module.exports = (backend) => {
  const revisionGuard = (type, id, revision) => ({ sql: `SELECT EXISTS(SELECT 1 FROM ${TABLES[type]} WHERE id=? AND revision=?) AS ok`, args: [id, revision], code: 'CONFLICT', message: '记录已变化，请重新读取版本后重试' });
  const row = (type, id) => backend.prepare(`SELECT * FROM ${TABLES[type]} WHERE id=?`).get(id);
  const resultSql = (type, where, args, result) => ({
    sql: `SELECT json_set(${jsonLiteral(result)},'$.item',json(${dtoSql(type)}),'$.id',a.id,'$.revision',a.revision,'$.after_revision',a.revision) AS result_json FROM ${TABLES[type]} a WHERE ${where}`,
    args,
  });
  function unit(type, record, patch, { key = String(record?.id || 'new'), insert = false, remove = false, result = {}, guards = [] } = {}) {
    const table = TABLES[type];
    const at = new Date().toISOString();
    let data = { ...patch };
    if(type==='external')for(const field of ['title','anchor_text','notes'])if(data[field]==='')data[field]=null;
    if (type === 'link' && 'tags' in data) data.tags = normalizeTags(data.tags);
    if (insert) {
      data.created_at = at;
      if (['link', 'internal', 'external'].includes(type)) data.updated_at = at;
    } else if (['link', 'internal', 'external'].includes(type)) data.updated_at = at;
    const base = { changed: true, before_revision: record?.revision || null, after_revision: remove ? null : (record?.revision || 0) + 1, effects: [], ...result };
    let statement;
    if (remove) statement = backend.prepare(`DELETE FROM ${table} WHERE id=?`).bind(record.id);
    else if (insert) {
      const keys = Object.keys(data);
      statement = backend.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).bind(...keys.map((k) => data[k]));
    } else {
      const keys = Object.keys(data);
      statement = backend.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).bind(...keys.map((k) => data[k]), record.id);
    }
    return { key, guards: [...(record ? [revisionGuard(type, record.id, record.revision)] : []), ...guards], statements: [statement],
      result: { ...base, ...(remove ? { item: null, id: record.id, revision: null } : {}) },
      ...(!remove ? { resultSql: resultSql(type, insert ? 'a.id=last_insert_rowid()' : 'a.id=?', insert ? [] : [record.id], base) } : {}),
    };
  }
  return { mcpWriteRow: row, mcpWriteUnit: unit, mcpWriteRevisionGuard: revisionGuard, mcpWriteResultSql: resultSql,
    mcpArticleCreateUnit(type, projectId, data, guards = []) {
      const at = new Date().toISOString();
      const article = { project_id: projectId, ...data, title_source: data.title ? 'manual' : null, status: 'active', metrics_dirty: 1 };
      const built = unit(type, null, article, { insert: true, guards, result: { effects: ['created', 'pending_metrics', ...(data.title ? [] : ['pending_title'])] } });
      if (type === 'internal') {
        const keys = Object.keys(article); const values = keys.map(() => '?');
        built.statements = [backend.prepare(`INSERT INTO project_articles (${keys.join(',')},sort_order,fetch_revision,created_at,updated_at) VALUES (${values.join(',')},(SELECT COALESCE(MAX(sort_order),0)+1 FROM project_articles WHERE project_id=?),1,?,?)`).bind(...keys.map((k) => article[k]), projectId, at, at)];
      } else {
        const day = businessToday();
        const start = articleStart({ published_at: data.published_at, created_at: at }, day).start || day;
        const keys = Object.keys(article);
        built.statements = [backend.prepare(`INSERT INTO project_external_articles (${keys.join(',')},active_segment_started_at,segment_revision,registry_revision,created_at,updated_at) VALUES (${keys.map(() => '?').join(',')},?,1,1,?,?)`).bind(...keys.map((k) => article[k]), start, at, at)];
      }
      built.resultSql = resultSql(type, 'a.project_id=? AND a.url=?', [projectId, data.url], built.result);
      return built;
    },
  };
};
