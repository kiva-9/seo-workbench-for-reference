const { createMutationService } = require('../services/mcp-mutations');
const { assertAdmin } = require('../services/mcp-common');
const { groups, guides } = require('./tool-guides');
const adminTools = new Set(['T15', 'T41', 'T42', 'T43', 'T52']);
const backgroundTools = new Set(['T33', 'T35', 'T36', 'T37']);

function toolEnabled(tool, config) {
  return tool.phase <= (config.MCP_PHASE || 1) && (config.MCP_BACKGROUND_ENABLED || !tool.requires_background);
}
function toolCatalog(registry, config, role) {
  const tools = registry.all.map(tool => {
    const restrictions = [];
    if (!config.MCP_ENABLED) restrictions.push({ code: 'MCP_DISABLED', message: 'MCP 服务未启用' });
    if (tool.phase > (config.MCP_PHASE || 1)) restrictions.push({ code: 'PHASE_DISABLED', message: '当前环境尚未开放此工具' });
    if (tool.requires_background && !config.MCP_BACKGROUND_ENABLED) restrictions.push({ code: 'BACKGROUND_DISABLED', message: '需启用后台任务' });
    if (tool.requires_admin && role !== 'admin') restrictions.push({ code: 'ADMIN_REQUIRED', message: '仅管理员可调用' });
    return { id: tool.id, name: tool.name, title: tool.title, description: tool.description, example: tool.example,
      group: tool.group, effect: tool.effect,
      phase: tool.phase, requires_admin: tool.requires_admin, requires_background: tool.requires_background,
      available: restrictions.length === 0, restrictions };
  });
  return { tools, groups: groups.filter(group => tools.some(tool => tool.group === group.id)),
    total: tools.length, available_count: tools.filter(t => t.available).length };
}

function createRegistry(deps) {
  const mutations = createMutationService(deps);
  const context = { ...deps, mutations, mutate: mutations.mutate };
  const reads = require('../services/mcp-read')(context);
  context.getReadTools = () => reads;
  const writes = require('../services/mcp-write').createWriteTools(context);
  context.getWriteTools = () => writes;
  const operations = require('../services/mcp-operations').createOperationTools(context);
  const all = [...reads, ...writes, ...operations].map(tool => ({ ...tool,
    title: guides[tool.id]?.title || tool.title, description: guides[tool.id]?.description || tool.description,
    group: guides[tool.id]?.group || 'other', example: guides[tool.id]?.example || null,
    requires_admin: adminTools.has(tool.id), requires_background: backgroundTools.has(tool.id),
    // 目录和协议入口共用角色要求；具体写入仍由业务服务在提交时再次校验。
    handler: async (input, actor) => { if (adminTools.has(tool.id)) assertAdmin(actor); return tool.handler(input, actor); },
  }));
  const names = new Set(), ids = new Set();
  for (const tool of all) {
    if (names.has(tool.name) || ids.has(tool.id)) throw new Error('MCP 能力重复注册');
    names.add(tool.name); ids.add(tool.id);
  }
  return { context, all, tools: all.filter(t => toolEnabled(t, deps.config)) };
}
module.exports = { createRegistry, toolCatalog };
