// api.js —— 数据库层对外入口的组装逻辑
//
// 注入数据库后端，返回扁平的查询对象（db.listProjects、db.saveMetrics…）。
// 重名会让后合并的悄悄覆盖先合并的，所以这里直接报错。

const createCrud = require('./crud');

module.exports = function createDbApi(backend, { extras = {} } = {}) {
  const modules = {
    helpers: { ...createCrud(backend), ...require('./helpers') },
    aiInsights: require('./queries/ai-insights')(backend),
    backgroundTasks: require('./queries/background-tasks')(backend),
    settings: require('./queries/settings')(backend),
    users: require('./queries/users')(backend),
    userDeletion: require('./queries/user-deletion')(backend),
    userRestoration: require('./queries/user-restoration')(backend),
    mcpTokens: require('./queries/mcp-tokens')(backend),
    accounts: require('./queries/accounts')(backend),
    googleResources: require('./queries/google-resources')(backend),
    resourceSearch: require('./queries/resource-search')(backend),
    projectCandidates: require('./queries/project-candidates')(backend),
    projects: require('./queries/projects')(backend),
    tasks: require('./queries/tasks')(backend),
    links: require('./queries/links')(backend),
    urls: require('./queries/urls')(backend),
    projectArticles: require('./queries/project-articles')(backend),
    projectArticleMonthly: require('./queries/project-article-monthly')(backend),
    articleTitleFetch: require('./queries/article-title-fetch')(backend),
    articleCurrent: require('./queries/article-current')(backend),
    articleSyncJobs: require('./queries/article-sync-jobs')(backend),
    mcpOperations: require('./queries/mcp-operations')(backend),
    articleMonitor: require('./queries/article-monitor')(backend),
    monitorOptions: require('./queries/monitor-options')(backend),
    projectCopywriters: require('./queries/project-copywriters')(backend),
    projectMonitorSync: require('./queries/project-monitor-sync')(backend),
    metrics: require('./queries/metrics')(backend),
    externalLinks: require('./queries/external-links')(backend),
    externalArticles: require('./queries/project-external-articles')(backend),
    externalFreezes: require('./queries/project-external-article-freezes')(backend),
    externalMonitor: require('./queries/external-monitor')(backend),
    gscSnapshots: require('./queries/gsc-snapshots')(backend),
    ...extras,
  };

  const api = { db: backend };
  for (const [name, mod] of Object.entries(modules)) {
    for (const [key, value] of Object.entries(mod)) {
      if (key in api) throw new Error(`数据库层函数重名：${key}（${name} 里又定义了一次）`);
      api[key] = value;
    }
  }
  return api;
};
