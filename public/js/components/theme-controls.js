// 切换只更新根节点的颜色属性，不重新渲染业务页面和编辑草稿。
export function initThemeControls() {
  const preference = window.workbenchTheme;
  const options = document.querySelectorAll('[data-palette-option]');
  const modeButton = document.querySelector('#theme-btn');
  function update() {
    const { palette, mode } = preference.current();
    options.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.paletteOption === palette)));
    const dark = mode === 'dark';
    modeButton.setAttribute('aria-label', dark ? '切换为浅色模式' : '切换为深色模式');
    modeButton.title = modeButton.getAttribute('aria-label');
    document.querySelector('#theme-icon').innerHTML = dark
      ? '<circle cx="12" cy="12" r="4.5" fill="currentColor"/><path d="M12 2.5v2M12 19.5v2M3.5 12h2M18.5 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/>';
  }
  options.forEach((button) => { button.onclick = () => preference.setPalette(button.dataset.paletteOption); });
  modeButton.onclick = () => preference.toggleMode();
  window.addEventListener('seo-theme-change', update);
  update();
}
