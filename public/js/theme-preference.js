// 在样式表之前恢复外观，避免首屏闪回默认颜色。存储被禁用时仍能正常切换。
(() => {
  const root = document.documentElement;
  const palettes = ['mono', 'ocean', 'pulse'];
  const read = (key) => {
    try { return localStorage.getItem(key); } catch { return null; }
  };
  const save = (key, value) => {
    try { localStorage.setItem(key, value); } catch { /* 当前页面仍保留选择。 */ }
  };
  const current = () => ({ palette: root.dataset.palette, mode: root.dataset.mantineColorScheme });
  function apply({ palette, mode }, persist = true) {
    const before = current();
    palette = palettes.includes(palette) ? palette : 'pulse';
    mode = mode === 'dark' ? 'dark' : 'light';
    root.dataset.palette = palette;
    root.dataset.mantineColorScheme = mode;
    root.classList.toggle('dark', mode === 'dark');
    document.querySelector('link[rel="icon"]')?.setAttribute('href', `./icons/favicon-${palette}-${mode}.svg`);
    if (persist) {
      if (before.palette !== palette) save('seo_palette', palette);
      if (before.mode !== mode) save('seo_theme', mode);
    }
    if (before.palette !== palette || before.mode !== mode) window.dispatchEvent(new Event('seo-theme-change'));
  }
  const restore = () => apply({ palette: read('seo_palette'), mode: read('seo_theme') }, false);
  window.workbenchTheme = {
    current,
    setPalette: (palette) => apply({ ...current(), palette }),
    toggleMode: () => apply({ ...current(), mode: current().mode === 'dark' ? 'light' : 'dark' }),
  };
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === 'seo_palette' || event.key === 'seo_theme') restore();
  });
  restore();
})();
