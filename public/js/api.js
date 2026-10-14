// api.js —— 后端接口封装
import {createReadCache} from './read-cache.js';
import {takeBootstrappedUser} from './bootstrap.js';
const reads=createReadCache();
const candidatePath=params=>{const query=new URLSearchParams(params);query.sort();return `/api/project-candidates?${query}`;};
const sharedRead=path=>reads.load(path,opts=>request(path,opts)).catch(error=>{
  if(error.status===401||error.status===403)reads.clear();
  throw error;
});
async function request(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  } catch (error) {
    if(error.name==='AbortError')throw error;
    // fetch 本身失败通常是服务没起来 / 被关掉了
    throw new Error('连接不上本地服务，请确认 start.command 还在运行');
  }
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    let details = {};
    try { const j = await res.json(); if (j.error) msg = j.error; details = { code: j.code, logout_url: j.logout_url }; } catch { /* 非 JSON 响应 */ }
    throw Object.assign(new Error(msg), { status: res.status, ...details });
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new Error('服务返回了无法解析的数据'); }
}

async function api(path,opts={}) {
  // 仅本地资料变更等待提交；取数、标题抓取等长操作不能阻塞其他页面读取。
  const localWrite=/^\/api\/(tasks(?:\/\d+)?|projects(?:\/\d+(?:\/(owner|resource-matches|copywriters(?:\/\d+)?))?)?|users\/\d+(?:\/restore)?|accounts\/\d+|project-candidates\/\d+\/(claim|ignore|restore))$/.test(path);
  const finish=opts.method&&opts.method!=='GET'?reads.beginWrite({blockReads:localWrite}):null;
  try{return await request(path,opts);}catch(error){
    if(error.status===401||error.status===403)reads.clear();
    throw error;
  }finally{finish?.();}
}

