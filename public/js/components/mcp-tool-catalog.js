import { API } from '../api.js';
import { beginPageRender } from '../page-lifecycle.js';

const categories = { read: '读取与分析', write: '写入与管理', plan: '计划与预览', background: '长任务' };
const categoryOf = tool => tool.requires_background || ['X', 'E'].includes(tool.effect) ? 'background'
  : tool.effect === 'P' ? 'plan' : ['W', 'M'].includes(tool.effect) ? 'write' : 'read';

export async function renderMcpToolCatalog(container) {
  const isCurrent = beginPageRender(container), esc = window.esc;
  let catalog;
  try { catalog = await API.mcpTools(); }
  catch (error) { if (isCurrent()) container.textContent = error.message; return; }
  if (!isCurrent()) return;
  const byGroup = group => catalog.tools.filter(tool => tool.group === group.id);
  function card(tool) { return `<article class="mcp-tool-item" data-mcp-tool-name="${esc(tool.name)}">
      <div class="section-heading"><h4>${esc(tool.title)}</h4><span class="tag ${tool.available ? 'tag-green' : 'tag-gray'}">${tool.available ? '当前可用' : '当前受限'}</span></div>
      <code class="mcp-tool-name">${esc(tool.name)}</code><p class="mcp-tool-description">${esc(tool.description)}</p>
      <p class="hint">${categories[categoryOf(tool)]}${tool.requires_admin ? ' · 仅管理员' : ''}${tool.requires_background ? ' · 需要后台任务' : ''}</p>
      ${tool.restrictions.length ? `<ul class="mcp-tool-restrictions">${tool.restrictions.map(reason => `<li>${esc(reason.message)}</li>`).join('')}</ul>` : ''}
      ${tool.example ? `<div class="mcp-tool-example"><div class="mcp-example-heading"><span>试着这样说</span>
        <button type="button" class="btn btn-sm" data-mcp-copy-example="${esc(tool.name)}" aria-label="复制${esc(tool.title)}的示例">复制示例</button></div>
        <p>${esc(tool.example)}</p></div>` : ''}</article>`; }
  container.innerHTML = `<div class="section-heading"><div><h3>工具使用指南</h3>
    <p class="hint">完整目录 ${catalog.total} 项 · 当前可用 ${catalog.available_count} 项 · 按 ${catalog.groups.length} 个工作目的分组</p></div></div>
    <div class="mcp-tutorial"><h4>从一句需求开始</h4>
      <p>连接后直接向 AI 客户端描述你要做的事，带上项目、文章或时间范围。无需记住工具名称，客户端会选择对应工具。</p>
      <div class="mcp-scenarios"><div><h5>了解项目表现</h5><p>“找到「示例站点」，分析 9 月文章表现，列出点击最高的文章。”</p></div>
        <div><h5>安排日常工作</h5><p>“列出本周到期和已逾期的任务，把已完成的检查任务更新为完成。”</p></div>
        <div><h5>批量整理文章</h5><p>“先检查这份文章表格，说明重复和错误，再按我指定的方式导入。”</p></div></div>
      <p class="hint">把“示例站点”和日期换成你的实际范围。下方逐项示例可复制到客户端；工具须显示为当前可用，项目也须在你的权限范围内。</p>
      <p class="mcp-operation-tip"><strong>同步、抓标题或导出：</strong>先了解范围 → 提交处理 → 查看进度 → 领取结果。后台处理可能需要时间，读取进度不会重新启动任务。</p>
    </div>
    <p class="hint">绿色表示当前账号在此环境可调用，灰色工具会说明限制。无需创建 Token 即可阅读；查看目录、搜索或复制示例都不会执行工具。</p>
    <nav class="mcp-group-nav" aria-label="工具用途导航">${catalog.groups.map(group => `<button type="button" class="btn btn-sm" data-mcp-group-jump="${esc(group.id)}">${esc(group.title)} <span>${byGroup(group).length}</span></button>`).join('')}</nav>
    <div class="mcp-catalog-filters"><div class="form-row"><label for="mcp-tool-search">搜索工具或需求</label>
      <input id="mcp-tool-search" type="search" placeholder="例如：月报、指派、导出、list_projects"></div>
      <div class="form-row"><label for="mcp-tool-category">操作类型</label><select id="mcp-tool-category"><option value="">全部类型</option>
      ${Object.entries(categories).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div>
      <div class="form-row"><label for="mcp-tool-availability">当前状态</label><select id="mcp-tool-availability"><option value="">全部状态</option><option value="available">当前可用</option><option value="restricted">当前受限</option></select></div></div>
    <div class="mcp-catalog-actions"><p class="hint" id="mcp-catalog-count" role="status" aria-live="polite">显示全部 ${catalog.total} 项工具</p>
      <div><button type="button" class="btn btn-sm" data-mcp-expand-all>展开全部</button><button type="button" class="btn btn-sm" data-mcp-collapse-all>收起全部</button></div></div>
    <div class="mcp-tool-groups">${catalog.groups.map(group => `<details class="mcp-tool-group" id="mcp-group-${esc(group.id)}" data-mcp-group="${esc(group.id)}" open>
      <summary><div><h4>${esc(group.title)}</h4><p class="hint">${esc(group.description)}</p></div><span class="tag" data-mcp-group-count>${byGroup(group).length} 项</span></summary>
      <div class="mcp-tool-grid">${byGroup(group).map(card).join('')}</div></details>`).join('')}</div>
    <p class="hint" id="mcp-catalog-empty" hidden>没有匹配的工具，请调整搜索、类型或状态。</p>`;
  const search = container.querySelector('#mcp-tool-search'), category = container.querySelector('#mcp-tool-category');
  const availability = container.querySelector('#mcp-tool-availability');
  const cards = new Map([...container.querySelectorAll('[data-mcp-tool-name]')].map(card => [card.dataset.mcpToolName, card]));
  const groupElements = [...container.querySelectorAll('[data-mcp-group]')];
  function filter() {
    const query = search.value.trim().toLowerCase();
    let visible = 0; const counts = new Map();
    catalog.tools.forEach(tool => {
      const hidden = Boolean((category.value && categoryOf(tool) !== category.value)
        || (availability.value === 'available' && !tool.available) || (availability.value === 'restricted' && tool.available)
        || !`${tool.name} ${tool.title} ${tool.description} ${tool.example || ''}`.toLowerCase().includes(query));
      cards.get(tool.name).hidden = hidden;
      if (!hidden) { visible++; counts.set(tool.group, (counts.get(tool.group) || 0) + 1); }
    });
    groupElements.forEach(group => {
      const count = counts.get(group.dataset.mcpGroup) || 0;
      group.hidden = count === 0;
      group.querySelector('[data-mcp-group-count]').textContent = `${count} 项`;
      if (count && (query || category.value || availability.value)) group.open = true;
    });
    container.querySelector('#mcp-catalog-count').textContent = `显示 ${visible} / ${catalog.total} 项工具`;
    container.querySelector('#mcp-catalog-empty').hidden = visible !== 0;
  }
  search.oninput = filter; category.onchange = filter; availability.onchange = filter;
  container.querySelector('[data-mcp-expand-all]').onclick = () => groupElements.forEach(group => { group.open = true; });
  container.querySelector('[data-mcp-collapse-all]').onclick = () => groupElements.forEach(group => { group.open = false; });
  for (const button of container.querySelectorAll('[data-mcp-group-jump]')) button.onclick = () => {
    search.value = ''; category.value = ''; availability.value = ''; filter();
    const group = groupElements.find(group => group.dataset.mcpGroup === button.dataset.mcpGroupJump);
    group.open = true; group.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  for (const button of container.querySelectorAll('[data-mcp-copy-example]')) button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(catalog.tools.find(tool => tool.name === button.dataset.mcpCopyExample).example);
      window.toast('示例已复制，请替换项目和时间后发给客户端', 'ok');
    } catch { window.toast('复制失败，请选中示例文字手动复制', 'err'); }
  };
}
