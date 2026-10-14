// url-match.js —— 把 Google 返回的页面和项目里登记的 URL 对上号
// GSC 返回完整 URL，GA4 返回 pagePath，项目里登记的 URL 两种写法都允许，
// 所以统一拆成「主机 + 规范化路径」再比。纯函数，不碰数据库。

// 拆出主机与路径
function splitUrl(raw) {
  const s = String(raw || '').trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return { host: normHost(u.host), path: normPathname(u.pathname) };
    } catch { /* 落到下面按路径处理 */ }
  }
  const p = s.split(/[?#]/)[0] || '/';
  return { host: null, path: normPathname(p.startsWith('/') ? p : `/${p}`) };
}

function normHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

function normPathname(p) {
  let out = String(p || '/');
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out || '/';
}

// 只取规范化后的路径
function normPath(url) {
  return splitUrl(url).path;
}

// 双层索引：byHostPath 精确到子域，byPath 作为回退。
// 同一路径出现在多个子域时把 byPath 标记为歧义，避免 domain property 下互相覆盖。
function createIndex() {
  return { byHostPath: new Map(), byPath: new Map(), ambiguous: new Set() };
}

function indexPut(index, rawUrl, value) {
  const { host, path } = splitUrl(rawUrl);
  if (host) index.byHostPath.set(`${host}|${path}`, value);

  if (index.ambiguous.has(path)) return;
  const prev = index.byPath.get(path);
  if (prev && prev.host !== host) {
    // 不同子域的同名路径：纯路径查询无法判定，标记为歧义
    index.ambiguous.add(path);
    index.byPath.delete(path);
    return;
  }
  index.byPath.set(path, { host, value });
}

function indexGet(index, rawUrl) {
  const { host, path } = splitUrl(rawUrl);
  if (host) {
    const hit = index.byHostPath.get(`${host}|${path}`);
    if (hit) return hit;
  }
  const byPath = index.byPath.get(path);
  return byPath ? byPath.value : null;
}

module.exports = { splitUrl, normHost, normPathname, normPath, createIndex, indexPut, indexGet };
