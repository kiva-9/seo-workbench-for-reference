// crud.js —— 通用的增删改小工具，各查询模块共用（需要 db 后端，走工厂注入；
// 纯函数留在 ../helpers，见 helpers.js 顶部说明）

module.exports = function createCrud(db) {
  async function insert(table, data) {
    const keys = Object.keys(data);
    if (!keys.length) throw new Error('insert: 没有可写入的字段');
    const placeholders = keys.map((k) => `@${k}`).join(', ');
    const info = await db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`).run({ ...data });
    return Number(info.lastInsertRowid);
  }

  // 返回受影响行数；无字段可更新时直接返回 0（避免拼出 "SET  WHERE" 的非法 SQL）
  async function update(table, id, data) {
    const keys = Object.keys(data);
    if (!keys.length) return 0;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    const info = await db.prepare(`UPDATE ${table} SET ${sets} WHERE id = @id`).run({ ...data, id });
    return Number(info.changes || 0);
  }

  async function remove(table, id) {
    const info = await db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return Number(info.changes || 0);
  }

  async function exists(table, id) {
    const row = await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
    return Boolean(row);
  }

  return { insert, update, remove, exists };
};
