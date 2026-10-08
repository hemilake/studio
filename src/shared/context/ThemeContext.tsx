import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { setBrandName } from '@/shared/constants';
import { getEmbedMode, onConsoleMessage } from '@/shared/embedBridge';
import {
  DEFAULT_THEME_ID,
  isThemeId,
  THEME_LIST,
  THEMES,
  type ThemeDefinition,
  type ThemeId,
} from '@/shared/theme/registry';
import {
  readUserPreference,
  subscribeToUserPreferences,
  writeUserPreference,
} from '@/shared/userSettings';

type ThemeContextValue = {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
  /** Fork: the theme in use (the user's pick, else the instance default). */
  theme: ThemeDefinition;
  /** Fork: the theme this instance starts with, set by the server. */
  instanceThemeId: ThemeId;
  /** Fork: the user's own pick, or null when they follow the instance default. */
  userThemeId: ThemeId | null;
  themes: ThemeDefinition[];
  /** Fork: null goes back to the instance default. */
  setThemeId: (id: ThemeId | null) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

/** Fork (inline visuals): dark mode, or the <html> class outside a ThemeProvider (tests, isolated renders). */
export const useIsDarkMode = (): boolean =>
  useContext(ThemeContext)?.isDarkMode ?? document.documentElement.classList.contains('dark');

/** Fork: the active theme definition, or the default outside a ThemeProvider (tests, isolated renders). */
export const useThemeDefinition = (): ThemeDefinition => useContext(ThemeContext)?.theme ?? THEMES[DEFAULT_THEME_ID];

/**
 * Fork (embed mode): inside a Hemilake console Studio wears Hemilake's theme and
 * the console's light or dark, and never stores either: the user's own choices
 * still apply when Studio is opened on its own.
 */
const EMBEDDED = getEmbedMode() !== null;

const systemPrefersDark = (): boolean => (
  typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches)
);

/** Fork: the instance default seen last time, so the first paint (and the login screen) is already right. */
const INSTANCE_THEME_STORAGE_KEY = 'instance-theme';

