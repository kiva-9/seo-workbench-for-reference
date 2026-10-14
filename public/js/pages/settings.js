// settings.js —— 设置：Google Cloud 客户端配置
import { API } from '../api.js';
import { beginPageRender, capturePageContext } from '../page-lifecycle.js';
import { renderLoginAccounts } from '../components/login-accounts.js';

export async function renderSettings(el) {
  const isCurrent = beginPageRender(el);
  const s = await API.settings();
  if (!isCurrent()) return;
  const isAdmin = window.currentUser?.role === 'admin';

  el.innerHTML = `
    <div class="page-head">
      <div><h2>账号与设置</h2>
        <p class="page-desc">管理已有登录账号、文案师显示名与数据连接配置。</p></div>
    </div>
    <div class="settings-workspace">
      ${isAdmin ? `<section class="card" id="s-users-card" aria-labelledby="s-users-heading">
        <div class="section-heading"><div>
          <h3 id="s-users-heading">登录账号</h3>
          <p class="hint">成员首次通过 Google 或邮箱验证码登录后会出现在这里。显示名用于项目文案师名单与文章署名。</p>
        </div><span class="tag tag-gray">仅管理员可管理</span></div>
        <div id="s-users-body">${spinner}</div>
        <p class="settings-note">项目文案师绑定在「项目文章管理 → 文案师与监控」中维护。删除账号前需选择数据接收人，业务数据和历史署名会保留。已删除账号可恢复为普通成员，项目权限需重新分配；已转移数据和旧 Token 不恢复。</p>
      </section>` : `<section class="card"><h3>当前登录账号</h3><p>${esc(window.currentUser?.name || window.currentUser?.email || '')}</p><p class="hint">账号显示名与全局角色由管理员维护。项目文案师名单在项目文章管理中查看。</p></section>`}
      <details class="card connection-settings" ${s.clientIdConfigured ? '' : 'open'}>
        <summary><div class="connection-heading">
          <div class="connection-title"><h3>Google Cloud 客户端配置</h3><span class="tag ${s.clientIdConfigured ? 'tag-green' : 'tag-gray'}">${s.clientIdConfigured ? '已配置' : '未配置'}</span></div>
          <p class="hint">管理 GSC / GA4 连接所需的应用配置</p>
        </div></summary>
        <form id="gcfg-form">
          <div class="form-row"><label for="gcfg-id">客户端 ID（Client ID）</label>
            <input id="gcfg-id" name="gsc_client_id" value="" placeholder="xxxx.apps.googleusercontent.com" autocomplete="off"></div>
          <div class="form-row"><label for="gcfg-secret">客户端密钥（Client Secret）</label>
            <input id="gcfg-secret" name="gsc_client_secret" type="password" value="" placeholder="GOCSPX-…" autocomplete="off"></div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">保存配置</button></div>
        </form>
      </details>
    </div>`;

  $('#gcfg-form').onsubmit = async (e) => {
    e.preventDefault();
    const d = readForm(e.target);
    if (!d.gsc_client_id.trim() || !d.gsc_client_secret.trim()) return toast('两项都要填', 'err');
    if (!/\.apps\.googleusercontent\.com$/.test(d.gsc_client_id.trim())) {
      return toast('客户端 ID 应以 .apps.googleusercontent.com 结尾，请检查是否复制完整', 'err', 4000);
    }
    const current = capturePageContext(el);
    try {
      await API.saveSettings(d);
      toast('配置已保存，可以到「谷歌账号」页连接账号了', 'ok');
      if (isCurrent() && current()) await renderSettings(el);
    } catch (err) { toast(err.message, 'err'); }
  };

  if (isAdmin) renderLoginAccounts($('#s-users-body', el), isCurrent);
}

const spinner = '<div style="display:flex;justify-content:center;padding:30px 0"><span class="spinner"></span></div>';
