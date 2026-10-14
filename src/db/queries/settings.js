// settings.js —— 键值设置（Google 客户端配置、备份份数等）

module.exports = (db) => ({
  async getSetting(key, def = null) {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : def;
  },

  async setSetting(key, value) {
    await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  },

  // 读 JSON 设置，解析失败时回落到默认值而不是抛错
  async getJsonSetting(key, def) {
    const raw = await this.getSetting(key, null);
    if (raw === null) return def;
    try { return JSON.parse(raw); } catch { return def; }
  },
});
