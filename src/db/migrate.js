// migrate.js —— 数据库迁移：按编号顺序执行 migrations/ 下的 .sql 迁移文件
//
// 迁移是纯 SQL：migrations/NNNN_短名.sql，编号从 0001 起连续。
// 进度记在 _migrations 表里（文件名 + 应用时间）。已有 user_version 的旧库
// 首次启动会补记已应用迁移，之后统一使用 _migrations。
// 每个迁移在一个事务里执行，失败整体回滚并阻止服务启动。
//
// 新增迁移：在 migrations/ 下加「下一个编号_英文短名.sql」。
//   - 已经发布的迁移文件不要再改——改了也不会在已升级的库上重跑，只能再加一个新编号
//   - 迁移执行包在事务里，SQL 里不要再写 BEGIN/COMMIT

const fs = require('node:fs');
const path = require('node:path');
const { ROOT_DIR } = require('../config');

const MIGRATIONS_DIR = path.join(ROOT_DIR, 'migrations');

function loadMigrations(dir = MIGRATIONS_DIR) {
  const list = fs.readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => ({ version: Number(file.slice(0, 4)), name: file, path: path.join(dir, file) }));
  // 编号必须从 0001 开始连续：两个分支各自加了一个 0002，合并后不能悄悄漏跑其中一个
  list.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`迁移编号必须从 0001 开始连续，第 ${i + 1} 个却是 ${m.name}`);
    }
  });
  return list;
}

function ensureBookkeeping(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
}

// 老库的记账迁移：user_version > 0 说明旧版执行器已经跑过前 N 个迁移，
// 按编号把当前代码里的这些文件补记成已应用（schema 相同，重放反而会撞已存在的表）
function bootstrapFromLegacyVersion(db, migrations) {
  const legacy = db.prepare('PRAGMA user_version').get().user_version;
  if (!legacy) return;
  if (legacy > migrations.length) {
    throw new Error(`数据库结构版本是 ${legacy}，比代码里的迁移（${migrations.length} 个）新。请用更新的代码启动，或从迁移前的备份恢复。`);
  }
  const t = new Date().toISOString();
  for (const m of migrations.slice(0, legacy)) {
    db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(m.name, t);
  }
}

function appliedNames(db, dir = MIGRATIONS_DIR) {
  ensureBookkeeping(db);
  const legacyTotal = db.prepare('PRAGMA user_version').get().user_version;
  if (legacyTotal && db.prepare('SELECT COUNT(*) AS n FROM _migrations').get().n === 0) {
    bootstrapFromLegacyVersion(db, loadMigrations(dir));
  }
  return new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
}

// 还没执行的迁移。数据库比代码新（比如回滚到了旧版本代码）时直接报错，不带病启动。
function pendingMigrations(db, dir = MIGRATIONS_DIR) {
  const all = loadMigrations(dir);
  const applied = appliedNames(db, dir);
  const unknown = [...applied].filter((name) => !all.some((m) => m.name === name));
  if (unknown.length) {
    throw new Error(`数据库里记录的迁移 ${unknown.join(', ')} 不在当前代码里。请用更新的代码启动。`);
  }
  return all.filter((m) => !applied.has(m.name));
}

// 当前结构版本 = 已应用的迁移个数（healthz 展示用）
function schemaVersion(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM _migrations').get().n;
}

function migrate(db, dir = MIGRATIONS_DIR) {
  // 史前库守卫：比版本号机制还老的库（user_version = 0 却已经有业务表）没法用纯 SQL
  // 基线升级——旧 001 号迁移靠 JS 补列才能接管它。这种情况明确报错，让用户先用旧代码启动一次。
  const legacyVersion = db.prepare('PRAGMA user_version').get().user_version;
  const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get();
  if (!legacyVersion && hasTables && appliedNames(db, dir).size === 0) {
    throw new Error('这个数据库建自更早的版本（没有记录结构版本号）。请先用旧版代码启动一次完成升级，再换用当前版本。');
  }
  for (const m of pendingMigrations(db, dir)) {
    const sql = fs.readFileSync(m.path, 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`数据库迁移 ${m.name} 失败，已回滚：${e.message}`);
    }
  }
  return schemaVersion(db);
}

module.exports = { migrate, pendingMigrations, schemaVersion, MIGRATIONS_DIR };
