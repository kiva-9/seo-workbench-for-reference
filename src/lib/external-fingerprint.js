// external-fingerprint.js —— 外链平台的配置指纹（任务10/11 共用）
// 换账号/资源/所选事件集合 → 指纹变 → 旧日数据行与冻结段都不进当前 SUM。
// 事件集合去重排序：换序/重复不失效。

const { resolveAccounts, parseKeyEventNames } = require('../google/project-config');

function buildFingerprint(project) {
  const { ga4AccountId } = resolveAccounts(project);
  const events = [...new Set(parseKeyEventNames(project.key_event_names))].sort();
  return ga4AccountId && project.ga4_property_id
    ? `ga4:${ga4AccountId}:${project.ga4_property_id}:${events.join('|')}`
    : null;
}

module.exports = { buildFingerprint };
