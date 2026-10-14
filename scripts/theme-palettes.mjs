// 配色只覆盖颜色 token；字阶、间距、控件尺寸共用同一套基础主题。
import { defaultCssVariablesResolver } from '@mantine/core';

const zinc = ['#fafafa', '#f4f4f5', '#e4e4e7', '#d4d4d8', '#a1a1aa', '#71717a', '#52525b', '#3f3f46', '#27272a', '#09090b'];
const slate = ['#f8fafc', '#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#475569', '#334155', '#1e293b', '#0f172a'];
const ocean = ['#ecfeff', '#cffafe', '#a5f3fc', '#67e8f9', '#22d3ee', '#06b6d4', '#0891b2', '#0e7490', '#155e75', '#164e63'];
const green = ['#f0fdf4', '#dcfce7', '#bbf7d0', '#86efac', '#4ade80', '#22c55e', '#16a34a', '#15803d', '#166534', '#14532d'];
const emerald = ['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b'];
const red = ['#fef2f2', '#fee2e2', '#fecaca', '#fca5a5', '#f87171', '#ef4444', '#dc2626', '#b91c1c', '#991b1b', '#7f1d1d'];
const amber = ['#fffbeb', '#fef3c7', '#fde68a', '#fcd34d', '#fbbf24', '#f59e0b', '#d97706', '#b45309', '#92400e', '#78350f'];
const sky = ['#f0f9ff', '#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0ea5e9', '#0284c7', '#0369a1', '#075985', '#0c4a6e'];
const blue = ['#eff6ff', '#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a'];

export const palettePreviews = {
  '--wb-preview-mono': zinc[9], '--wb-preview-mono-soft': zinc[1],
  '--wb-preview-ocean': ocean[6], '--wb-preview-ocean-soft': ocean[1],
  '--wb-preview-pulse': '#c96442', '--wb-preview-pulse-soft': '#f5e4da',
};

const presets = [
  { id: 'mono', label: '黑白经典', neutral: zinc, primary: 'zinc', primaryShade: { light: 9, dark: 0 },
    colors: { zinc, success: emerald, danger: red, warning: amber, info: blue } },
  { id: 'ocean', label: '青绿色', neutral: slate, primary: 'ocean', primaryShade: { light: 7, dark: 4 },
    colors: { ocean, slate, success: green, danger: red, warning: amber, info: sky } },
];

const colorVariables = (variables) => Object.fromEntries(Object.entries(variables)
  .filter(([key]) => key.startsWith('--mantine-color-') || key.startsWith('--mantine-primary-color-')));

export function paletteVariants(baseTheme) {
  return presets.map((preset) => {
    const { id, label, neutral: n, primary, colors, primaryShade } = preset;
    const vars = defaultCssVariablesResolver({ ...baseTheme, primaryColor: primary, primaryShade, colors });
    const modes = {};
    for (const mode of ['light', 'dark']) {
      const dark = mode === 'dark';
      const mono = id === 'mono';
      const body = dark ? n[9] : mono ? '#ffffff' : n[0];
      const surface = dark ? mono ? '#18181b' : n[8] : '#ffffff';
      const hover = dark ? mono ? n[8] : n[7] : n[1];
      const border = dark ? mono ? n[8] : n[7] : n[2];
      const text = dark ? n[0] : n[9];
      const muted = dark ? mono ? n[4] : n[3] : mono ? n[6] : n[5];
      const filled = colors[primary][primaryShade[mode]];
      const contrast = dark ? n[9] : '#ffffff';
      const primarySoft = dark ? mono ? n[8] : ocean[9] : mono ? n[1] : ocean[0];
      const navBg = mono ? filled : primarySoft;
      modes[mode] = {
        ...colorVariables(vars[mode]),
        '--mantine-color-body': body, '--mantine-color-text': text,
        '--mantine-color-default': surface, '--mantine-color-default-hover': hover,
        '--mantine-color-default-color': text, '--mantine-color-default-border': border,
        '--mantine-color-dimmed': muted, '--mantine-color-placeholder': muted,
        '--mantine-color-disabled': hover, '--mantine-color-disabled-color': dark ? n[5] : n[4],
        '--mantine-color-disabled-border': border,
        '--mantine-color-error': colors.danger[dark ? 4 : 6],
        '--mantine-color-anchor': filled, '--mantine-primary-color-contrast': contrast,
        '--mantine-primary-color-filled-hover': colors[primary][mono ? dark ? 2 : 8 : dark ? 3 : 8],
        '--wb-primary': filled, '--wb-primary-soft': primarySoft,
        '--wb-primary-border': mono ? border : ocean[dark ? 7 : 2],
        '--wb-neutral-soft': hover, '--wb-neutral-border': border,
        '--wb-strong-border': dark ? n[5] : mono ? n[4] : n[3],
        '--wb-elevated': surface, '--wb-accent': mono ? filled : ocean[dark ? 4 : 6],
        '--wb-focus-ring': filled,
        '--wb-nav-active-bg': navBg, '--wb-nav-active-fg': mono ? contrast : filled,
        '--wb-nav-active-hover-bg': mono ? colors[primary][dark ? 2 : 8] : `var(--mantine-primary-color-light-hover)`,
        '--wb-logo-bg': filled, '--wb-logo-fg': contrast, '--wb-logo-border': filled,
        '--wb-tab-active-bg': mono ? hover : filled, '--wb-tab-active-fg': mono ? text : contrast,
        '--wb-toast-bg': dark ? n[1] : n[9], '--wb-toast-fg': dark ? n[9] : n[0],
        '--wb-modal-overlay': mono ? 'rgba(9, 9, 11, 0.55)' : 'rgba(2, 6, 23, 0.55)',
      };
      for (const semantic of ['success', 'warning', 'danger', 'info']) {
        const palette = colors[semantic];
        // 小字号状态标签用更深的绿色/琥珀色，避免浅色底上文字对比不足。
        const shade = dark ? 4 : semantic === 'danger' || (mono && semantic === 'info') ? 6 : 7;
        Object.assign(modes[mode], {
          [`--wb-${semantic}`]: palette[shade],
          [`--wb-${semantic}-soft`]: palette[dark ? 9 : 0],
          [`--wb-${semantic}-border`]: palette[dark ? 7 : 2],
        });
        if (semantic === 'success' || semantic === 'danger') modes[mode][`--wb-${semantic}-fg`] = contrast;
      }
    }
    return { id, label, variables: colorVariables(vars.variables), ...modes };
  });
}
