// host-guard.js —— 只接受来自本机 / 部署域名的请求
//
// 本机模式：服务已绑定 127.0.0.1，这里再挡一层 Host / Origin，防止 DNS rebinding：
// 恶意网站把自己的域名解析到 127.0.0.1 后，浏览器会认为同源，从而能读写本地数据。
// 经反向代理部署到域名时 Host 头是真实域名而不是 localhost，publicHost 把它加进白名单——
// 不设就只接受本机访问。
//
module.exports = function createHostGuard({ port, publicHost }) {
  const localHostnames = ['localhost', '127.0.0.1', '[::1]', '::1'];
  const localOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
  const allowedHostnames = new Set([...localHostnames, ...(publicHost ? [publicHost] : [])]);
  const allowedOrigins = new Set([
    ...localOrigins,
    ...(publicHost ? [`https://${publicHost}`, `http://${publicHost}`] : []),
  ]);

  return (req, res, next) => {
    const hostname = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!allowedHostnames.has(hostname)) {
      return res.status(403).json({ error: '仅允许通过本机或部署域名访问本服务' });
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: '跨站请求已被拒绝' });
    }
    next();
  };
};
