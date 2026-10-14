import { API } from '../api.js';
import { beginPageRender } from '../page-lifecycle.js';
import { renderCurrentAccount } from './current-account.js';
import { renderDeletedLoginAccounts } from './deleted-login-accounts.js';

const identity = user => user.name ? `${user.name}（${user.email}）` : user.email;

export async function renderLoginAccounts(body, pageIsCurrent = () => true) {
  const currentRender = beginPageRender(body);
  const isCurrent = () => currentRender() && pageIsCurrent();
  try {
    const [users, deletedUsers] = await Promise.all([API.listUsers(), API.listDeletedUsers()]);
    if (!isCurrent()) return;
    const adminCount = users.filter(user => user.role === 'admin').length;
    body.innerHTML = `<div class="tbl-wrap"><table class="tbl account-table">
      <thead><tr><th>账号 / 文案师显示名</th><th>全局角色</th><th>加入时间</th><th>最近活跃</th><th>操作</th></tr></thead>
      <tbody>${users.map(user => {
        const protectedReason = user.id === window.currentUser?.id ? '不能删除当前登录账号'
          : user.role === 'admin' && adminCount <= 1 ? '不能删除最后一位管理员' : '';
        return `<tr data-id="${user.id}">
          <td class="account-name"><div class="account-identity"><input type="text" class="u-name" value="${esc(user.name || '')}" placeholder="留空显示邮箱" aria-label="${esc(user.email)} 的显示名"><span class="account-email" title="${esc(user.email)}">${esc(user.email)}</span></div></td>
          <td><select class="u-role" aria-label="${esc(user.email)} 的全局角色">
            <option value="member" ${user.role === 'member' ? 'selected' : ''}>成员</option>
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>管理员</option></select></td>
          <td class="muted">${user.created_at ? user.created_at.slice(0, 10) : '—'}</td>
          <td class="muted">${user.last_seen_at ? user.last_seen_at.slice(0, 16).replace('T', ' ') : '—'}</td>
          <td><div class="cell-actions"><button class="btn btn-sm u-save-name" disabled>保存显示名</button>
            <button class="btn btn-sm btn-danger u-delete" aria-label="删除 ${esc(user.email)}" ${protectedReason ? `disabled title="${protectedReason}"` : ''}>删除账号</button>
            <span class="save-state" role="status">已保存</span></div></td></tr>`;
      }).join('')}</tbody></table></div><div class="deleted-accounts-body"></div>`;

    renderDeletedLoginAccounts($('.deleted-accounts-body', body), deletedUsers,
      () => renderLoginAccounts(body, pageIsCurrent), () => body.isConnected && isCurrent());

    for (const user of users) {
      const row = $(`tr[data-id="${user.id}"]`, body);
      const input = $('.u-name', row), role = $('.u-role', row), save = $('.u-save-name', row);
      const remove = $('.u-delete', row), status = $('.save-state', row);
      const protectedDeletion = remove.disabled;
      let prevName = user.name || '', prevRole = user.role, busy = false;
      const setBusy = value => {
        busy = value;
        input.disabled = role.disabled = value;
        save.disabled = value || input.value.trim() === prevName;
        remove.disabled = value || protectedDeletion;
      };
      const syncSelf = changes => {
        if (user.id !== window.currentUser?.id) return;
        window.currentUser = { ...window.currentUser, ...changes };
        renderCurrentAccount(window.currentUser);
      };
      input.oninput = () => {
        save.disabled = busy || input.value.trim() === prevName;
        status.classList.remove('is-error');
        status.textContent = input.value.trim() === prevName ? '已保存' : '未保存';
      };
      save.onclick = async () => {
        const name = input.value.trim();
        if (busy || name === prevName || !isCurrent()) return;
        setBusy(true); status.textContent = '保存中…';
        try {
          await API.updateUserName(user.id, name);
          if (!isCurrent()) return;
          prevName = name; input.value = name; status.textContent = '已保存';
          syncSelf({ name });
        } catch (error) {
          if (!isCurrent()) return;
          toast(error.message, 'err'); status.textContent = '保存失败，请重试'; status.classList.add('is-error');
        } finally { if (isCurrent()) setBusy(false); }
      };
      input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); save.click(); } };
      role.onchange = async () => {
        if (busy || !isCurrent()) return;
        const next = role.value;
        setBusy(true);
        try {
          await API.updateUserRole(user.id, next);
          if (!isCurrent()) return;
          prevRole = next; syncSelf({ role: next }); toast('已更新', 'ok');
          // 管理员数量及自己的权限改变后重新计算删除按钮的保护状态。
          if (user.id === window.currentUser?.id) window.refreshView();
          else renderLoginAccounts(body, pageIsCurrent);
        } catch (error) {
          if (!isCurrent()) return;
          role.value = prevRole; toast(error.message, 'err');
        } finally { if (isCurrent()) setBusy(false); }
      };
      remove.onclick = async () => {
        if (busy || protectedDeletion || !isCurrent()) return;
        setBusy(true);
        try {
          const impact = await API.userDeletionPreview(user.id);
          if (!isCurrent()) return;
          openDeletionDialog(user, users.filter(candidate => candidate.id !== user.id), impact,
            () => renderLoginAccounts(body, pageIsCurrent), () => body.isConnected && pageIsCurrent());
        } catch (error) { if (isCurrent()) toast(error.message, 'err'); }
        finally { if (isCurrent()) setBusy(false); }
      };
    }
  } catch (error) {
    if (isCurrent()) body.innerHTML = `<div class="empty">加载失败：${esc(error.message)}</div>`;
  }
}

