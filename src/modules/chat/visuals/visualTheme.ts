import type { ThemeId } from '@/shared/theme/registry';

/**
 * Fork (inline visuals): the theme a visual is drawn with.
 *
 * A visual runs in a sandboxed frame that inherits none of Studio's styles, so
 * the host resolves the theme into literal CSS values and writes them into the
 * frame's document. Studio's tokens are bare HSL channels (`37.5 31% 95%`),
 * which a model would misuse as colours, so the frame gets both the raw tokens
 * and ready-to-use aliases.
 */

/** Studio tokens copied into the frame as they are (bare channels), for `hsl(var(--x))`. */
const RAW_TOKENS = [
  'background', 'foreground', 'card', 'card-foreground', 'muted', 'muted-foreground',
  'primary', 'primary-foreground', 'border', 'destructive',
  'hemi-copper', 'hemi-copper-text', 'hemi-copper-tint', 'hemi-ok', 'hemi-ok-tint',
] as const;

/** Ready-to-use colour aliases: name in the frame → Studio token. */
const COLOR_ALIASES: Record<string, string> = {
  'color-bg': 'background',
  'color-surface': 'card',
  'color-text': 'foreground',
  'color-muted': 'muted-foreground',
  'color-border': 'border',
  'color-subtle': 'muted',
  'color-accent': 'hemi-copper',
  'color-accent-text': 'hemi-copper-text',
  'color-accent-tint': 'hemi-copper-tint',
  'color-ok': 'hemi-ok',
  'color-ok-tint': 'hemi-ok-tint',
  'color-danger': 'destructive',
};

/**
 * Categorical series colours, in order. Each is the bundled `dataviz` skill's
 * validated palette with slot 2 swapped for the theme's accent; every row passes
 * that skill's validate_palette.py (light on #ffffff, dark on the theme's card).
 */
export const CHART_PALETTES: Record<ThemeId, { light: string[]; dark: string[] }> = {
  hemilake: {
    light: ['#2a78d6', '#c8622a', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    dark: ['#3987e5', '#d9733f', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  },
  orange: {
    light: ['#2a78d6', '#f16e00', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  },
  classic: {
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  },
};

export type VisualTheme = {
  themeId: ThemeId;
  isDark: boolean;
  /** The `:root { … }` block written into the frame. */
  css: string;
};

type ReadToken = (name: string) => string;

const readFromDocument: ReadToken = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();

/** Builds the frame's theme from Studio's live tokens. `read` is injectable for tests. */
export function buildVisualTheme(themeId: ThemeId, isDark: boolean, read: ReadToken = readFromDocument): VisualTheme {
  const lines: string[] = [];
  for (const token of RAW_TOKENS) {
    const value = read(token);
    if (value) {
      lines.push(`--${token}: ${value};`);
    }
  }
  for (const [alias, token] of Object.entries(COLOR_ALIASES)) {
    const value = read(token);
    if (value) {
      lines.push(`--${alias}: hsl(${value});`);
    }
  }
  const border = read('border');
  if (border) {
    // Gridlines: the border colour, lighter, so they recede behind the data.
    lines.push(`--color-grid: hsl(${border} / 0.55);`);
  }
  const palette = CHART_PALETTES[themeId] ?? CHART_PALETTES.hemilake;
  (isDark ? palette.dark : palette.light).forEach((color, index) => {
    lines.push(`--chart-${index + 1}: ${color};`);
  });
  const sans = read('font-sans');
  const mono = read('font-mono');
  lines.push(`--font-sans: ${sans || 'system-ui, sans-serif'};`);
  lines.push(`--font-mono: ${mono || 'ui-monospace, monospace'};`);
  lines.push(`--radius: ${read('radius') || '0.5rem'};`);
  lines.push(`color-scheme: ${isDark ? 'dark' : 'light'};`);
  return { themeId, isDark, css: `:root {\n  ${lines.join('\n  ')}\n}` };
}
