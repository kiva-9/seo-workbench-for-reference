const { AsyncLocalStorage } = require('node:async_hooks');

const requests = new AsyncLocalStorage();
const createMetrics = () => ({ sql: 0, queries: 0 });

// 仅记录 SQLite 耗时与语句数，不将 SQL、绑定参数或用户信息写入响应头。
async function measureSql(run, queries = 1) {
  const metrics = requests.getStore();
  if (!metrics) return run();
  const start = performance.now();
  try { return await run(); }
  finally {
    metrics.sql += performance.now() - start;
    metrics.queries += queries;
  }
}

function requestTiming(req, res, next) {
  const start = performance.now();
  const metrics = createMetrics();
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    const values = [`app;dur=${(performance.now() - start).toFixed(1)}`];
    if (metrics.queries) values.push(`sqlite;dur=${metrics.sql.toFixed(1)}`, `sqlite_queries;desc="${metrics.queries}"`);
    this.setHeader('Server-Timing', values.join(', '));
    return writeHead.apply(this, args);
  };
  requests.run(metrics, next);
}

// 后台任务与性能验证没有 HTTP 中间件，单独收集一个执行单元的查询计量。
async function collectQueryMetrics(run) {
  const metrics = createMetrics();
  return requests.run(metrics, async () => {
    try { return { value: await run(), metrics }; }
    catch (error) { return { error, metrics }; }
  });
}
module.exports = { measureSql, requestTiming, collectQueryMetrics };
