import { Check, Download, KeyRound, Loader2, Network, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ProviderLoginModal } from '@/modules/provider-auth';
import type { useHemilakeSetup } from '@/modules/hemilake-setup/useHemilakeSetup';

type Mode = 'account' | 'api-key' | 'gateway';

type ClaudeConnectionPanelProps = {
  setup: ReturnType<typeof useHemilakeSetup>;
  /** Called after Claude Code was installed or signed in, so the caller can refresh its own auth status. */
  onChanged?: () => void;
};

const inputClassName =
  'w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground/60 hover:border-foreground/20 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30';
const primaryButton =
  'inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Fork (Hemilake): how a standalone Studio's Claude Code reaches a model. Installs Claude Code when it is missing,
 * then offers the owner's Claude account, an Anthropic API key, or an Anthropic-compatible gateway such as LiteLLM.
 */
export default function ClaudeConnectionPanel({ setup, onChanged }: ClaudeConnectionPanelProps) {
  const { t } = useTranslation('auth');
  const { status } = setup;
  const current = status?.connection.mode ?? 'account';
  const [mode, setMode] = useState<Mode>(current);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(status?.connection.baseUrl ?? '');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [command, setCommand] = useState<{ command: string; title: string } | null>(null);

  if (!setup.available || !status) return null;

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      if (mode === 'api-key') await setup.saveConnection({ mode, apiKey });
      else if (mode === 'gateway') await setup.saveConnection({ mode, baseUrl, token });
      setApiKey('');
      setToken('');
      setSaved(true);
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const signInWithAccount = async () => {
    setError('');
    // Signing in with the account means the key and gateway entries have to go, or they would win over it.
    if (status.connection.mode) {
      try {
        await setup.saveConnection({ mode: 'account' });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        return;
      }
    }
    setCommand({ command: 'claude --dangerously-skip-permissions /login', title: t('hemilakeSetup.claude.signInTitle') });
  };

  const modes: { id: Mode; label: string; icon: typeof UserRound }[] = [
    { id: 'account', label: t('hemilakeSetup.claude.modeAccount'), icon: UserRound },
    { id: 'api-key', label: t('hemilakeSetup.claude.modeApiKey'), icon: KeyRound },
    { id: 'gateway', label: t('hemilakeSetup.claude.modeGateway'), icon: Network },
  ];

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-3">
      {!status.claude.installed ? (
        <div className="space-y-2">
          <p className="text-sm text-foreground">{t('hemilakeSetup.claude.notInstalled')}</p>
          <button
            className={primaryButton}
            onClick={() => setCommand({ command: status.claude.installCommand, title: t('hemilakeSetup.claude.installTitle') })}
          >
            <Download className="h-4 w-4" />
            {t('hemilakeSetup.claude.install')}
          </button>
        </div>
      ) : (
        <>
          <div className="text-sm font-medium text-foreground">{t('hemilakeSetup.claude.howTitle')}</div>
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="tablist">
            {modes.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                role="tab"
                aria-selected={mode === id}
                onClick={() => {
                  setMode(id);
                  setError('');
                  setSaved(false);
                }}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                  mode === id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
                {current === id && status.connection.mode && <Check className="h-3 w-3 text-hemi-ok" />}
              </button>
            ))}
          </div>

          {mode === 'account' && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('hemilakeSetup.claude.accountHint')}</p>
              <button className={primaryButton} onClick={() => void signInWithAccount()}>
                {t('hemilakeSetup.claude.signIn')}
              </button>
            </div>
          )}

          {mode === 'api-key' && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('hemilakeSetup.claude.apiKeyHint')}</p>
              <input
                type="password"
                autoComplete="off"
                className={inputClassName}
                placeholder="sk-ant-…"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <button className={primaryButton} disabled={saving || !apiKey.trim()} onClick={() => void save()}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('hemilakeSetup.save')}
              </button>
            </div>
          )}

          {mode === 'gateway' && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('hemilakeSetup.claude.gatewayHint')}</p>
              <input
                type="url"
                className={inputClassName}
                placeholder="https://litellm.example.com"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              <input
                type="password"
                autoComplete="off"
                className={inputClassName}
                placeholder={t('hemilakeSetup.claude.gatewayKey')}
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
              <button className={primaryButton} disabled={saving || !baseUrl.trim() || !token.trim()} onClick={() => void save()}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('hemilakeSetup.save')}
              </button>
            </div>
          )}

          {status.connection.mode === 'gateway' && status.connection.baseUrl && (
            <p className="text-xs text-muted-foreground">{t('hemilakeSetup.claude.usingGateway', { url: status.connection.baseUrl })}</p>
          )}
          {status.connection.mode === 'api-key' && <p className="text-xs text-muted-foreground">{t('hemilakeSetup.claude.usingApiKey')}</p>}
          {saved && <p className="text-xs text-hemi-ok">{t('hemilakeSetup.saved')}</p>}
        </>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {command && (
        <ProviderLoginModal
          isOpen
          provider="claude"
          customCommand={command.command}
          title={command.title}
          onClose={() => {
            setCommand(null);
            void setup.refresh();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}
