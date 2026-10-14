const INTERNAL_SORT_FIELDS = ['project', 'published_at', 'clicks', 'views', 'events'];
export const EXTERNAL_SORT_OPTIONS = [
  ['project_name', '项目 → 平台'], ['domain', '平台域名'], ['matchedArticleCount', '命中文章数'],
  ['registeredArticleCount', '登记文章数'], ['activeArticleCount', '启用文章数'],
  ['usersTotal', '每日用户数累计'], ['eventsTotal', '关键事件'], ['lastSyncedAt', '最近成功同步'],
];

export function monitorSortFromLocation(sort, dir) {
  return INTERNAL_SORT_FIELDS.includes(sort)
    ? { sort, dir: ['asc', 'desc'].includes(dir) ? dir : sort === 'project' ? 'asc' : 'desc' }
    : { sort: 'created_at', dir: 'asc' };
}

export function externalSortFromLocation(sort) {
  return { sort: EXTERNAL_SORT_OPTIONS.some(([value]) => value === sort) ? sort : 'project_name', dir: 'asc' };
}

// 第三次点击恢复清单顺序，便于查看排序前后而不丢失默认位置。
export function nextMonitorSort(current, field) {
  if (!INTERNAL_SORT_FIELDS.includes(field)) return { sort: 'created_at', dir: 'asc' };
  const first = field === 'project' ? 'asc' : 'desc';
  if (current.sort !== field) return { sort: field, dir: first };
  if (current.dir === first) return { sort: field, dir: first === 'asc' ? 'desc' : 'asc' };
  return { sort: 'created_at', dir: 'asc' };
}

// 输入法选字期间不搜索；导航后丢弃旧输入框的定时回调。
export function bindSearchInput(input, onChange, delay = 250) {
  let timer;
  let composing = false;
  const queue = () => {
    clearTimeout(timer);
    if (composing) return;
    timer = setTimeout(() => {
      if (input.isConnected && !composing) onChange({ target: input });
    }, delay);
  };
  input.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); });
  input.addEventListener('compositionend', () => { composing = false; queue(); });
  input.addEventListener('input', queue);
}

// 弹出层避开宽表的滚动裁剪，滚动后关闭以免脱离所属行。
export function bindRowMenus(root, selector, scrollSelector) {
  const menus = [...root.querySelectorAll(selector)];
  const close = () => menus.forEach(menu => { menu.open = false; });
  menus.forEach(menu => {
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      menus.filter(other => other !== menu).forEach(other => { other.open = false; });
      const panel = menu.querySelector('div');
      const rect = menu.getBoundingClientRect();
      panel.style.left = Math.max(8, Math.min(rect.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8)) + 'px';
      panel.style.top = Math.max(8, Math.min(rect.bottom + 4, innerHeight - panel.offsetHeight - 8)) + 'px';
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { menu.open = false; menu.querySelector('summary').focus(); }
    });
  });
  root.addEventListener('click', event => { if (!event.target.closest(selector)) close(); });
  root.querySelector(scrollSelector)?.addEventListener('scroll', close, { passive: true });
}
