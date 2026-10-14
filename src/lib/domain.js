// domain.js —— 外链平台域名归一化（纯函数，任务10）
//
// 平台身份 = 项目 × 域名。契约：
//   - 从合法 URL 主机归一化：小写、去 www.、去端口，保留子域名（a.example.com ≠ example.com）。
//   - 不直接复用根域名折叠规则——GA4 的 sessionSource 本来就是主机级，
//     同根域名不同子域在旧模型里被合并，新模型按域名分开（contract: domain从合法URL主机归一化）。
//   - 允许显式来源域名（domain_source='manual'）：用户登记的地址和实际 GA4 里的来源
//     域名不一致时（比如登记的是追踪短链），用手工域名覆盖自动推导，不静默改。
//   - 非法输入（无主机/相对路径）返回 null，调用方拒绝登记，不猜。

function normalizeDomain(rawUrl) {
  const s = String(rawUrl ?? '').trim();
  if (!s) return null;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(s);
  if (!m) return null; // 必须是绝对 URL（http/https/其它 scheme 都行，只要有主机）
  const rest = s.slice(m[0].length);
  const authority = rest.split(/[/?#]/)[0];
  if (!authority) return null;
  // 去掉 userinfo（user@host）
  const at = authority.lastIndexOf('@');
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  if (!hostPort) return null;
  // IPv6 literal [::1]:443 —— 保留方括号内部分
  let host;
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    if (end === -1) return null;
    host = hostPort.slice(0, end + 1);
  } else {
    const colon = hostPort.indexOf(':');
    host = colon === -1 ? hostPort : hostPort.slice(0, colon);
  }
  host = host.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host || host.includes(' ')) return null;
  return host;
}

// 重新推导域名（URL 变了 / 用户显式要求重新推导）：auto 模式取当前 URL，manual 保持不变
function resolveDomain(url, current) {
  if (current && current.domain_source === 'manual' && current.domain) return current.domain;
  return normalizeDomain(url);
}

module.exports = { normalizeDomain, resolveDomain };
