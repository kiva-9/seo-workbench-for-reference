const { z } = require('zod');
const { businessToday, isValidDay, isValidMonth, shiftMonth } = require('../lib/business-dates');

class BusinessError extends Error {
  constructor(code, message, details = {}, retryable = false) {
    super(message); this.name = 'BusinessError'; this.code = code;
    this.details = details; this.retryable = retryable;
  }
}
function fail(code, message, details = {}, retryable = false) {
  throw new BusinessError(code, message, details, retryable);
}
const actorUserId = (actor) => actor.user_id;
async function assertProject(db, actor, id) {
  if (!await db.canAccessProject(id, actor.user_id, actor.current_role === 'admin')) {
    fail('NOT_FOUND', '项目不存在或不可访问');
  }
  const project = await db.getProject(id);
  if (!project) fail('NOT_FOUND', '项目不存在或不可访问');
  return project;
}
function assertAdmin(actor) {
  if (actor.current_role !== 'admin') fail('FORBIDDEN', '仅管理员可调用此工具');
}
const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const dateSchema = z.string().refine(isValidDay, '日期必须是实际存在的 YYYY-MM-DD');
const monthSchema = z.string().refine(isValidMonth, '月份必须是 YYYY-MM');
const pageSchema = z.object({ page: z.number().int().min(1).max(1_000_000).default(1), page_size: z.number().int().min(1).max(100).default(50) });
const projectScopeSchema = z.object({ project_ids: z.array(idSchema).min(1).max(20).refine(a => new Set(a).size === a.length, '项目 ID 不可重复').optional() });
const articleRefSchema = z.object({ project_id: idSchema, article_type: z.enum(['internal', 'external']), article_id: idSchema }).strict();
const monthPeriodSchema = z.object({ mode: z.literal('months'), from: monthSchema, to: monthSchema, include_provisional: z.boolean().default(false) }).strict()
  .refine(p => p.from <= p.to && p.to <= shiftMonth(p.from, 11), '指标范围必须正序且最多 12 个月');
const periodSchema = z.union([z.object({ mode: z.literal('cumulative') }).strict(), monthPeriodSchema]);
const searchSchema = z.string().trim().max(100).refine(s => Buffer.byteLength(`%${s.replace(/[\\%_]/g, '\\$&')}%`) <= 50, 'SEARCH_PATTERN_TOO_LONG：请缩短关键词');
function pagination(page, page_size, total, returned_count) {
  return { page, page_size, returned_count, total, has_more: total === null ? returned_count === page_size : page * page_size < total,
    ...(total === null ? { total_status: 'not_computed' } : {}) };
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
module.exports = { z, BusinessError, fail, assertProject, assertAdmin, actorUserId, businessDate: businessToday,
  validateDate: isValidDay, validateMonth: isValidMonth, dateSchema, monthSchema, idSchema,
  pagination, pageSchema, projectScopeSchema, articleRefSchema, periodSchema, monthPeriodSchema, searchSchema, canonicalJson };
