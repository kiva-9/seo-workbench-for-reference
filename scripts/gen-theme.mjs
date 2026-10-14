// gen-theme.mjs —— 用 Mantine 自己的 createTheme() 生成本站 Design Token CSS
//
// 为什么这么做：前端是原生 ES Modules、零构建步骤，不可能引入 React 运行时。
// 但 Design Token 可以完全复用 Mantine 的体系：这里真正调用 @mantine/core 的
// createTheme() 与 defaultCssVariablesResolver()，把 theme 编译成一套
// Mantine 原生命名的 CSS 变量（--mantine-color-* / --mantine-spacing-* /
// --mantine-radius-* / --mantine-font-size-* / --mantine-shadow-* ...）。
// 产出 public/css/theme.css，全站 CSS 只引用变量、不出现散落 hex。
//
// 改了色板/字阶/间距后跑：node scripts/gen-theme.mjs
// 该脚本不参与应用运行，也不进生产依赖（@mantine/core 是 devDependency）。

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTheme, mergeMantineTheme, DEFAULT_THEME, defaultCssVariablesResolver } from '@mantine/core';
import { palettePreviews, paletteVariants } from './theme-palettes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../public/css/theme.css');

/* ------------------------------------------------------------------ *
 * 1. 色板
 *
 * Mantine 约定每个色板 10 阶（索引 0=最浅, 9=最深），并且：
 *   - 非 primary 色的 `filled` 在 light 模式取 shade 6、dark 模式取 shade 4
 *   - 所以"语义色的基准 hex"必须放在索引 6，索引 4 放 dark 模式用的亮色
 * 这样同一个色板在明暗两套模式下都能由 Mantine 自动派生，不需要手写两套。
 * ------------------------------------------------------------------ */

// Pulse 的八个基色集中定义；色阶用于悬停、暗色和透明派生，不引入第二种强调色。
const terracotta = ['#fbf3ef', '#f5e4da', '#edc9b8', '#e6ae94', '#df977b', '#d7805e', '#c96442', '#b55332', '#994329', '#7b3725'];
const stone = ['#fafaf9', '#f5f4f1', '#e6e4e0', '#d4d1ca', '#a8a49c', '#6b6964', '#57544f', '#45413b', '#2a2825', '#1c1b1a'];
const success = ['#f1f6f2', '#e1eee5', '#c2ddcb', '#9bc9aa', '#8abe9b', '#579d70', '#2f7d4a', '#286b40', '#225b37', '#1c492d'];
const danger = ['#faf1ef', '#f3dcd7', '#e7bcb3', '#dd9a8e', '#e59687', '#c6604f', '#b53a2a', '#983123', '#7e291e', '#642118'];
// 提醒沿用赤陶，信息保持中性；状态由文字及图标共同表达。
const warning = terracotta;
const info = stone;

const FONT_STACK = '"Google Sans", "MiSans", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "MiSans", monospace';
const shadows = Object.fromEntries(['xs', 'sm', 'md', 'lg', 'xl'].map(key => [key, 'none']));

/* Mantine v8 的 createTheme() 是恒等函数，不合并默认值；
 * mergeMantineTheme 才是合并入口。合并后把内置色板全部丢掉 ——
 * 只保留本设计系统真正使用的色板，避免 theme.css 里出现 8 套用不到的颜色。 */
const theme = createTheme(mergeMantineTheme(DEFAULT_THEME, {
  primaryColor: 'terracotta',
  primaryShade: { light: 6, dark: 4 },
  colors: { terracotta, stone, success, warning, danger, info },
  fontFamily: FONT_STACK,
  fontFamilyMonospace: MONO_STACK,
  headings: {
    fontFamily: FONT_STACK,
    fontWeight: '600',
    textWrap: 'wrap',
    sizes: {
      h1: { fontSize: '28px', lineHeight: '1.3', fontWeight: '600' },
      h2: { fontSize: '20px', lineHeight: '1.35', fontWeight: '600' },
      h3: { fontSize: '14px', lineHeight: '1.4', fontWeight: '600' },
      h4: { fontSize: '14px', lineHeight: '1.45', fontWeight: '600' },
      h5: { fontSize: '14px', lineHeight: '1.45', fontWeight: '600' },
      h6: { fontSize: '14px', lineHeight: '1.45', fontWeight: '600' },
    },
  },
  // 五档字阶：微标签、辅助、正文、页标题、KPI。
  fontSizes: { xs: '12px', sm: '14px', md: '14px', lg: '20px', xl: '28px', xxl: '28px', micro: '11px' },
  lineHeights: { xs: '1.4', sm: '1.45', md: '1.5', lg: '1.55', xl: '1.6' },
  // 控件 6px、容器 10px；状态 pill 在组件内使用全圆角。
  radius: { xs: '6px', sm: '6px', md: '10px', lg: '10px' },
  defaultRadius: 'md',
  // 紧凑节奏：控件内部 8 / 相关元素 12 / 模块 16 / 区块 20 / 页面 24 / 大区块 28
  spacing: { xxs: '4px', xs: '8px', sm: '12px', md: '16px', lg: '20px', xl: '24px', xxl: '28px' },
  shadows,
}));
/* 只留 xs–lg，砍掉 Mantine 默认的 radius-xl(2rem)：从 token 层面禁止出现巨大圆角 */
theme.colors = { terracotta, stone, success, warning, danger, info };
theme.radius = { xs: '6px', sm: '6px', md: '10px', lg: '10px' };

