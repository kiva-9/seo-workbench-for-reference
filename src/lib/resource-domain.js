const { domainToASCII } = require('node:url');

// 主机仅用于发现建议。完整 GSC 前缀和 GA4 ID 始终保留为资源身份。
function resourceHostname(value) {
  const raw = String(value || '').trim();
  try {
    const url = new URL(raw.startsWith('sc-domain:') ? 'https://' + raw.slice(10) : (/^https?:\/\//i.test(raw) ? raw : 'https://' + raw));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return domainToASCII(url.hostname.replace(/\.$/, '').toLowerCase());
  } catch { return ''; }
}

function candidateHostname(value) {
  return resourceHostname(value).replace(/^www\./, '');
}

// 只合并前导 www；资源的完整 URL 和其他子域仍保持原身份。
function candidateHostnameSql(column) {
  return `(CASE WHEN substr(${column},1,4)='www.' THEN substr(${column},5) ELSE ${column} END)`;
}

module.exports = { resourceHostname, candidateHostname, candidateHostnameSql };
