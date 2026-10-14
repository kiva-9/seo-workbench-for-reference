const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');
const { isIP } = require('node:net');

// 固定已验证的地址，同时保留原 Host 和 TLS 主机名；不能让 HTTP 客户端再解析一次 DNS。
function pinnedTitleRequest(url, addresses, { headers, signal }) {
  const address = typeof addresses[0] === 'string' ? addresses[0] : addresses[0].address;
  const family = isIP(address);
  if (!family) throw new Error('Invalid resolved address');
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', headers, signal, agent: false,
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{ address, family }]) : callback(null, address, family),
    }, incoming => {
      const responseHeaders = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      }
      // native http 不会解压；主动只请求 identity，避免压缩炸弹及按压缩前体积误计上限。
      if (responseHeaders.get('content-encoding') && responseHeaders.get('content-encoding') !== 'identity') {
        incoming.destroy(); reject(new Error('Unsupported content encoding')); return;
      }
      resolve({ ok: incoming.statusCode >= 200 && incoming.statusCode < 300, status: incoming.statusCode,
        url: url.href, headers: responseHeaders, body: Readable.toWeb(incoming) });
    });
    req.once('error', reject);
    req.end();
  });
}

module.exports = { pinnedTitleRequest };