/* ------------------------------------------------------------------ *
 * 3. 编译成 CSS 变量
 *
 * defaultCssVariablesResolver() 会按 Mantine 的规则派生
 * `-filled / -filled-hover / -light / -light-hover / -light-color / -outline / -outline-hover`。
 * 但它把语义中性色指向 Mantine 内置的 gray/dark 色板，这里全部改指到 stone。
 * ------------------------------------------------------------------ */

const vars = defaultCssVariablesResolver(theme);

// 亮色精确采用 Pulse 基色，暗色保留暖灰色温。
const neutralOverrides = {
  light: {
    '--mantine-color-body': '#fafaf9', '--mantine-color-text': '#1c1b1a',
    '--mantine-color-dimmed': '#6b6964', '--mantine-color-placeholder': '#6b6964',
    '--mantine-color-default': '#ffffff', '--mantine-color-default-hover': '#f5f4f1',
    '--mantine-color-default-color': '#1c1b1a', '--mantine-color-default-border': '#e6e4e0',
    '--mantine-color-disabled': '#f5f4f1', '--mantine-color-disabled-color': '#a8a49c',
    '--mantine-color-disabled-border': '#e6e4e0', '--mantine-color-error': '#b53a2a',
    '--mantine-primary-color-contrast': '#ffffff',
    // 原赤陶用于图形；小字按钮和链接使用同色深一阶，保证文字对比。
    '--mantine-color-terracotta-filled': '#b55332', '--mantine-color-terracotta-filled-hover': '#994329',
    '--mantine-primary-color-filled-hover': '#994329', '--mantine-color-anchor': '#b55332',
    '--mantine-color-terracotta-light-color': '#b55332',
  },
  dark: {
    '--mantine-color-body': '#1c1b1a', '--mantine-color-text': '#fafaf9',
    '--mantine-color-dimmed': '#b9b4aa', '--mantine-color-placeholder': '#b9b4aa',
    '--mantine-color-default': '#252320', '--mantine-color-default-hover': '#302d29',
    '--mantine-color-default-color': '#fafaf9', '--mantine-color-default-border': '#45413b',
    '--mantine-color-disabled': '#252320', '--mantine-color-disabled-color': '#a8a49c',
    '--mantine-color-disabled-border': '#45413b', '--mantine-color-error': '#e59687',
    '--mantine-primary-color-contrast': '#1c1b1a',
    '--mantine-primary-color-filled-hover': '#e6ae94', '--mantine-color-anchor': '#df977b',
    '--mantine-color-terracotta-light-color': '#df977b',
    '--mantine-color-success-light-color': '#8abe9b', '--mantine-color-danger-light-color': '#e59687',
  },
};

const semanticSoft = {
  light: {
    primary: ['rgba(201, 100, 66, 0.06)', 'rgba(201, 100, 66, 0.28)'],
    success: ['#fafaf9', 'rgba(47, 125, 74, 0.30)'],
    warning: ['#fafaf9', 'rgba(201, 100, 66, 0.28)'],
    danger: ['#fafaf9', 'rgba(181, 58, 42, 0.30)'],
    info: ['#fafaf9', '#e6e4e0'],
  },
  dark: {
    primary: ['rgba(223, 151, 123, 0.06)', 'rgba(223, 151, 123, 0.28)'],
    success: ['#252320', 'rgba(138, 190, 155, 0.30)'],
    warning: ['#252320', 'rgba(223, 151, 123, 0.28)'],
    danger: ['#252320', 'rgba(229, 150, 135, 0.30)'],
    info: ['#252320', '#45413b'],
  },
};

