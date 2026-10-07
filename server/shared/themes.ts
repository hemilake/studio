/**
 * Fork: the theme this instance starts with and what the PWA manifest says for
 * it. Users can pick another theme in Settings › Appearance; the manifest (app
 * name and home-screen icon) always follows the instance default. The ids must
 * match THEMES in src/shared/theme/registry.tsx.
 */
type ServerTheme = {
  name: string;
  shortName: string;
  backgroundColor: string;
  /** Prefix of icon-<size>x<size>.png; Hemilake keeps upstream's /icons folder. */
  iconPrefix: string;
};

const THEMES: Record<string, ServerTheme> = {
  hemilake: { name: 'Hemilake Studio', shortName: 'Hemilake', backgroundColor: '#F6F3EE', iconPrefix: '/icons' },
  orange: { name: 'Orange Studio', shortName: 'Orange Studio', backgroundColor: '#FFFFFF', iconPrefix: '/themes/orange' },
  classic: { name: 'Hemilake Studio', shortName: 'Hemilake', backgroundColor: '#F6F4EF', iconPrefix: '/icons' },
};

const DEFAULT_THEME = 'hemilake';

/** CLOUDCLI_THEME when it names a known theme, else Hemilake. */
export function getInstanceThemeId(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env.CLOUDCLI_THEME?.trim().toLowerCase();
  return requested && requested in THEMES ? requested : DEFAULT_THEME;
}

/** The static manifest with name, colours and icons swapped for the instance theme. */
export function themedManifest(base: Record<string, unknown>, themeId: string): Record<string, unknown> {
  const theme = THEMES[themeId] ?? THEMES[DEFAULT_THEME];
  const icons = Array.isArray(base.icons) ? base.icons : [];
  return {
    ...base,
    name: theme.name,
    short_name: theme.shortName,
    description: `${theme.name}, your personal AI workspace`,
    background_color: theme.backgroundColor,
    theme_color: theme.backgroundColor,
    icons: icons.map((icon) => {
      if (!icon || typeof icon !== 'object' || typeof (icon as { sizes?: unknown }).sizes !== 'string') {
        return icon;
      }
      const sizes = (icon as { sizes: string }).sizes;
      return { ...icon, src: `${theme.iconPrefix}/icon-${sizes}.png` };
    }),
  };
}
