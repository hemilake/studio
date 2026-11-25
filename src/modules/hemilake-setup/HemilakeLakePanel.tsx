import { Check, Link2, Loader2, LogIn } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ProviderLoginModal } from '@/modules/provider-auth';
import type { useHemilakeSetup } from '@/modules/hemilake-setup/useHemilakeSetup';

type HemilakeLakePanelProps = {
  setup: ReturnType<typeof useHemilakeSetup>;
};

const inputClassName =
  'w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground/60 hover:border-foreground/20 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30';
const primaryButton =
  'inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Fork (Hemilake): connects a standalone Studio to the owner's Hemilake: the Hemilake plugin (skills, recall and
 * session-memory hooks, the lake's tools) installed into Claude Code and pointed at the lake, then
 * `claude mcp login plugin:hemilake:hemilake` runs the lake's OAuth sign-in (passkey, then Approve) in the browser;
 * Claude Code keeps the token, Studio never sees it.
 */
export default function HemilakeLakePanel({ setup }: HemilakeLakePanelProps) {
  const { t } = useTranslation('auth');
  const { status } = setup;
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [replaced, setReplaced] = useState<string[]>([]);

  if (!setup.available || !status) return null;

  const lake = status.lake;
  const host = lake.url ? new URL(lake.url).host : '';

  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await setup.connectLake(address);
      setReplaced(result.replaced);
      setAddress('');
      setSigningIn(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-3">
      {lake.url && (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              {host}
              {lake.state === 'connected' && <Check className="h-3.5 w-3.5 text-hemi-ok" />}
            </div>
            <div className="text-xs text-muted-foreground">
              {lake.state === 'connected'
                ? t('hemilakeSetup.lake.connected')
                : lake.state === 'needs-sign-in'
                  ? t('hemilakeSetup.lake.needsSignIn')
                  : lake.state === 'failed'
                    ? t('hemilakeSetup.lake.failed')
                    : t('hemilakeSetup.lake.added')}
            </div>
          </div>
          {lake.state !== 'connected' && (
            <button className={primaryButton} onClick={() => setSigningIn(true)}>
              <LogIn className="h-4 w-4" />
              {t('hemilakeSetup.lake.signIn')}
            </button>
          )}
        </div>
      )}

      {lake.url && !lake.plugin && <p className="text-xs text-muted-foreground">{t('hemilakeSetup.lake.upgradeHint')}</p>}
      {replaced.length > 0 && (
        <p className="text-xs text-muted-foreground">{t('hemilakeSetup.lake.replaced', { plugins: replaced.join(', ') })}</p>
      )}

      {!status.claude.installed ? (
        <p className="text-xs text-muted-foreground">{t('hemilakeSetup.lake.needsClaude')}</p>
      ) : (
        <div className="space-y-2">
          <label className="block text-xs text-muted-foreground" htmlFor="hemilake-address">
            {lake.url && lake.plugin ? t('hemilakeSetup.lake.otherAddress') : t('hemilakeSetup.lake.addressHint')}
          </label>
          <div className="flex gap-2">
            <input
              id="hemilake-address"
              className={inputClassName}
              placeholder="nombre.cloud.hemilake.app"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && address.trim()) void connect();
              }}
            />
            <button className={primaryButton} disabled={busy || !address.trim()} onClick={() => void connect()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              {t('hemilakeSetup.lake.connect')}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {signingIn && (
        <ProviderLoginModal
          isOpen
          provider="claude"
          customCommand={lake.loginCommand}
          title={t('hemilakeSetup.lake.signInTitle')}
          onClose={() => {
            setSigningIn(false);
            void setup.refresh();
          }}
        />
      )}
    </div>
  );
}
