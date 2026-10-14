// local.js —— node:sqlite 后端封装
//
// 查询模块只依赖以下接口：
//   db.prepare(sql) → { bind(...args), get(...args), all(...args), run(...args) }
//   db.exec(sql)                 执行多条裸 SQL
//   db.batch([绑定后的语句])       在同一事务中执行，失败整批回滚
//   db.batchAtomic([绑定后的语句]) 显式要求整个业务单元原子提交
// prepare 的读写方法和批量方法返回 Promise，底层 DatabaseSync 同步执行。
//
// bind() 保存 { sql, args } 供批量执行；位置参数与命名参数对象均可使用。
// get() 无记录时返回 undefined；写入返回 changes 和 lastInsertRowid。

const { measureSql } = require('../lib/request-timing');

function createLocalBackend(sqlite) {
  // SQLite lower() 只处理 ASCII；目录名称搜索须保持原 JS 的 Unicode 大小写语义。
  sqlite.function('spm_lower',{deterministic:true},value=>String(value??'').toLowerCase());
  function prepare(sql) {
    const stmt = sqlite.prepare(sql);
    return {
      sql,
      // 绑定只记下参数，推迟到 batch 里执行（node:sqlite 没有独立的 bind 概念）
      bind: (...args) => ({ sql, args }),
      get: async (...args) => measureSql(() => stmt.get(...args)),
      all: async (...args) => measureSql(() => stmt.all(...args)),
      run: async (...args) => measureSql(() => stmt.run(...args)),
    };
  }

  function exec(sql) {
    sqlite.exec(sql);
  }

  // 单事务执行入口：batch 与 batchAtomic 共用。失败整体 ROLLBACK。
  async function executeAtomically(statements) {
    if (!Array.isArray(statements) || statements.length === 0) {
      throw new Error('原子批量执行需要非空语句数组');
    }
    for (const s of statements) {
      if (!s || typeof s.sql !== 'string' || !s.sql) throw new Error('原子批量执行收到非法语句（缺少 sql）');
    }
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((s) => {
        const st = sqlite.prepare(s.sql);
        if (isReadSql(s.sql)) {
          const results2 = s.args ? st.all(...s.args) : st.all();
          return { results: results2, changes: 0, lastInsertRowid: 0 };
        }
        const r = s.args ? st.run(...s.args) : st.run();
        return { results: [], ...r };
      });
      sqlite.exec('COMMIT');
      return results;
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
  }

  // 原子批量执行，耗时和语句数一起纳入请求计量。
  async function batch(statements) {
    return measureSql(() => executeAtomically(statements), statements?.length || 0);
  }

  // 单原子单元入口：契约上承诺「整批要么全生效要么全不生效」。调用方（冻结+状态变更、
  // URL 历史+当前地址+修订推进、名单移除+引用检查等）必须用它，不允许分段部分完成。
  async function batchAtomic(statements) {
    return batch(statements);
  }

  return { prepare, exec, batch, batchAtomic };
}

// 批量业务单元也会读取事务内刚写入的数据。
function isReadSql(sql) {
  return /^\s*(SELECT|WITH|PRAGMA|RETURNING)/i.test(String(sql));
}

module.exports = { createLocalBackend };
