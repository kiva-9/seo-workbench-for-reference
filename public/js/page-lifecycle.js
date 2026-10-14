// 每次渲染只接受自身的响应；换页后的 DOM 会被分离，旧请求不能再绑定新页面。
const revisions = new WeakMap();
let navigationRevision = 0;
globalThis.window?.addEventListener('seo-route-change', () => { navigationRevision++; });

export function beginPageRender(element) {
  const revision = (revisions.get(element) || 0) + 1;
  revisions.set(element, revision);
  return () => element.isConnected && revisions.get(element) === revision;
}

// 写请求与弹窗使用入口时的页面身份，离开再回到相同地址也不能接管新页面。
export function capturePageContext(element) {
  const revision = revisions.get(element);
  const navigation = navigationRevision;
  const route = globalThis.location?.hash;
  return () => Boolean(element?.isConnected) && revisions.get(element) === revision
    && navigationRevision === navigation && globalThis.location?.hash === route;
}