Object.assign(vars.light, neutralOverrides.light);
Object.assign(vars.dark, neutralOverrides.dark);
Object.assign(vars.variables, palettePreviews);
for (const [mode, values] of Object.entries({ light: vars.light, dark: vars.dark })) {
  Object.assign(values, {
    '--wb-focus-ring': `var(--mantine-color-terracotta-${mode === 'dark' ? 4 : 6})`,
    '--wb-nav-active-bg': 'var(--mantine-color-body)', '--wb-nav-active-fg': 'var(--mantine-color-text)',
    '--wb-nav-active-hover-bg': 'var(--mantine-color-default-hover)',
    '--wb-logo-bg': 'var(--mantine-color-body)', '--wb-logo-fg': 'var(--wb-accent)',
    '--wb-logo-border': 'var(--mantine-color-default-border)',
    '--wb-tab-active-bg': 'var(--mantine-color-default-hover)', '--wb-tab-active-fg': 'var(--mantine-color-text)',
  });
}

/* ------------------------------------------------------------------ *
 * 4. 应用级 token（Mantine 不产出的部分：控件高度、布局尺寸）
 * ------------------------------------------------------------------ */

const appTokens = {
  light: {
    // 控件高度统一：表格内嵌控件用 -xs，常规控件用 -sm。
    '--wb-control-h-xs': '32px',
    '--wb-control-h-sm': '36px',
    // 表格密度：垂直/水平 padding 与 caption 字号配套，各页不再各自写死
    '--wb-table-pad-y': '10px',
    '--wb-table-pad-x': '12px',
    // 自绘箭头宽 12px，距边框 12px；文字再留出一档间隔。
    '--wb-select-pad-right': '36px',
    // 紧凑侧栏与宽工作区兼顾信息密度。
    '--wb-sidebar-w': '220px',
    '--wb-nav-item-h': '44px',
    '--wb-page-bottom': '56px',
    '--wb-accent': '#c96442',
    '--wb-sidebar-w-compact': '64px',
    '--wb-topbar-h': '64px',
    '--wb-content-max': '1600px',
    '--wb-modal-overlay': 'rgba(28, 27, 26, 0.55)',
    '--wb-toast-bg': '#1c1b1a',
    '--wb-toast-fg': '#fafaf9',
  },
  dark: {
    '--wb-control-h-xs': '32px',
    '--wb-control-h-sm': '36px',
    '--wb-table-pad-y': '10px',
    '--wb-table-pad-x': '12px',
    '--wb-select-pad-right': '36px',
    '--wb-sidebar-w': '220px',
    '--wb-nav-item-h': '44px',
    '--wb-page-bottom': '56px',
    '--wb-accent': '#c96442',
    '--wb-sidebar-w-compact': '64px',
    '--wb-topbar-h': '64px',
    '--wb-content-max': '1600px',
    '--wb-modal-overlay': 'rgba(28, 27, 26, 0.72)',
    '--wb-toast-bg': '#e6e4e0',
    '--wb-toast-fg': '#1c1b1a',
  },
};

/* ------------------------------------------------------------------ *
 * 5. 组装 CSS
 * ------------------------------------------------------------------ */

function block(name, varsObj, comment) {
  if (!Object.keys(varsObj).length) return '';
  const lines = Object.entries(varsObj).map(([k, v]) => `  ${k}: ${v};`);
  return `/* ${comment} */\n${name} {\n${lines.join('\n')}\n}\n`;
}

const order = ['--mantine-z-index', '--mantine-scale', '--mantine-cursor-type', '--mantine-webkit', '--mantine-moz', '--mantine-color-white', '--mantine-color-black', '--mantine-line-height', '--mantine-font-family', '--mantine-heading', '--mantine-radius-default', '--mantine-primary-color', '--mantine-breakpoint', '--mantine-spacing', '--mantine-font-size', '--mantine-shadow', '--mantine-radius-', '--mantine-h1', '--mantine-h2', '--mantine-h3', '--mantine-h4', '--mantine-h5', '--mantine-h6', '--mantine-color-'];

function sorted(obj) {
  const idx = (k) => {
    const i = order.findIndex((p) => k.startsWith(p));
    return i === -1 ? order.length : i;
  };
  return Object.fromEntries(Object.entries(obj).sort((a, b) => {
    const d = idx(a[0]) - idx(b[0]);
    return d !== 0 ? d : a[0].localeCompare(b[0]);
  }));
}

