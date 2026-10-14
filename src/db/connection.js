// connection.js —— 打开 SQLite 数据库
// 用 Node 自带的 node:sqlite，无需额外安装数据库软件

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { ROOT_DIR } = require('../config');

// 数据目录默认 <项目根>/data；测试时设 SPM_DATA_DIR 指向一次性临时目录，避免碰真实数据。
// 必须在第一次加载数据库时才读这个环境变量（见 src/config.js 顶部说明）。
const DATA_DIR = process.env.SPM_DATA_DIR
  ? path.resolve(process.env.SPM_DATA_DIR)
  : path.join(ROOT_DIR, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'spm.db');

const db = new DatabaseSync(DB_FILE);
// 用回滚日志（delete）而不是 WAL：本项目是单进程应用，WAL 的读并发用不上，却有真实的
// 数据丢失风险——服务器跑着的时候，任何外部进程（备份脚本、SQLite 工具、一次性核对脚本）
// 开关一次库都会触发最后一次连接的 checkpoint 并删除 -wal 文件；服务器仍持有那个已删除的
// inode，之后的写入只落在孤岛文件里，别人看不到，进程被硬杀时整段丢失。
// delete 模式写事务期间会挡一下外部读，但提交后主库文件就是最新状态，不存在看不见的写入。
db.exec('PRAGMA journal_mode = DELETE');
// 外部进程偶尔同时开库（核对/备份）时等一等，别立刻抛 SQLITE_BUSY
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

module.exports = { db, DATA_DIR, DB_FILE };
