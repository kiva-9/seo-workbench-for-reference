// index.js —— 数据库层入口：打开连接 → 执行待跑的迁移 → 组装查询
// 调用方只 require 这一个文件，拿到的是一个扁平对象（db.listProjects、db.saveMetrics…）。

const { db } = require('./connection');
const { createLocalBackend } = require('./local');
const { migrate, pendingMigrations, schemaVersion } = require('./migrate');
const maintenance = require('./maintenance');
const createDbApi = require('./api');

// 有待执行的迁移、而且库里已经有数据时，先备份一份。服务启动时的常规备份在迁移之后才做，
// 回滚到旧版本代码时要用的是迁移之前的这一份。全新的空库没什么可备份的。
const pending = pendingMigrations(db);
const hasData = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get());
if (pending.length && hasData) {
  const b = maintenance.backup({ label: `before-v${pending[pending.length - 1].version}` });
  console.log(`[迁移前备份] 已保存到 ${b.path}`);
}
migrate(db);

// 查询与维护操作统一从数据库 API 调用，避免业务层直接管理连接。
const api = createDbApi(createLocalBackend(db), {
  extras: { maintenance: { ...maintenance, schemaVersion: () => schemaVersion(db) } },
});

module.exports = api;
