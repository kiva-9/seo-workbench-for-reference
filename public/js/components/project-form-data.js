// 表单直接读取目标项目与账号，避免把尚未加载的列表缓存误当成新建状态。
export async function loadProjectFormData(api, id) {
  const [resourceData, accounts] = await Promise.all([
    id ? api.projectResourceMatches(id) : Promise.resolve(null),
    api.accounts(),
  ]);
  if (id && !resourceData?.project) throw new Error('项目不存在或已无访问权限，请刷新后重试');
  return { project: resourceData?.project ?? null, accounts, resourceData };
}
