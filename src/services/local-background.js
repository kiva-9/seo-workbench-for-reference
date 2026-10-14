const { runOperationScheduler, runOperationMaintenance } = require('./mcp-operations');

const ACTIVE_DELAY = 1000;
const MAX_IDLE_DELAY = 30_000;
const MAINTENANCE_INTERVAL = 15 * 60_000;

function startLocalBackground(context, {
  run = () => runOperationScheduler(context),
  maintain = () => runOperationMaintenance(context.db),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = error => console.error('[本地后台]', error.code || '执行器暂不可用'),
  backup = () => context.db.backup(),
} = {}) {
  let stopped = false, timer, running = null, wakeRequested = false;
  let delay = ACTIVE_DELAY;
  let nextMaintenance = now() + MAINTENANCE_INTERVAL;
  const backupInterval = (context.config.BACKUP_INTERVAL_HOURS || 24) * 60 * 60_000;
  let nextBackup = now() + backupInterval;

  function schedule(wait) {
    if (stopped) return;
    timer = setTimer(tick, wait);
    timer.unref?.();
  }

  async function tick() {
    timer = null;
    if (stopped || running) return;
    running = (async () => {
      try {
        const result = context.config.MCP_BACKGROUND_ENABLED ? await run() : { processed: 0 };
        delay = result.processed ? ACTIVE_DELAY : Math.min(delay * 2, MAX_IDLE_DELAY);
        // 维护与任务单元使用同一调度循环，不能互相重叠或在空队列每秒执行。
        if (!stopped && now() >= nextMaintenance) {
          nextMaintenance = now() + MAINTENANCE_INTERVAL;
          await maintain();
          if (!stopped && now() >= nextBackup) {
            const saved = await backup();
            nextBackup = now() + backupInterval;
            console.log(`[定时备份] 已校验一致性快照（保留最近 ${saved.keep} 份）`);
          }
        }
      } catch (error) {
        delay = Math.min(delay * 2, MAX_IDLE_DELAY);
        onError(error);
      }
    })();
    await running;
    running = null;
    const wait = wakeRequested ? 0 : context.config.MCP_BACKGROUND_ENABLED
      ? delay : Math.max(0, nextMaintenance - now());
    wakeRequested = false;
    schedule(wait);
  }

  function wake() {
    if (stopped || !context.config.MCP_BACKGROUND_ENABLED) return;
    delay = ACTIVE_DELAY;
    if (running) { wakeRequested = true; return; }
    if (timer) clearTimer(timer);
    schedule(0);
  }

  schedule(context.config.MCP_BACKGROUND_ENABLED ? ACTIVE_DELAY : MAINTENANCE_INTERVAL);
  return { wake, stop() { stopped = true; if (timer) clearTimer(timer); return running || Promise.resolve(); } };
}

module.exports = { startLocalBackground };
