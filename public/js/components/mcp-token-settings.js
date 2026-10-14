import { API } from '../api.js';
import { beginPageRender } from '../page-lifecycle.js';

export async function renderMcpTokenSettings(container, issued = null) {
  const isCurrent = beginPageRender(container);
  const esc = window.esc;
  let status;
  try { status = await API.mcpTokenStatus(); }
  catch (error) { if (isCurrent()) container.textContent = error.message; return; }
  if (!isCurrent()) return;
  const endpoint = `${location.origin}/mcp`;
  const full = status.active_count >= status.limit;
  const time = value => value ? esc(new Date(value).toLocaleString()) : '尚未使用';
  container.innerHTML = `<div class="section-heading"><div><h3>个人 MCP Token</h3>
    <p class="hint">用于客户端连接你的工作台。访问范围随账号角色和项目成员资格更新。</p></div>
    <span class="tag ${full ? 'tag-gray' : 'tag-green'}">${status.active_count} / ${status.limit} 个有效</span></div>
    <div class="form-row"><label for="mcp-endpoint">服务地址</label><div class="mcp-copy-field">
      <input id="mcp-endpoint" readonly value="${esc(endpoint)}"><button type="button" class="btn" data-mcp-copy="mcp-endpoint" aria-label="复制 MCP 服务地址">复制地址</button></div></div>
    <p class="hint">Token 永久有效，每个账号最多 ${status.limit} 个。完整值只在生成或重置后显示一次，请保存在客户端的凭证设置中。</p>
    <form class="mcp-token-create">
      <div class="form-row"><label for="mcp-token-name">Token 名称 <span class="hint">必填</span></label>
        <input id="mcp-token-name" name="name" required maxlength="${status.max_name_length}" placeholder="例如：桌面客户端、自动化" ${full ? 'disabled' : ''}></div>
      <button type="submit" class="btn btn-primary" ${full ? 'disabled' : ''}>生成 Token</button>
    </form>
    <p class="hint mcp-token-capacity" role="status">${full ? '已达到有效 Token 上限；先撤销不再使用的 Token，即可创建新的 Token。' : `还可创建 ${status.limit - status.active_count} 个 Token，可为不同客户端分别命名。`}</p>
    <div class="mcp-token-once" hidden><label for="mcp-token-once">本次生成的 Token</label>
      <div class="mcp-copy-field"><input id="mcp-token-once" readonly autocomplete="off" spellcheck="false">
        <button type="button" class="btn" data-mcp-copy="mcp-token-once" aria-label="复制完整 MCP Token">复制 Token</button></div><p class="hint">离开或刷新页面后不再显示。</p>
      <button type="button" class="btn btn-sm" data-mcp-hide-token>已保存，关闭显示</button></div>
    <ul class="mcp-token-list">${status.items.map(item => `<li class="mcp-token-item" data-mcp-token-id="${item.id}">
      <div class="section-heading"><h4>${esc(item.name)}</h4><span class="tag ${item.active ? 'tag-green' : 'tag-gray'}">${item.active ? '有效' : '已撤销'}</span></div>
      <p class="mcp-token-identifier"><span class="hint">标识</span> <code>spm_${esc(item.token_id)}_…</code></p>
      <dl class="mcp-token-times"><div><dt>创建时间</dt><dd>${time(item.created_at)}</dd></div>
        <div><dt>最近使用</dt><dd>${time(item.last_used_at)}</dd></div>
        ${item.rotated_at ? `<div><dt>最近重置</dt><dd>${time(item.rotated_at)}</dd></div>` : ''}
        ${item.revoked_at ? `<div><dt>撤销时间</dt><dd>${time(item.revoked_at)}</dd></div>` : ''}</dl>
      ${item.active ? `<div class="form-actions"><button type="button" class="btn btn-sm" data-mcp-action="reset" data-id="${item.id}" aria-label="重置 ${esc(item.name)}">重置 Token</button>
        <button type="button" class="btn btn-sm btn-danger" data-mcp-action="revoke" data-id="${item.id}" aria-label="撤销 ${esc(item.name)}">撤销 Token</button></div>` : ''}</li>`).join('')}</ul>
    ${status.items.length ? '' : '<p class="hint">还没有 Token，填写名称即可创建。</p>'}`;
  if (issued?.token) {
    container.querySelector('.mcp-token-once').hidden = false;
    container.querySelector('#mcp-token-once').value = issued.token;
    container.querySelector('.mcp-token-once label').textContent = `请保存「${issued.name}」的完整 Token`;
  }
  container.querySelector('[data-mcp-hide-token]').onclick = () => {
    container.querySelector('#mcp-token-once').value = '';
    container.querySelector('.mcp-token-once').hidden = true;
  };
  for (const button of container.querySelectorAll('[data-mcp-copy]')) button.onclick = async () => {
    if (!isCurrent()) return;
    const value = container.querySelector(`#${button.dataset.mcpCopy}`).value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      if (isCurrent()) window.toast(button.dataset.mcpCopy === 'mcp-endpoint' ? '服务地址已复制' : 'Token 已复制，请保存在客户端的凭证设置中', 'ok');
    } catch {
      if (isCurrent()) window.toast('复制失败，请选中内容手动复制', 'err');
    }
  };
  let busy = false;
  async function perform(action) {
    if (busy || !isCurrent()) return;
    busy = true;
    const controls = [...container.querySelectorAll('button, input')].filter(control => !control.disabled);
    for (const control of controls) control.disabled = true;
    try {
      const result = await action();
      if (isCurrent()) await renderMcpTokenSettings(container, result);
    } catch (error) {
      if (isCurrent()) {
        window.toast(error.message, 'err');
        for (const control of controls) control.disabled = false;
      }
    } finally { busy = false; }
  }
  container.querySelector('form').onsubmit = event => {
    event.preventDefault();
    const input = container.querySelector('#mcp-token-name');
    const name = input.value.trim();
    if (!name) { input.setCustomValidity('请填写 Token 名称'); input.reportValidity(); return; }
    return perform(() => API.createMcpToken(name));
  };
  container.querySelector('#mcp-token-name').oninput = event => event.target.setCustomValidity('');
  for (const button of container.querySelectorAll('[data-mcp-action]')) button.onclick = () => {
    const item = status.items.find(item => item.id === Number(button.dataset.id));
    const reset = button.dataset.mcpAction === 'reset';
    if (!window.confirm(`${reset ? '重置' : '撤销'}「${item.name}」（标识 ${item.token_id}）？\n该 Token 的原值会立即失效，其他 Token 可继续使用。`)) return;
    return perform(() => reset ? API.resetMcpToken(item.id) : API.revokeMcpToken(item.id));
  };
}
