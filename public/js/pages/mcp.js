import { beginPageRender } from '../page-lifecycle.js';
import { renderMcpTokenSettings } from '../components/mcp-token-settings.js';
import { renderMcpToolCatalog } from '../components/mcp-tool-catalog.js';

export async function renderMcp(el) {
  const isCurrent = beginPageRender(el);
  el.innerHTML = `
    <div class="page-head mcp-page-head">
      <div><h2>MCP</h2><p class="page-desc">连接 AI 客户端，查询项目表现、维护文章与任务，并跟进后台处理。</p></div>
    </div>
    <div class="settings-workspace mcp-workspace">
      <nav class="tabs mcp-page-tabs" role="tablist" aria-label="MCP 页面分区">
        <button type="button" class="tab active" id="mcp-tab-management" role="tab" aria-controls="mcp-management" aria-selected="true" tabindex="0">MCP 管理</button>
        <button type="button" class="tab" id="mcp-tab-tools" role="tab" aria-controls="mcp-tool-catalog" aria-selected="false" tabindex="-1">工具使用指南</button>
      </nav>
      <section class="mcp-tab-panel mcp-management-grid" id="mcp-management" role="tabpanel" aria-labelledby="mcp-tab-management" tabindex="0">
        <section class="card" id="mcp-token-card" aria-label="个人 MCP Token"></section>
        <section class="card mcp-guide" aria-labelledby="mcp-connect-heading">
          <div class="section-heading"><div>
            <h3 id="mcp-connect-heading">连接指南</h3>
            <p class="hint">客户端需支持远程 MCP（Streamable HTTP）及 Bearer Token 或自定义请求头。</p>
          </div></div>
          <ol class="mcp-steps">
            <li><h4>生成个人 Token</h4><p>在「个人 MCP Token」中生成并保存完整 Token。它只显示一次，刷新或离开页面后无法再次查看；遗失后可重置。</p></li>
            <li><h4>添加远程 MCP 服务</h4><p>复制「个人 MCP Token」中的服务地址，填入客户端的 MCP 服务配置，传输方式选择 <code>Streamable HTTP</code>。</p></li>
            <li><h4>设置认证</h4><p>如果客户端提供 Bearer Token 输入框，只填写 Token。使用自定义请求头时，名称填 <code>Authorization</code>，值填：</p>
              <pre class="mcp-example"><code>Bearer &lt;你的 Token&gt;</code></pre>
              <p class="hint">Bearer 后有一个空格。将示例占位符替换为完整 Token，使用客户端的凭证设置保存。</p></li>
            <li><h4>连接并获取工具</h4><p>保存后连接服务并刷新工具列表。首次使用可让客户端“列出我能访问的项目”，确认连接及项目范围。</p></li>
          </ol>
        </section>
      </section>
      <section class="card mcp-catalog mcp-tab-panel" id="mcp-tool-catalog" role="tabpanel" aria-labelledby="mcp-tab-tools" tabindex="0" hidden></section>
    </div>
    <button type="button" class="btn mcp-back-to-top" aria-label="回到顶部" title="回到顶部" hidden>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-7 7 7-7 7 7"/></svg>
    </button>`;
  if (!isCurrent()) return;
  const tabs = [...el.querySelectorAll('.mcp-page-tabs [role="tab"]')];
  const catalogPanel = el.querySelector('#mcp-tool-catalog');
  const backToTop = el.querySelector('.mcp-back-to-top');
  function updateBackToTop() {
    backToTop.hidden = !isCurrent() || catalogPanel.hidden || window.scrollY < 320;
  }
  function selectTab(selectedTab) {
    if (!isCurrent()) return;
    for (const tab of tabs) {
      const selected = tab === selectedTab;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      el.querySelector(`#${tab.getAttribute('aria-controls')}`).hidden = !selected;
    }
    updateBackToTop();
  }
  tabs.forEach((tab, index) => {
    tab.onclick = () => selectTab(tab);
    tab.onkeydown = event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    };
  });
  backToTop.onclick = () => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
    tabs[1].focus({ preventScroll: true });
  };
  window.addEventListener('scroll', updateBackToTop, { passive: true });
  window.addEventListener('seo-route-change', () => window.removeEventListener('scroll', updateBackToTop), { once: true });
  updateBackToTop();
  // 保持面板挂载，切换时保留 Token 输入和工具筛选，也避免重复请求。
  await Promise.all([
    renderMcpTokenSettings(el.querySelector('#mcp-token-card')),
    renderMcpToolCatalog(el.querySelector('#mcp-tool-catalog')),
  ]);
}