function openDeletionDialog(user, recipients, impact, refresh, isCurrent) {
  openModal(`<div class="modal-head"><h3>转移数据并删除账号</h3></div>
    <p class="delete-account-identity">即将删除 <strong>${esc(identity(user))}</strong></p>
    <p class="hint">业务数据会保留并转到所选账号名下。历史文章署名与操作记录保留；被删账号将无法登录，项目访问和全部 MCP Token 会失效。</p>
    <div class="account-transfer-summary" aria-label="将转移的数据">
      ${[['projects', '项目'], ['tasks', '任务'], ['links', '链接'], ['google_accounts', 'Google 数据授权']].map(([key, label]) => `<span>${label}<strong>${Number(impact[key]) || 0}</strong></span>`).join('')}
    </div>
    ${Number(impact.project_access) ? `<p class="hint">另有 ${Number(impact.project_access)} 个关联项目的访问权限随数据转交，便于接收人继续维护。</p>` : ''}
    <form id="user-delete-form"><div class="form-row"><label for="user-transfer-recipient">数据转移给谁</label>
      <select id="user-transfer-recipient" required><option value="">请选择接收账号</option>
        ${recipients.map(recipient => `<option value="${recipient.id}">${esc(identity(recipient))}</option>`).join('')}</select></div>
      <p class="hint">接收账号将取得上述项目和 Google 数据授权的管理权限。数据转移不会因恢复账号而撤销。</p>
      <p class="account-delete-error hidden" role="alert" id="user-delete-error"></p>
      <div class="form-actions"><button type="button" class="btn" onclick="closeModal()">取消</button>
        <button type="submit" class="btn btn-danger" id="user-delete-confirm" disabled>转移并删除</button></div>
    </form>`);
  const form = $('#user-delete-form'), recipient = $('#user-transfer-recipient');
  const confirm = $('#user-delete-confirm'), errorBox = $('#user-delete-error');
  const isOpen = () => isCurrent() && form.isConnected && $('#user-delete-form') === form;
  let submitting = false;
  recipient.onchange = () => { confirm.disabled = !recipient.value || submitting; };
  form.onsubmit = async event => {
    event.preventDefault();
    if (submitting || !recipient.value || !isOpen()) return;
    submitting = true; confirm.disabled = recipient.disabled = true; confirm.textContent = '正在转移并删除…';
    errorBox.classList.add('hidden');
    try {
      await API.deleteUser(user.id, Number(recipient.value));
      if (!isCurrent()) return;
      if (isOpen()) closeModal();
      toast('数据已转移，登录账号已删除', 'ok'); refresh();
    } catch (error) {
      if (!isOpen()) return;
      errorBox.textContent = error.message; errorBox.classList.remove('hidden');
    } finally {
      submitting = false;
      if (isOpen()) { recipient.disabled = false; confirm.disabled = !recipient.value; confirm.textContent = '转移并删除'; }
    }
  };
}
