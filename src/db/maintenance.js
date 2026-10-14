// maintenance.js —— 数据库维护：启动时自动备份、退出时安全关闭

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { db, DATA_DIR } = require('./connection');
const backupOrderName = name => name.replace(/^((?:backup|pinned)-\d{8}-\d{6})(\d{2,3})(?=-|$)/,(_,prefix,ms)=>prefix+ms.padStart(3,'0'));

// 退出时把 WAL 合并回主库文件 —— 否则只备份 spm.db 会丢数据
function close() {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 忽略 */ }
  try { db.close(); } catch { /* 忽略 */ }
}

// VACUUM INTO 从同一个连接生成一致性快照，不能在线裸复制数据库和日志。
// keep 默认 10，可用设置 backup_keep 覆盖（1~60）。
// label 会拼到目录名末尾，方便认出特殊时刻的备份（比如迁移前的那份）。
// 保持同步（迁移前的备份在服务能跑任何异步代码之前就要落盘）；backup_keep 直接内联读，
// 不依赖 queries/settings —— 那边的函数已经异步化，这里的启动路径要的是同步。
function backup(opts = {}) {
  if (opts.label && !/^[a-z0-9_-]{1,64}$/i.test(opts.label)) throw new Error('备份标签只能包含字母、数字、下划线与连字符');
  let keepSetting = '10';
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('backup_keep');
    if (row) keepSetting = row.value;
  } catch { /* settings 表还没建时用默认值 */ }
  const keep = Math.min(60, Math.max(1, Number(opts.keep ?? keepSetting) || 10));
  const backupsDir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
                `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${String(d.getMilliseconds()).padStart(3,'0')}`;
  const pinned = opts.pinned || opts.label?.startsWith('before-v');
  const suffix = opts.label ? `-${opts.label}` : '';
  // Continue after the highest retained counter so rotation cannot reuse an older name.
  const prefix = pinned ? 'pinned' : 'backup';
  const baseName = `${prefix}-${stamp}${suffix}`;
  let n = fs.readdirSync(backupsDir).map(backupOrderName).reduce((last,name)=>{
    if(name===baseName)return Math.max(last,1);
    const counter=name.startsWith(baseName+'-')?name.slice(baseName.length+1):'';
    return /^\d+$/.test(counter)?Math.max(last,Number(counter)):last;
  },0);
  let target = path.join(backupsDir, n ? `${baseName}-${++n}` : baseName);
  while (fs.existsSync(target)) {
    target = path.join(backupsDir, `${baseName}-${++n}`);
  }
  fs.mkdirSync(target);

  let snapshot;
  try {
    const snapshotFile = path.join(target,'spm.db');
    db.prepare('VACUUM INTO ?').run(snapshotFile);
    fs.chmodSync(snapshotFile,0o600);
    // The encryption key must travel with a database backup to keep saved model credentials usable.
    const modelKey=path.join(DATA_DIR,'.ai-model-key');
    if(fs.existsSync(modelKey)){const targetKey=path.join(target,'.ai-model-key');fs.copyFileSync(modelKey,targetKey,fs.constants.COPYFILE_EXCL);fs.chmodSync(targetKey,0o600);}
    snapshot = new DatabaseSync(snapshotFile,{readOnly:true});
    if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
      || snapshot.prepare('PRAGMA foreign_key_check').all().length) throw new Error('备份完整性检查失败');
  } catch (error) {
    snapshot?.close(); snapshot=null;
    fs.rmSync(target,{recursive:true,force:true});
    throw error;
  } finally {
    snapshot?.close();
  }
  // 清理旧备份，只留最近 keep 份
  // Normalize legacy millisecond widths and compare collision counters numerically.
  // Always retain the snapshot just returned, even if the system clock moved backward.
  const dirs = fs.readdirSync(backupsDir).filter(f => /^backup-/.test(f) && f !== path.basename(target))
    .sort((a,b)=>backupOrderName(a).localeCompare(backupOrderName(b),'en',{numeric:true}));
  while (dirs.length > keep - (pinned ? 0 : 1)) {
    const old = dirs.shift();
    try { fs.rmSync(path.join(backupsDir, old), { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  return { path: target, keep };
}

module.exports = { close, backup };
