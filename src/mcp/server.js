const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const { outputSchema } = require('../contracts/mcp-output');
const { dataOutputSchema, validateToolData } = require('../contracts/mcp-data-output');
const { BusinessError, businessDate } = require('../services/mcp-common');
const { randomUUID } = require('node:crypto');
const definitionsCache = new WeakMap();

function annotations(effect, tool) {
  const readOnly = ['R','P'].includes(effect);
  return { readOnlyHint: readOnly, destructiveHint: ['M','X'].includes(effect), idempotentHint: true,
    openWorldHint: effect === 'X' || tool.name === 'retry_operation' };
}
function errorResult(error, actor) {
  const safe = error instanceof BusinessError;
  const value = { ok: false, request_id: actor.request_id,
    error: { code: safe ? error.code : 'DATA_UNAVAILABLE', message: safe ? error.message : '业务处理失败，请重试或缩小范围',
      retryable: safe ? Boolean(error.retryable) : false, details: safe ? error.details || {} : {} } };
  return { isError: true, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
}
function prepareToolCatalog(tools) {
  let catalog = definitionsCache.get(tools);
  if (catalog) return catalog;
  const definitions = tools.map(t => ({ name: t.name, title: t.title, description: t.description,
    inputSchema: z.toJSONSchema(t.inputSchema, { io: 'input', unrepresentable: 'any' }),
    outputSchema: { ...outputSchema, oneOf: [
      { ...outputSchema.oneOf[0], properties: { ...outputSchema.oneOf[0].properties, data: dataOutputSchema(t.id) } },
      outputSchema.oneOf[1],
    ] }, annotations: annotations(t.effect, t) }));
  // 目录是无账号的静态契约；入口启动时一次准备，分页只累加字节数，不反复序列化整页。
  catalog = { definitions, sizes: definitions.map(d => Buffer.byteLength(JSON.stringify(d))) };
  definitionsCache.set(tools, catalog);
  return catalog;
}
function createProtocolServer({ tools, actor, context }) {
  const server = new Server({ name: 'seo-workbench', version: '1.0.0' }, {
    capabilities: { tools: {} },
    instructions: '按用户指令直接使用普通读写工具。幂等键采用业务日期 YYYYMMDD:<UUID> 并在重试时复用；版本从读取结果取得。预览只在解释影响或排查输入时使用。数据未知值为 null，禁止解释为零。后台任务使用 operation_id 查询结果，轮询不推进任务。',
  });
  const { definitions, sizes } = prepareToolCatalog(tools);
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    let start = 0;
    if (request.params?.cursor) {
      if (!/^tools:[0-9]+$/.test(request.params.cursor)) throw new McpError(ErrorCode.InvalidParams, '无效工具目录游标');
      start = Number(request.params.cursor.slice(6));
      if (start >= definitions.length) throw new McpError(ErrorCode.InvalidParams, '工具目录游标已失效，请重新发现');
    }
    const slice = []; let bytes = 128;
    for (let index = start; index < Math.min(start + 20, definitions.length); index++) {
      if (slice.length && bytes + sizes[index] + 1 > 240 * 1024) break;
      slice.push(definitions[index]); bytes += sizes[index] + 1;
    }
    return { tools: slice, ...(start + slice.length < definitions.length ? { nextCursor: `tools:${start + slice.length}` } : {}) };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = tools.find(t => t.name === request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, '未知或未开放的工具');
    const max = ['T29','T30'].includes(tool.id) ? 256 * 1024 : 64 * 1024;
    if (Buffer.byteLength(JSON.stringify(request.params.arguments || {})) > max) {
      return errorResult(new BusinessError('RANGE_TOO_LARGE','工具输入过大，请分批提交', { max_bytes: max }), actor);
    }
    const parsed = tool.inputSchema.safeParse(request.params.arguments || {});
    if (!parsed.success) return errorResult(new BusinessError('VALIDATION_ERROR','参数不符合工具契约', {
      issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      ...(parsed.error.issues.some(i => i.message.includes('SEARCH_PATTERN_TOO_LONG')) ? { reason: 'SEARCH_PATTERN_TOO_LONG' } : {}),
      ...(tool.id === 'T05' && parsed.error.issues.some(i => i.code === 'invalid_value' && ['metrics','sort'].includes(i.path[0]))
        ? { reason: 'UNSUPPORTED_METRIC' } : {}),
    }), actor);
    const backend = context.db.db, time = new Date().toISOString(), requestLease = randomUUID();
    let acquired = false;
    try {
      const claim = await backend.prepare(`INSERT INTO mcp_request_leases(id,user_id,expires_at)
        SELECT ?,?,? WHERE (SELECT COUNT(*) FROM mcp_request_leases WHERE user_id=? AND expires_at>?)<2`)
        .run(requestLease,actor.user_id,new Date(Date.parse(time)+60_000).toISOString(),actor.user_id,time);
      if (!Number(claim.changes)) throw new BusinessError('BUSY','当前账号已有两个调用，请退避重试',{ retry_after_seconds: 2 },true);
      acquired = true;
      const output = await tool.handler(parsed.data, actor);
      if (!output || typeof output.data !== 'object' || output.data === null || Array.isArray(output.data)) {
        throw new BusinessError('DATA_UNAVAILABLE','工具输出不符合公开契约');
      }
      if (!validateToolData(tool.id, output.data).success) {
        throw new BusinessError('DATA_UNAVAILABLE','工具输出不符合公开契约',
          output.data.operation_id ? { operation_id: output.data.operation_id } : {});
      }
      const value = { ok: true, contract_version: '1', request_id: actor.request_id, data: output.data,
        meta: { generated_at: new Date().toISOString(), business_date: businessDate(), timezone: 'Asia/Shanghai',
          effective_filters: ['R','P'].includes(tool.effect) && !['T29','T32'].includes(tool.id) ? parsed.data : {}, consistency: 'live', pagination: null, warnings: [], calculation_version: null,
          ...output.meta } };
      const result = { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
      if (Buffer.byteLength(JSON.stringify(result)) > 250 * 1024) return errorResult(new BusinessError('BUDGET_EXCEEDED',
        '响应过大，请减少 page_size 或分节查询', { max_bytes: 256 * 1024, ...(output.data.operation_id ? { operation_id: output.data.operation_id, committed: true } : {}) }), actor);
      return result;
    } catch (error) { return errorResult(error, actor); }
    finally {
      // 无论调用成功还是失败，都释放该账号的并发租约。
      if (acquired) await backend.prepare('DELETE FROM mcp_request_leases WHERE id=?').run(requestLease);
    }
  });
  return server;
}
module.exports = { createProtocolServer, prepareToolCatalog, errorResult };
