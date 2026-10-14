const { resolveAccounts, parseKeyEventNames } = require('../google/project-config');

// 浏览与所选事件共享来源配置；集合换序和重复事件不改变统计口径。
function buildArticleFingerprints(project) {
  const { gscAccountId, ga4AccountId } = resolveAccounts(project);
  const events = [...new Set(parseKeyEventNames(project.key_event_names))].sort();
  return {
    gsc: gscAccountId && project.gsc_site ? `gsc:${gscAccountId}:${project.gsc_site}` : null,
    ga4: ga4AccountId && project.ga4_property_id ? `ga4:${ga4AccountId}:${project.ga4_property_id}:${events.join('|')}` : null,
  };
}
module.exports = { buildArticleFingerprints };
