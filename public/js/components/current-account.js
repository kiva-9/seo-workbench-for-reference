let beforeLogout = async () => true;
let onLogout = () => {};

export function initCurrentAccount(options = {}) {
  beforeLogout = options.beforeLogout || beforeLogout;
  onLogout = options.onLogout || onLogout;
}

export function renderCurrentAccount(user, { logoutUrl = user?.logout_url, deleted = false } = {}) {
  const foot = $('.sidebar-foot');
  if (!foot) return;
  const canLogout = logoutUrl === '/cdn-cgi/access/logout';
  const name = deleted ? '账号已删除' : user?.name || user?.email || '尚未登录';
  const role = user?.role === 'admin' ? '管理员' : '成员';
  foot.innerHTML = `<div class="current-account" title="${esc(user?.email || name)}">
      <span class="account-avatar" aria-hidden="true">${esc(name.slice(0, 1).toUpperCase())}</span>
      <div class="current-account-details"><div class="current-account-name">${esc(name)}</div>
        ${user?.name ? `<div class="current-account-email">${esc(user.email)}</div>` : ''}
        ${user ? `<span class="current-account-role">${role}</span>` : ''}</div>
    </div>
    <button type="button" class="account-logout" ${canLogout ? '' : 'disabled'} aria-label="登出当前账号"
      title="${canLogout ? '登出当前账号' : '本机固定账号模式无需登录，无法登出'}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M9 5H5v14h4M14 8l4 4-4 4M9 12h9"/></svg><span>登出</span>
    </button>`;
  if (!canLogout) return;
  $('.account-logout', foot).onclick = async () => {
    if (!await beforeLogout()) return;
    openModal(`<div class="modal-head"><h3>登出当前账号</h3></div>
      <p>将结束当前登录会话。同一登录服务下的其他应用也会退出，之后需要重新登录。</p>
      <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">取消</button>
        <button type="button" class="btn btn-primary" id="account-confirm-logout">登出</button></div>`);
    $('#account-confirm-logout').onclick = () => {onLogout();window.location.assign(logoutUrl);};
  };
}
