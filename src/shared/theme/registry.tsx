import type { ComponentType } from 'react';

import { cn } from '@/shared/utils';
import { HemilakeMark, HemilakeWordmark } from '@/shared/ui/BrandMark';

/**
 * Fork: the themes a user can pick in Settings › Appearance. A theme is a palette
 * (src/index.css for Hemilake, src/shared/theme/themes.css for the rest) plus the
 * brand shown with it: name, mark, wordmark, favicon and browser theme colour.
 * The ids must match `data-theme` in themes.css and THEMES in server/shared/themes.ts.
 */
export type ThemeId = 'hemilake' | 'orange' | 'classic';

export const DEFAULT_THEME_ID: ThemeId = 'hemilake';

export type BrandMarkSize = 'small' | 'large';

export type ThemeDefinition = {
  id: ThemeId;
  /** Shown in the theme picker. */
  label: string;
  /** Product name: page title, PWA name and the `{{brand}}` variable of every translation. */
  brandName: string;
  /** The name as the sidebar footer writes it next to the upstream version. */
  footerName: string;
  /** Extra stylesheet for the theme's web font; Hemilake's Plex is loaded by index.html. */
  fontStylesheet?: string;
  favicon: { svg: string; png: string; appleTouch: string };
  /** `<meta name="theme-color">` for light and dark mode. */
  browserColor: { light: string; dark: string };
  /** Swatches for the picker: background, foreground, accent. */
  swatches: [string, string, string];
  Mark: ComponentType<{ className?: string; size?: BrandMarkSize }>;
  Wordmark: ComponentType<{ className?: string }>;
};

/** Orange's logo is used as delivered, never redrawn: the small version below 50 px, the full one above. */
function OrangeMark({ className, size = 'small' }: { className?: string; size?: BrandMarkSize }) {
  return (
    <img
      src={size === 'large' ? '/themes/orange/logo.svg' : '/themes/orange/logo-small.svg'}
      alt=""
      aria-hidden="true"
      className={cn('h-4 w-4', className)}
    />
  );
}

function OrangeWordmark({ className }: { className?: string }) {
  return <span className={cn('whitespace-nowrap font-bold text-foreground', className)}>Studio</span>;
}


export const THEMES: Record<ThemeId, ThemeDefinition> = {
  hemilake: {
    id: 'hemilake',
    label: 'Hemilake',
    brandName: 'Hemilake Studio',
    footerName: 'hemilake studio',
    favicon: { svg: '/favicon.svg', png: '/favicon.png', appleTouch: '/icons/icon-192x192.png' },
    browserColor: { light: '#F6F3EE', dark: '#181614' },
    swatches: ['#F6F3EE', '#1F1D1A', '#B5673B'],
    Mark: HemilakeMark,
    Wordmark: HemilakeWordmark,
  },
  orange: {
    id: 'orange',
    label: 'Orange',
    brandName: 'Orange Studio',
    footerName: 'Orange Studio',
    favicon: {
      svg: '/themes/orange/logo-small.svg',
      png: '/themes/orange/favicon.png',
      appleTouch: '/themes/orange/icon-192x192.png',
    },
    browserColor: { light: '#F6F6F6', dark: '#000000' },
    swatches: ['#FFFFFF', '#000000', '#FF7900'],
    Mark: OrangeMark,
    Wordmark: OrangeWordmark,
  },
  // Upstream's cream-and-blue palette under the Hemilake Studio brand: CloudCLI UI's licence
  // (LICENSE, Section 7) forbids presenting a modified version under its name or logo.
  classic: {
    id: 'classic',
    label: 'Classic blue',
    brandName: 'Hemilake Studio',
    footerName: 'hemilake studio',
    fontStylesheet: 'https://fonts.googleapis.com/css2?family=Encode+Sans:wght@400;500;600;700&display=swap',
    favicon: { svg: '/favicon.svg', png: '/favicon.png', appleTouch: '/icons/icon-192x192.png' },
    browserColor: { light: '#F6F4EF', dark: '#141414' },
    swatches: ['#F6F4EF', '#0D0B08', '#2563EB'],
    Mark: HemilakeMark,
    Wordmark: HemilakeWordmark,
  },
};

export const THEME_LIST: ThemeDefinition[] = [THEMES.hemilake, THEMES.orange, THEMES.classic];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && value in THEMES;
}