const softVars = (map, isDark) => {
  const out = {};
  for (const [k, [bg, bd]] of Object.entries(map)) {
    out[`--wb-${k}-soft`] = bg;
    out[`--wb-${k}-border`] = bd;
  }
  // 语义色使用可读的明暗阶，前景色只产出实际用于实底反馈的两种。
  const shade = isDark ? 4 : 6;
  for (const k of ['primary', 'success', 'warning', 'danger', 'info']) {
    const name = k === 'primary' ? 'terracotta' : k;
    out[`--wb-${k}`] = k === 'info' ? 'var(--mantine-color-dimmed)'
      : k === 'primary' || k === 'warning' ? 'var(--mantine-primary-color-filled)'
      : `var(--mantine-color-${name}-${shade})`;
    if (k === 'success' || k === 'danger') out[`--wb-${k}-fg`] = isDark ? '#1c1b1a' : '#FFFFFF';
  }
  out['--wb-neutral-soft'] = isDark ? '#302d29' : '#fafaf9';
  out['--wb-neutral-border'] = isDark ? '#45413b' : '#e6e4e0';
  out['--wb-strong-border'] = isDark ? '#6b6964' : '#a8a49c';
  out['--wb-elevated'] = isDark ? '#302d29' : '#ffffff';
  return out;
};

const rootBlock = block(':root', sorted(vars.variables), 'Mantine 主题变量（与 Mantine 运行时同名，改 Theme 即全站生效）');

let lightBlock = block(':root,\n:root[data-mantine-color-scheme="light"]',
  sorted({ ...vars.light, ...softVars(semanticSoft.light, false), ...appTokens.light }),
  'Pulse Light —— 暖白底色、暖黑文字与赤陶强调');

let darkBlock = block(':root[data-mantine-color-scheme="dark"],\n:root.dark',
  sorted({ ...vars.dark, ...softVars(semanticSoft.dark, true), ...appTokens.dark }),
  'Pulse Dark —— 暖灰表面与浅赤陶强调');

const header = `/* theme.css —— 由 scripts/gen-theme.mjs 生成，请勿手改
 *
 * Pulse 暖色 / 黑白经典 / 青绿色，共用 MiSans + Google Sans 与同一套排版
 *
 * 单一样式来源：全站 CSS 只允许引用本文件的变量，不允许散落 hex。
 * 改色板、字阶、圆角、间距、阴影 → 改 scripts/gen-theme.mjs → 重新生成本文件。
 *
 * 变量分两类：
 *   1. --mantine-*   Mantine 主题契约（与 React 版 MantineProvider 同名同义）
 *   2. --wb-*        应用级 token：语义色快捷方式、soft 背景、控件高度、布局尺寸
 *
 * 配色与深浅模式独立；变体只覆盖颜色，不改变字体、间距或布局。
 */
`;

const palettes = paletteVariants(theme);
const variants = palettes.map(({ id, label, variables, light, dark }) => {
  const selector = `:root[data-palette="${id}"]`;
  return block(selector, sorted(variables), `${label}色板`)
    + block(`${selector}:not(.dark):not([data-mantine-color-scheme="dark"])`, sorted(light), `${label}浅色`)
    + block(`${selector}[data-mantine-color-scheme="dark"],\n${selector}.dark`, sorted(dark), `${label}深色`);
}).join('\n');
writeFileSync(out, `${header}\n${rootBlock}\n${lightBlock}\n${darkBlock}\n${variants}`);
mkdirSync(resolve(here, '../public/css'), { recursive: true });

// 标签页图标与侧栏标识共享颜色，独立 URL 让浏览器在切换后重新选择图标。
const iconsDir = resolve(here, '../public/icons');
mkdirSync(iconsDir, { recursive: true });
const favicon = (background, foreground) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="${background}"/><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" fill="${foreground}"/></svg>`;
for (const mode of ['light', 'dark']) {
  const pulse = favicon(neutralOverrides[mode]['--mantine-color-body'], appTokens[mode]['--wb-accent']);
  writeFileSync(resolve(iconsDir, `favicon-pulse-${mode}.svg`), pulse);
  if (mode === 'light') writeFileSync(resolve(here, '../public/favicon.svg'), pulse);
  for (const palette of palettes) {
    writeFileSync(resolve(iconsDir, `favicon-${palette.id}-${mode}.svg`),
      favicon(palette[mode]['--wb-logo-bg'], palette[mode]['--wb-logo-fg']));
  }
}

const n = (o) => Object.keys(o).length;
console.log(`theme.css written: ${out}`);
console.log(`  variables : ${n(vars.variables)}`);
console.log(`  light     : ${n(vars.light) + n(softVars(semanticSoft.light, false)) + n(appTokens.light)}`);
console.log(`  dark      : ${n(vars.dark) + n(softVars(semanticSoft.dark, true)) + n(appTokens.dark)}`);