function readCachedInstanceTheme(): ThemeId {
  try {
    const cached = localStorage.getItem(INSTANCE_THEME_STORAGE_KEY);
    return isThemeId(cached) ? cached : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

function readUserTheme(): ThemeId | null {
  const saved = readUserPreference<unknown>('colorTheme', null);
  return isThemeId(saved) ? saved : null;
}

function setLink(rel: string, href: string, type?: string): void {
  const selector = type ? `link[rel="${rel}"][type="${type}"]` : `link[rel="${rel}"]`;
  let link = document.querySelector<HTMLLinkElement>(selector);
  if (!link) {
    link = document.createElement('link');
    link.rel = rel;
    if (type) link.type = type;
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') !== href) {
    link.setAttribute('href', href);
  }
}

/** Sets the {{brand}} default variable; without an i18next instance (isolated tests) there is nothing to update. */
function setTranslationBrand(i18n: ReturnType<typeof useTranslation>['i18n'] | undefined, brand: string): void {
  if (!i18n?.options) {
    return;
  }
  const interpolation = i18n.options.interpolation ?? (i18n.options.interpolation = {});
  interpolation.defaultVariables = { ...interpolation.defaultVariables, brand };
}

/** Mounted once by App so every module can read and switch the colour theme through useTheme. */
export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const { i18n } = useTranslation();

  // Check for saved theme preference or default to system preference. The
  // stored theme is read synchronously from the preference mirror so the very
  // first paint is already the right colour.
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (EMBEDDED) {
      return systemPrefersDark();
    }
    const savedTheme = readUserPreference<string | null>('theme', null);
    if (savedTheme) {
      return savedTheme === 'dark';
    }

    // Check system preference
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    return false;
  });

  const [instanceThemeId, setInstanceThemeId] = useState<ThemeId>(readCachedInstanceTheme);
  const [userThemeId, setUserThemeId] = useState<ThemeId | null>(readUserTheme);
  const theme = THEMES[EMBEDDED ? DEFAULT_THEME_ID : userThemeId ?? instanceThemeId];

  // The brand is also read outside React (page title) and by translations
  // ({{brand}}); keep both current before children render.
  setBrandName(theme.brandName);
  setTranslationBrand(i18n, theme.brandName);

  // Fork: the server says which theme this instance starts with (CLOUDCLI_THEME).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/appearance')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { theme?: unknown } | null) => {
        if (cancelled || !isThemeId(body?.theme)) return;
        try {
          localStorage.setItem(INSTANCE_THEME_STORAGE_KEY, body.theme);
        } catch {
          // A private window without storage still gets the theme for this load.
        }
        setInstanceThemeId(body.theme);
      })
      .catch(() => {
        // Offline or an older server: keep the cached default.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The theme now lives in auth.db, so a change made on another device (or in
  // another tab) arrives through the preference store rather than a re-render.
  useEffect(() => subscribeToUserPreferences(() => {
    const savedTheme = readUserPreference<string | null>('theme', null);
    if (savedTheme && !EMBEDDED) {
      setIsDarkMode(savedTheme === 'dark');
    }
    setUserThemeId(readUserTheme());
  }), []);

  // Applying the theme to the document and persisting it are deliberately
  // separate. Persisting from here would also fire on mount — before the stored
  // theme had been fetched — writing this device's system default over the
  // theme the user actually chose on another one.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', isDarkMode);
    root.dataset.theme = theme.id;

    // Update iOS status bar style and the browser theme colour for this theme and mode
    const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (statusBarMeta) {
      statusBarMeta.setAttribute('content', isDarkMode ? 'black-translucent' : 'default');
    }
    const browserColor = isDarkMode ? theme.browserColor.dark : theme.browserColor.light;
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute('content', browserColor);
    });

    setLink('icon', theme.favicon.svg, 'image/svg+xml');
    setLink('icon', theme.favicon.png, 'image/png');
    setLink('apple-touch-icon', theme.favicon.appleTouch);
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', theme.brandName);

    // Web font for themes that need one beyond the Plex index.html loads.
    const fontLinkId = 'theme-font';
    const existingFont = document.getElementById(fontLinkId);
    if (theme.fontStylesheet) {
      setLink('stylesheet', theme.fontStylesheet);
      const link = document.querySelector(`link[rel="stylesheet"][href="${theme.fontStylesheet}"]`);
      if (link) link.id = fontLinkId;
      if (existingFont && existingFont !== link) existingFont.remove();
    } else {
      existingFont?.remove();
    }

    // A title that still names another theme's product follows the switch.
    for (const other of THEME_LIST) {
      if (other.id !== theme.id && document.title.includes(other.brandName)) {
        document.title = document.title.replace(other.brandName, theme.brandName);
      }
    }
  }, [isDarkMode, theme]);

  // Listen for system theme changes
  useEffect(() => {
    if (!window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      // Only update if user hasn't manually set a preference (embedded, the
      // console follows the system too, so Studio does as well)
      const savedTheme = readUserPreference<string | null>('theme', null);
      if (!savedTheme || EMBEDDED) {
        setIsDarkMode(e.matches);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // The only writer: a theme is stored because the user picked it, never
  // because this device happened to start on one.
  const toggleDarkMode = useCallback(() => {
    setIsDarkMode((previous) => {
      const next = !previous;
      if (!EMBEDDED) {
        writeUserPreference('theme', next ? 'dark' : 'light');
      }
      return next;
    });
  }, []);

  // Fork (embed mode): the console says light or dark on load and on change.
  useEffect(() => {
    if (!EMBEDDED) {
      return undefined;
    }
    return onConsoleMessage((message) => {
      if (message.type === 'theme') {
        setIsDarkMode(message.mode === 'dark');
      }
    });
  }, []);

  const setThemeId = useCallback((id: ThemeId | null) => {
    setUserThemeId(id);
    writeUserPreference('colorTheme', id);
  }, []);

  // A fresh object here would re-render every consumer in the app on any
  // render of this provider, theme change or not.
  const value = useMemo<ThemeContextValue>(
    () => ({ isDarkMode, toggleDarkMode, theme, instanceThemeId, userThemeId, themes: THEME_LIST, setThemeId }),
    [isDarkMode, toggleDarkMode, theme, instanceThemeId, userThemeId, setThemeId],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
