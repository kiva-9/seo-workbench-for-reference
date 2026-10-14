import { API } from '../api.js';

const identity = user => user.name ? `${user.name}（${user.email}）` : user.email;

export function renderDeletedLoginAccounts(body, users, refresh, isCurrent) {
  body.innerHTML = `<details class="deleted-accounts" ${users.length ? 'open' : ''}>
    <summary>已删除账号 <span class="tag tag-gray">${users.length}</span></summary>
    <p class="hint">恢复后作为普通成员重新加入，项目权限需要重新分配。</p>
    ${users.length ? `<div class="tbl-wrap"><table class="tbl deleted-account-table">
      <thead><tr><th>账号 / 显示名</th><th>删除时间</th><th>操作</th></tr></thead>
      <tbody>${users.map(user => `<tr>
        <td><div>${esc(user.name || user.email)}</div>${user.name ? `<div class="muted">${esc(user.email)}</div>` : ''}</td>
        <td class="muted">${esc(user.deleted_at.slice(0, 16).replace('T', ' '))}</td>
        <td><button class="btn btn-sm u-restore" data-id="${user.id}" aria-label="恢复 ${esc(user.email)}">恢复账号</button></td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty">暂无已删除账号</div>'}
  </details>`;
  for (const user of users) {
    $(`.u-restore[data-id="${user.id}"]`, body).onclick = () => {
      if (isCurrent()) openRestorationDialog(user, refresh, isCurrent);
    };
  }
}

function openRestorationDialog(user, refresh, isCurrent) {
  const modal = openModal(`<div class="modal-head"><h3>恢复登录账号</h3></div>
    <p class="delete-account-identity">恢复 <strong>${esc(identity(user))}</strong></p>
    <ul class="account-restore-effects">
      <li>恢复为普通成员，保留原账号身份和历史文章署名。</li>
      <li>项目权限需要在「项目文章管理 → 文案师与监控」中重新分配。</li>
      <li>已转移的数据继续属于接收人，旧 MCP Token 和已取消的后台任务保持失效。</li>
    </ul>
    <form id="user-restore-form">
      <p class="account-delete-error hidden" role="alert" id="user-restore-error"></p>
      <div class="form-actions"><button type="button" class="btn" id="user-restore-cancel">取消</button>
        <button type="submit" class="btn btn-primary" id="user-restore-confirm">恢复为普通成员</button></div>
    </form>`);
  const form = $('#user-restore-form'), confirm = $('#user-restore-confirm');
  const errorBox = $('#user-restore-error');
  const isOpen = () => isCurrent() && modal.isCurrent() && form.isConnected;
  $('#user-restore-cancel').onclick = modal.close;
  let submitting = false;
  form.onsubmit = async event => {
    event.preventDefault();
    if (submitting || !isOpen()) return;
    submitting = true; confirm.disabled = true; confirm.textContent = '正在恢复…';
    errorBox.classList.add('hidden');
    try {
      await API.restoreUser(user.id);
      if (!isCurrent()) return;
      modal.close();
      toast('账号已恢复为普通成员，请重新分配项目权限', 'ok', 4000);
      refresh();
    } catch (error) {
      if (!isOpen()) return;
      errorBox.textContent = error.message; errorBox.classList.remove('hidden');
    } finally {
      submitting = false;
      if (isOpen()) { confirm.disabled = false; confirm.textContent = '恢复为普通成员'; }
    }
  };
}
