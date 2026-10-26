import { useEffect, useState } from 'react';
import { Lock, Settings, AlertTriangle } from 'lucide-react';
import type { TFunction } from 'i18next';

import { IS_PLATFORM } from '@/shared/utils';
import type { ReleaseInfo } from '@/shared/types';
import { UPSTREAM_NAME, UPSTREAM_REPO_URL } from '@/shared/constants';
import { useThemeDefinition } from '@/shared/context/ThemeContext';
import { getE2EStatus, subscribeE2EStatus } from '@/shared/e2eTransport';

// Fork: the update banner and the Report Issue / Discord links are not rendered.
// The props stay in the type so callers are untouched (see docs/fork/CHANGES.md).
type SidebarFooterProps = {
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

/** Rendered by SidebarContent at the bottom of the panel for settings and restart status. */
export default function SidebarFooter({ restartRequired, currentVersion, onShowSettings, t }: SidebarFooterProps) {
  const { footerName } = useThemeDefinition();
  const [e2eStatus, setE2eStatus] = useState(() => getE2EStatus());

  useEffect(() => subscribeE2EStatus(setE2eStatus), []);

  return (
    <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      {/* Restart-required banner: the running server version differs from the
          installed/frontend version (updated but not restarted). */}
      {restartRequired && (
        <>
          <div className="nav-divider" />
          <div className="px-2 py-1.5 md:px-2 md:py-1.5">
            <div className="flex items-center gap-2.5 rounded-lg border border-hemi-copper/40 bg-hemi-copper-tint px-2.5 py-2">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 text-hemi-copper-text" />
              <span className="min-w-0 flex-1 text-xs font-medium text-hemi-copper-text">
                {t('version.restartRequired')}
              </span>
            </div>
          </div>
        </>
      )}

      {/* Settings */}
      <div className="nav-divider" />

      {/* Desktop settings */}
      <div className="hidden px-2 py-1.5 md:block">
        <button
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={onShowSettings}
        >
          <Settings className="h-3.5 w-3.5" />
          <span className="text-sm">{t('actions.settings')}</span>
        </button>
      </div>

      {/* Desktop version brand line (OSS mode only) */}
      {!IS_PLATFORM && (
        <div className="hidden items-center justify-center gap-1.5 px-3 py-2 text-center md:flex">
          <a
            href={UPSTREAM_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[10.5px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
          >
            {footerName} · {UPSTREAM_NAME} v{currentVersion}
          </a>
          {e2eStatus.active && (
            <span
              title={`End-to-end encrypted (AES-256-GCM) · Server key sha256:${e2eStatus.fingerprint ?? ''}`}
              className="inline-flex items-center gap-0.5 rounded bg-hemi-ok/15 px-1 py-0.5 font-mono text-[9.5px] font-medium text-hemi-ok"
            >
              <Lock className="h-2.5 w-2.5" />
              E2E
            </span>
          )}
        </div>
      )}

      {/* Mobile settings */}
      <div className="px-3 pb-3 pt-3 md:hidden">
        <button
          className="flex h-10 w-full items-center gap-3 rounded-xl bg-muted/40 px-3.5 transition-all hover:bg-muted/60 active:scale-[0.98]"
          onClick={onShowSettings}
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-background/80">
            <Settings className="h-4 w-4 text-muted-foreground" />
          </div>
          <span className="text-sm font-normal text-foreground">{t('actions.settings')}</span>
        </button>
      </div>
    </div>
  );
}
