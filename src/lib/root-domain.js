// root-domain.js —— 根域名（eTLD+1）提取
// 外链反查用：把「www.example.com/article」这类外链归到「example.com」。
// 不引第三方库，内置一份常用多级后缀表（ccSLD）覆盖主流的商业/国家后缀；
// 表外的域名回退到「最后两级」。外链基本都是常见站点，这个表够用。

const CC_SLD = new Set([
  'co.uk', 'org.uk', 'net.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'org.hk', 'net.hk', 'com.tw', 'org.tw', 'net.tw',
  'com.sg', 'org.sg', 'com.my', 'com.ph', 'co.id', 'com.id', 'co.th', 'com.vn',
  'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'net.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr',
  'com.br', 'net.br', 'org.br', 'com.mx', 'com.ar', 'com.co', 'com.tr', 'org.tr',
  'co.in', 'net.in', 'org.in', 'com.ru', 'net.ru', 'org.ru', 'com.ua', 'com.by', 'com.kz',
  'com.eg', 'com.sa',
  // 私有后缀（如 *.qq.com）：weixin.qq.com 这类本身就是可注册域名，要单独成组。
  // 很多公众号/视频号都挂在 qq.com 下，混进 qq.com 会分不清来源。
  'qq.com',
]);

function eTLD1(host) {
  const labels = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return labels[0] || host || '';
  // 从靠后的标签开始找「多级后缀」，命中则它前面一级就是根域名
  for (let i = 1; i < labels.length; i++) {
    if (CC_SLD.has(labels.slice(i).join('.'))) return labels.slice(i - 1).join('.');
  }
  return labels.slice(-2).join('.');
}

// 从一条外链（完整 URL 或裸域名）里取根域名；解析失败时退回原文小写。
// 先剥掉 www.，这样 www.qq.com 和 qq.com 归到一起（加了私有后缀 qq.com 之后否则会拆开）。
function rootDomain(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (/^https?:\/\//i.test(s)) {
    try { return eTLD1(new URL(s).hostname.replace(/^www\./i, '')); } catch { /* 落到下面按裸域名拆 */ }
  }
  const host = s.split(/[/?#]/)[0].toLowerCase().replace(/^www\./, '');
  return eTLD1(host);
}

module.exports = { eTLD1, rootDomain };