const API = {
  backgroundTasks: params => api('/api/background-tasks?' + new URLSearchParams(params)),
  backgroundTaskOptions: () => api('/api/background-tasks/options'),
  backgroundTask: (type,id,unitPage=1) => api(`/api/background-tasks/${encodeURIComponent(type)}/${encodeURIComponent(id)}?unit_page=${unitPage}`),
  backgroundTaskAction: (type,id,action,key) => api(`/api/background-tasks/${encodeURIComponent(type)}/${encodeURIComponent(id)}/${action}`, {method:'POST',body:JSON.stringify({idempotency_key:key})}),
  aiOverview: params => api('/api/ai-insights/overview?' + new URLSearchParams(params)),
  aiProject: (id,params) => api(`/api/projects/${id}/ai-insights?` + new URLSearchParams(params)),
  aiDetail: (pid,id) => api(`/api/projects/${pid}/ai-insights/${id}`),
  aiConfiguration:()=>api('/api/ai-insights/configuration'),
  aiSettings:pid=>api(`/api/projects/${pid}/ai-insights/settings`),
  aiActivity:pid=>api(pid?`/api/projects/${pid}/ai-insights/activity`:'/api/ai-insights/activity'),
  aiRuntimeSettings:()=>api('/api/admin/ai-runtime'),
  aiSaveRuntimeSettings:data=>api('/api/admin/ai-runtime',{method:'PUT',body:JSON.stringify(data)}),
  aiRun: (pid,module,retry_of,article_id) => api(`/api/projects/${pid}/ai-insights/runs`, {method:'POST',body:JSON.stringify({module,...(retry_of?{retry_of}:{}),...(article_id?{article_id}:{})})}),
  aiModelSettings: () => api('/api/admin/ai-model'),
  aiSaveModelSettings: data => api('/api/admin/ai-model',{method:'PUT',body:JSON.stringify(data)}),
  aiRunStatus: (pid,id) => api(`/api/projects/${pid}/ai-insights/runs/${id}`),
  aiSaveSettings: (pid,data) => api(`/api/projects/${pid}/ai-insights/settings`, {method:'PUT',body:JSON.stringify(data)}),
  aiFeedback: (pid,id,data) => api(`/api/projects/${pid}/ai-insights/${id}/feedback`, {method:'PATCH',body:JSON.stringify(data)}),
  // 当前用户、用户管理、项目转让与协作者
  me: async ({bootstrap=false}={}) => {try{const user=(bootstrap?takeBootstrappedUser(document):null)||await api('/api/me');reads.setIdentity(user);return user;}catch(error){reads.setIdentity(null);throw error;}},
  invalidateReads: () => reads.clear(),
  forgetIdentity: () => reads.setIdentity(null),
  mcpTokenStatus: () => api('/api/mcp-token'),
  createMcpToken: name => api('/api/mcp-token', { method: 'POST', body: JSON.stringify({ name }) }),
  resetMcpToken: id => api(`/api/mcp-token/${id}/reset`, { method: 'POST', body: '{}' }),
  revokeMcpToken: id => api(`/api/mcp-token/${id}`, { method: 'DELETE' }),
  mcpTools: () => api('/api/mcp/tools'),
  listUsers: () => api('/api/users'),
  listDeletedUsers: () => api('/api/users/deleted'),
  restoreUser: id => api(`/api/users/${id}/restore`, { method: 'POST', body: '{}' }),
  updateUserRole: (id, role) => api(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  // 账号显示名（账号-名字关联）：admin 配置，文案师名单/候选/指派界面显示
  updateUserName: (id, name) => api(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  userDeletionPreview: id => api(`/api/users/${id}/deletion-preview`),
  deleteUser: (id, recipientId) => api(`/api/users/${id}`, { method: 'DELETE', body: JSON.stringify({ transfer_to_user_id: recipientId }) }),
  transferProject: (id, ownerUserId) => api(`/api/projects/${id}/owner`, { method: 'PUT', body: JSON.stringify({ owner_user_id: ownerUserId }) }),

  settings: () => api('/api/settings'),
  saveSettings: (data) => api('/api/settings', { method: 'POST', body: JSON.stringify(data) }),
  oauthStart: () => api('/api/oauth/start'),
  accounts: () => api('/api/accounts'),
  accountResources: (id) => api(`/api/accounts/${id}/resources`),
  syncAccountResources: (id) => api(`/api/accounts/${id}/resource-sync`, {method:'POST',body:'{}'}),
  accountDisconnectImpact: (id) => api(`/api/accounts/${id}/disconnect-impact`),
  projectCandidates: (params={}) => sharedRead(candidatePath(params)),
  peekProjectCandidates: (params={}) => reads.peek(candidatePath(params)),
  projectCandidate: (id) => api(`/api/project-candidates/${id}?resources=picker`),
  candidateResources: (id,params={},opts={}) => api(`/api/resources/search?${new URLSearchParams({candidate_id:id,resources:'picker',...params})}`,opts),
  claimProjectCandidate: (id,data) => api(`/api/project-candidates/${id}/claim`,{method:'POST',body:JSON.stringify(data)}),
  hideProjectCandidate: (id,hidden) => api(`/api/project-candidates/${id}/${hidden?'ignore':'restore'}`,{method:'POST',body:'{}'}),
  projectResourceMatches: (id) => api(`/api/projects/${id}/resource-matches`),
  projectResources: (id,params={},opts={}) => api(`/api/resources/search?${new URLSearchParams({project_id:id,resources:'picker',...params})}`,opts),
  saveProjectResourceMatches: (id,data) => api(`/api/projects/${id}/resource-matches`,{method:'PUT',body:JSON.stringify(data)}),
  projectResourceEvents: (id,accountId,propertyId) => api(`/api/projects/${id}/resource-events?${new URLSearchParams({account_id:accountId,property_id:propertyId})}`),
  updateAccountNote: (id, note) => api(`/api/accounts/${id}`, { method: 'PUT', body: JSON.stringify({ note }) }),
  deleteAccount: (id) => api(`/api/accounts/${id}`, { method: 'DELETE' }),
  accountSites: (id) => api(`/api/accounts/${id}/sites`),
  accountProperties: (id) => api(`/api/accounts/${id}/properties`),
  accountEvents: (id, propertyId) => api(`/api/accounts/${id}/properties/${encodeURIComponent(propertyId)}/events`),
  projects: () => sharedRead('/api/projects'),
  createProject: (d) => api('/api/projects', { method: 'POST', body: JSON.stringify(d) }),
  updateProject: (id, d) => api(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  deleteProject: (id) => api(`/api/projects/${id}`, { method: 'DELETE' }),
  tasks: (projectId) => sharedRead(`/api/tasks${projectId ? `?project_id=${projectId}` : ''}`),
  createTask: (d) => api('/api/tasks', { method: 'POST', body: JSON.stringify(d) }),
  updateTask: (id, d) => api(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  deleteTask: (id) => api(`/api/tasks/${id}`, { method: 'DELETE' }),
  // 链接库
  links: (opts = {}) => api(`/api/links?${new URLSearchParams(Object.entries(opts).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]))}`),
  createLink: (d) => api('/api/links', { method: 'POST', body: JSON.stringify(d) }),
  updateLink: (id, d) => api(`/api/links/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  deleteLink: (id) => api(`/api/links/${id}`, { method: 'DELETE' }),
  // 项目主页：文章列表 + 任务/链接/外链概况
  projectHome: (projectId) => api(`/api/projects/${projectId}/home`),
  // 文案师名单（账号引用）：名单/候选 owner+协作者可见；业务下拉不许调 /api/users
  projectCopywriters: (projectId) => api(`/api/projects/${projectId}/copywriters`),
  copywriterCandidates: (projectId) => api(`/api/projects/${projectId}/copywriter-candidates`),
  enableCopywriter: (projectId, userId) => api(`/api/projects/${projectId}/copywriters`, { method: 'POST', body: JSON.stringify({ user_id: userId }) }),
  removeCopywriter: (projectId, copywriterId) => api(`/api/projects/${projectId}/copywriters/${copywriterId}`, { method: 'DELETE' }),
  // 单篇指派：copywriterId 传 null = 清空归属
  assignArticleCopywriter: (projectId, articleId, copywriterId) => api(`/api/projects/${projectId}/articles/${articleId}/copywriter`, { method: 'PUT', body: JSON.stringify({ copywriter_id: copywriterId }) }),
  // 外链文章管理（任务12）
  externalArticles: (projectId, params) => api(`/api/projects/${projectId}/external-articles?${params}`),
  createExternalArticle: (projectId, d) => api(`/api/projects/${projectId}/external-articles`, { method: "POST", body: JSON.stringify(d) }),
  updateExternalArticle: (projectId, aid, d) => api(`/api/projects/${projectId}/external-articles/${aid}`, { method: "PUT", body: JSON.stringify(d) }),
  changeExternalArticleUrl: (projectId, aid, url) => api(`/api/projects/${projectId}/external-articles/${aid}/url`, { method: "PUT", body: JSON.stringify({ url }) }),
  setExternalArticleStatus: (projectId, aid, status) => api(`/api/projects/${projectId}/external-articles/${aid}/status`, { method: "PUT", body: JSON.stringify({ status }) }),
  setExternalArticleDomain: (projectId, aid, domain) => api(`/api/projects/${projectId}/external-articles/${aid}/domain`, { method: "PUT", body: JSON.stringify({ domain }) }),
  deleteExternalArticle: (projectId, aid) => api(`/api/projects/${projectId}/external-articles/${aid}`, { method: "DELETE" }),
  batchExternalAssign: (projectId, articleIds, copywriterId, mode) => api(`/api/projects/${projectId}/external-articles/batch-assign`, { method: "POST", body: JSON.stringify({ article_ids: articleIds, copywriter_id: copywriterId, mode }) }),
  batchExternalStatus: (projectId, articleIds, status) => api(`/api/projects/${projectId}/external-articles/batch-status`, { method: "POST", body: JSON.stringify({ article_ids: articleIds, status }) }),
  batchDeleteExternalArticles: (projectId, articleIds) => api(`/api/projects/${projectId}/external-articles/batch-delete`, { method: "POST", body: JSON.stringify({ article_ids: articleIds }) }),
  externalImportPreview: (projectId, text, restoreInactive) => api(`/api/projects/${projectId}/external-articles/import-preview`, { method: "POST", body: JSON.stringify({ text, restoreInactive: !!restoreInactive }) }),
  externalImportPreviewXlsx: (projectId, base64, restoreInactive) => api(`/api/projects/${projectId}/external-articles/import-preview`, { method: "POST", body: JSON.stringify({ xlsx: base64, restoreInactive: !!restoreInactive }) }),
  externalArticleTemplateUrl: (projectId) => `/api/projects/${projectId}/external-articles/import-template.xlsx`,
  // restoreInactive：导入前显式勾选，才允许把匹配到的已停用外链恢复启用
  externalImportConfirm: (projectId, items, restoreInactive) => api(`/api/projects/${projectId}/external-articles/import-confirm`, { method: "POST", body: JSON.stringify({ items, restoreInactive: !!restoreInactive }) }),
  syncExternalDaily: (projectId, opts = {}) => api(`/api/projects/${projectId}/fetch-external-daily`, { method: "POST", body: JSON.stringify(opts) }),
  // 外链平台看板（任务12）
  externalPlatforms: (params) => api(`/api/article-monitor/external?${params}`),
  externalPlatformDetail: (projectId, domain) => api(`/api/article-monitor/external/${projectId}/${domain}/articles`),
  // 站内监控看板（任务09）
  articleMonitorList: (params) => api(`/api/article-monitor?${params}`),
  articleMonitorOptions: () => sharedRead('/api/article-monitor/options'),
  articleMonthly: (articleId) => api(`/api/article-monitor/${articleId}/monthly`),
  // 站内文章管理（任务06）
  projectArticles: (projectId, params) => api(`/api/projects/${projectId}/articles?${params}`),
  article: (projectId, articleId) => api(`/api/projects/${projectId}/articles/${articleId}/meta`),
  createArticle: (projectId, d) => api(`/api/projects/${projectId}/articles`, { method: 'POST', body: JSON.stringify(d) }),
  updateArticle: (projectId, articleId, d) => api(`/api/projects/${projectId}/articles/${articleId}`, { method: 'PUT', body: JSON.stringify(d) }),
  changeArticleUrl: (projectId, articleId, url) => api(`/api/projects/${projectId}/articles/${articleId}/url`, { method: 'PUT', body: JSON.stringify({ url }) }),
  setArticleStatus: (projectId, articleId, status) => api(`/api/projects/${projectId}/articles/${articleId}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  batchArticleStatus: (projectId, articleIds, status) => api(`/api/projects/${projectId}/articles/batch-status`, { method: 'POST', body: JSON.stringify({ article_ids: articleIds, status }) }),
  deleteArticle: (projectId, articleId) => api(`/api/projects/${projectId}/articles/${articleId}`, { method: 'DELETE' }),
  batchDeleteArticles: (projectId, articleIds) => api(`/api/projects/${projectId}/articles/batch-delete`, { method: 'POST', body: JSON.stringify({ article_ids: articleIds }) }),
  reorderArticles: (projectId, ids) => api(`/api/projects/${projectId}/articles/order`, { method: 'PUT', body: JSON.stringify({ ids }) }),
  articleUrlHistory: (projectId, articleId) => api(`/api/projects/${projectId}/articles/${articleId}/url-history`),
  importArticlesPreview: (projectId, text) => api(`/api/projects/${projectId}/articles/import-preview`, { method: 'POST', body: JSON.stringify({ text }) }),
  importArticlesPreviewXlsx: (projectId, base64) => api(`/api/projects/${projectId}/articles/import-preview`, { method: 'POST', body: JSON.stringify({ xlsx: base64 }) }),
  articleImportTemplateUrl: (projectId) => `/api/projects/${projectId}/articles/import-template.xlsx`,
  importArticlesConfirm: (projectId, items) => api(`/api/projects/${projectId}/articles/import-confirm`, { method: 'POST', body: JSON.stringify({ items }) }),
  assignCopywritersPreview: (projectId, articleIds, copywriterId, mode) => api(`/api/projects/${projectId}/copywriter-assignments`, { method: 'POST', body: JSON.stringify({ article_ids: articleIds, copywriter_id: copywriterId, mode, preview: true }) }),
  assignCopywriters: (projectId, articleIds, copywriterId, mode) => api(`/api/projects/${projectId}/copywriter-assignments`, { method: 'POST', body: JSON.stringify({ article_ids: articleIds, copywriter_id: copywriterId, mode }) }),
  // 站内文章月度同步（任务07）
  articleSyncPlan: (projectId) => api(`/api/projects/${projectId}/article-sync/plan`),
  syncArticles: (projectId, opts = {}) => api(`/api/projects/${projectId}/article-sync`, { method: 'POST', body: JSON.stringify(opts) }),
  syncArticle: (projectId, articleId, opts = {}) => api(`/api/projects/${projectId}/articles/${articleId}/article-sync`, { method: 'POST', body: JSON.stringify(opts) }),
  // 关键事件（转化率判据）：GA4 候选 + stale + 影响范围
  articleKeyEvents: (projectId) => api(`/api/projects/${projectId}/article-key-events`),
  saveArticleKeyEvents: (projectId, names) => api(`/api/projects/${projectId}/article-key-events`, { method: 'PUT', body: JSON.stringify({ eventNames: names }) }),
  // 同步任务（入队 → 轮询 → 终态）
  startSyncJob: (projectId, opts = {}) => api(`/api/projects/${projectId}/article-monitor/sync`, { method: 'POST', body: JSON.stringify(opts) }),
  syncJob: (jobId) => api(`/api/article-monitor-sync-jobs/${jobId}`),
  syncJobs: projectId => api(`/api/projects/${projectId}/article-monitor/sync-jobs`),
  // 标题自动获取：项目级（处理全部启用且标题为空的文章）+ 单篇重试
  fetchMissingTitles: (projectId, kind = 'internal') => api(`/api/projects/${projectId}/article-title-fetch`, { method: 'POST', body: JSON.stringify({ kind }) }),
  refetchArticleTitle: (projectId, articleId) => api(`/api/projects/${projectId}/articles/${articleId}/refetch-title`, { method: 'POST', body: '{}' }),
  refetchExternalTitle: (projectId, articleId) => api(`/api/projects/${projectId}/external-articles/${articleId}/refetch-title`, { method: 'POST', body: '{}' }),
  // 批量指派：mode = 'fill_empty'（只填空置）| 'overwrite'（覆盖）
  assignCopywriters: (projectId, articleIds, copywriterId, mode = 'fill_empty') => api(`/api/projects/${projectId}/copywriter-assignments`, { method: 'POST', body: JSON.stringify({ article_ids: articleIds, copywriter_id: copywriterId, mode }) }),  // range = { month: 'YYYY-MM' } 或 { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
  metrics: (projectId, range) => api(`/api/projects/${projectId}/metrics?${new URLSearchParams(range)}`),
  // GSC 全量快照
  gscSnapshotLatest: (projectId, opts = {}) => api(`/api/projects/${projectId}/gsc-snapshot/latest?${new URLSearchParams(opts)}`),
  gscSnapshotOverview: () => api('/api/gsc-snapshot-overview'),
  gscSnapshotQueriesForUrl: (projectId, urlId, opts = {}) => api(`/api/projects/${projectId}/gsc-snapshot/latest/queries/${urlId}?${new URLSearchParams(opts)}`),
  overview: (range) => api(`/api/overview?${new URLSearchParams(range)}`),
  // 我发的外链建设（用户主动登记的 URL + GA4 反查累计）
  externalLinks: (projectId) => api(`/api/projects/${projectId}/external-links`),
  allExternalLinks: () => api('/api/external-links'),
  // 反查：拿用户登记的 URL 列表去 GA4 sessionSource 反查会话/关键事件累计
  // { project_id?, from?: 'YYYY-MM', to?: 'YYYY-MM' }
  history: (params = {}) => api(`/api/history?${new URLSearchParams(params)}`),
};
export { API };
