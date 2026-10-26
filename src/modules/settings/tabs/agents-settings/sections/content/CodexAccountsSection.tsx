import { ArrowDown, ArrowUp, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ProviderLoginModal } from '@/modules/provider-auth';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { authenticatedFetch } from '@/shared/api';
import { Badge, Button, Input } from '@/shared/ui';
import { cn } from '@/shared/utils';

/*
 * Fork (Hemilake Studio): multi-account Codex. Lists the Codex accounts with
 * their plan usage, adds and signs in new ones, and sets how new sessions are
 * spread across them. The server side lives in
 * server/modules/providers/list/codex/accounts.
 */

type UsageWindow = { usedPercent: number; windowDurationMins: number; resetsAt: number | null };

type AccountUsage = {
  fetchedAt: number;
  signedIn: boolean;
  email: string | null;
  planType: string | null;
  windows: UsageWindow[];
  reachedType: string | null;
  error: string | null;
  exhaustedUntil: number | null;
};

type CodexAccount = {
  id: string;
  label: string;
  enabled: boolean;
  isPrimary: boolean;
  sessions: number;
  usage: AccountUsage | null;
  remainingPercent: number | null;
};

type AccountsView = {
  mode: 'round_robin' | 'backup';
  primaryAccountId: string;
  minHeadroomPercent: number;
  accounts: CodexAccount[];
};

const API = '/api/providers/codex/accounts';
const POLL_MS = 60_000;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, init as never);
  const payload = await response.json().catch(() => null) as { success?: boolean; data?: T; error?: { message?: string } } | null;
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error?.message || `Request failed (${response.status})`);
  }
  return payload.data as T;
}

function windowName(minutes: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (minutes >= 10_080 && minutes % 10_080 === 0) return t('agents.codexAccounts.window.week', { defaultValue: 'Week' });
  if (minutes >= 1_440 && minutes % 1_440 === 0) return t('agents.codexAccounts.window.days', { count: minutes / 1_440, defaultValue: '{{count}} d' });
  if (minutes >= 60) return t('agents.codexAccounts.window.hours', { count: Math.round(minutes / 60), defaultValue: '{{count}} h' });
  return `${minutes} min`;
}

function resetIn(resetsAt: number | null, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (!resetsAt) return '';
  const minutes = Math.max(0, Math.round((resetsAt - Date.now()) / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const span = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  return t('agents.codexAccounts.resetsIn', { span, defaultValue: 'resets in {{span}}' });
}

function barColor(percent: number): string {
  if (percent >= 90) return 'bg-destructive';
  if (percent >= 70) return 'bg-hemi-copper';
  return 'bg-hemi-ok';
}

/** Rendered by AccountContent for Codex. */
export default function CodexAccountsSection() {
  const { t } = useTranslation('settings');
  const [view, setView] = useState<AccountsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [login, setLogin] = useState<{ command: string; label: string } | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (refresh = false) => {
    try {
      const data = await request<AccountsView>(`${API}${refresh ? '?refresh=1' : ''}`);
      if (mounted.current) {
        setView(data);
        setError(null);
      }
    } catch (loadError) {
      if (mounted.current) setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  const run = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(null);
    }
  }, [load]);

  const saveSettings = (body: Record<string, unknown>) => run('settings', () =>
    request(`${API}/settings`, { method: 'PUT', body: JSON.stringify(body) }));

  const addAccount = () => run('add', async () => {
    const label = newLabel.trim();
    if (!label) return;
    const result = await request<{ account: { label: string }; loginCommand: string }>(API, {
      method: 'POST',
      body: JSON.stringify({ label }),
    });
    setNewLabel('');
    setAdding(false);
    setLogin({ command: result.loginCommand, label: result.account.label });
  });

  const signIn = (account: CodexAccount) => run(`login-${account.id}`, async () => {
    const result = await request<{ loginCommand: string }>(`${API}/${account.id}/login-command`);
    setLogin({ command: result.loginCommand, label: account.label });
  });

  const move = (index: number, offset: number) => {
    if (!view) return;
    const order = view.accounts.map((account) => account.id);
    const target = index + offset;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    void saveSettings({ order });
  };

  const remove = (account: CodexAccount) => {
    const confirmed = window.confirm(t('agents.codexAccounts.confirmRemove', {
      label: account.label,
      defaultValue: 'Remove the Codex account "{{label}}"? Its login is deleted; sessions stay.',
    }));
    if (confirmed) {
      void run(`remove-${account.id}`, () => request(`${API}/${account.id}`, { method: 'DELETE' }));
    }
  };

  const backup = view?.mode === 'backup';

  return (
    <div className="rounded-[10px] border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium text-foreground">{t('agents.codexAccounts.title', { defaultValue: 'Codex accounts' })}</div>
          <div className="text-sm text-muted-foreground">
            {t('agents.codexAccounts.description', {
              defaultValue: 'Each session sticks to one account and moves to another only when it runs out.',
            })}
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void run('refresh', () => load(true))} disabled={busy !== null}>
            <RefreshCw className={cn('h-4 w-4', busy === 'refresh' && 'animate-spin')} />
            {t('agents.codexAccounts.refresh', { defaultValue: 'Refresh' })}
          </Button>
          <Button size="sm" onClick={() => setAdding((value) => !value)}>
            <Plus className="h-4 w-4" />
            {t('agents.codexAccounts.add', { defaultValue: 'Add account' })}
          </Button>
        </div>
      </div>

      {adding && (
        <form
          className="mb-4 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void addAccount();
          }}
        >
          <Input
            autoFocus
            value={newLabel}
            onChange={(event) => setNewLabel(event.target.value)}
            placeholder={t('agents.codexAccounts.labelPlaceholder', { defaultValue: 'Name, e.g. Work' })}
            className="min-w-0 flex-1"
            maxLength={80}
          />
          <Button size="sm" type="submit" disabled={!newLabel.trim() || busy === 'add'}>
            {t('agents.codexAccounts.addAndSignIn', { defaultValue: 'Add and sign in' })}
          </Button>
        </form>
      )}

      {view && (
        <div className="mb-4 space-y-3 border-b border-border/50 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{t('agents.codexAccounts.mode', { defaultValue: 'New sessions' })}</span>
            <div className="inline-flex rounded-md border border-border p-0.5" role="radiogroup">
              {(['backup', 'round_robin'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={view.mode === mode}
                  onClick={() => view.mode !== mode && void saveSettings({ mode })}
                  className={cn(
                    'rounded px-3 py-1 text-sm transition-colors',
                    view.mode === mode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {mode === 'backup'
                    ? t('agents.codexAccounts.modeBackup', { defaultValue: 'Primary + backups' })
                    : t('agents.codexAccounts.modeRoundRobin', { defaultValue: 'Round robin' })}
                </button>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {backup
              ? t('agents.codexAccounts.modeBackupHelp', { defaultValue: 'Always the primary; the others in list order when it runs out.' })
              : t('agents.codexAccounts.modeRoundRobinHelp', { defaultValue: 'Each new session goes to the next account with room, in list order.' })}
          </p>
          <label className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            {t('agents.codexAccounts.minHeadroom', { defaultValue: 'Minimum room before a turn' })}
            <Input
              type="number"
              min={0}
              max={100}
              defaultValue={view.minHeadroomPercent}
              key={view.minHeadroomPercent}
              className="h-8 w-20"
              onBlur={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value !== view.minHeadroomPercent) void saveSettings({ minHeadroomPercent: value });
              }}
            />
            %
          </label>
          <p className="text-xs text-muted-foreground">
            {t('agents.codexAccounts.minHeadroomHelp', {
              defaultValue: 'Percent of a Plus-sized window; ×2 for high effort, ×3 for xhigh. Bigger plans count their room bigger (Pro ×6).',
            })}
          </p>
        </div>
      )}

      {error && <div className="mb-3 text-sm text-destructive">{error}</div>}
      {!view && !error && <div className="text-sm text-muted-foreground">{t('agents.authStatus.checking')}</div>}

      <ul className="space-y-3">
        {view?.accounts.map((account, index) => {
          const usage = account.usage;
          const signedOut = usage?.signedIn === false;
          const exhausted = account.remainingPercent === 0;
          return (
            <li key={account.id} className={cn('rounded-md border border-border p-3', !account.enabled && 'opacity-60')}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  {renaming?.id === account.id ? (
                    <form
                      className="flex gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const label = renaming.label.trim();
                        setRenaming(null);
                        if (label && label !== account.label) {
                          void run(`rename-${account.id}`, () => request(`${API}/${account.id}`, { method: 'PATCH', body: JSON.stringify({ label }) }));
                        }
                      }}
                    >
                      <Input autoFocus value={renaming.label} maxLength={80} className="h-8" onChange={(event) => setRenaming({ id: account.id, label: event.target.value })} />
                      <Button size="sm" type="submit">OK</Button>
                    </form>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{account.label}</span>
                      {backup && account.isPrimary && (
                        <Badge variant="secondary" className="bg-hemi-copper-tint text-hemi-copper-text hover:bg-hemi-copper-tint">
                          {t('agents.codexAccounts.primary', { defaultValue: 'Primary' })}
                        </Badge>
                      )}
                      {usage?.planType && <Badge variant="outline">{usage.planType}</Badge>}
                      {exhausted && account.enabled && !signedOut && (
                        <Badge variant="destructive">{t('agents.codexAccounts.limitReached', { defaultValue: 'Limit reached' })}</Badge>
                      )}
                    </div>
                  )}
                  <div className="truncate text-sm text-muted-foreground">
                    {signedOut
                      ? t('agents.codexAccounts.notSignedIn', { defaultValue: 'Not signed in' })
                      : usage?.email || (usage ? '' : t('agents.authStatus.checking'))}
                    {account.sessions > 0 && (
                      <span>{' · '}{t('agents.codexAccounts.sessions', { count: account.sessions, defaultValue: '{{count}} sessions' })}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t('agents.codexAccounts.moveUp', { defaultValue: 'Move up' })} disabled={index === 0 || busy !== null} onClick={() => move(index, -1)}>
                    <ArrowUp />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t('agents.codexAccounts.moveDown', { defaultValue: 'Move down' })} disabled={index === view.accounts.length - 1 || busy !== null} onClick={() => move(index, 1)}>
                    <ArrowDown />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t('agents.codexAccounts.rename', { defaultValue: 'Rename' })} onClick={() => setRenaming({ id: account.id, label: account.label })}>
                    <Pencil />
                  </Button>
                  {account.id !== 'default' && (
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" aria-label={t('agents.codexAccounts.remove', { defaultValue: 'Remove' })} disabled={busy !== null} onClick={() => remove(account)}>
                      <Trash2 />
                    </Button>
                  )}
                  <SettingsToggle
                    checked={account.enabled}
                    ariaLabel={t('agents.codexAccounts.enabled', { defaultValue: 'Use this account' })}
                    disabled={busy !== null}
                    onChange={(enabled) => void run(`toggle-${account.id}`, () => request(`${API}/${account.id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }))}
                  />
                </div>
              </div>

              {usage && usage.windows.length > 0 && (
                <div className="mt-3 space-y-2">
                  {usage.windows.map((window, windowIndex) => (
                    <div key={windowIndex}>
                      <div className="mb-1 flex justify-between gap-2 text-xs text-muted-foreground">
                        <span>{windowName(window.windowDurationMins, t)}</span>
                        <span>{Math.round(window.usedPercent)}% · {resetIn(window.resetsAt, t)}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className={cn('h-full rounded-full', barColor(window.usedPercent))} style={{ width: `${Math.min(100, window.usedPercent)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {usage?.error && !signedOut && <div className="mt-2 text-xs text-destructive">{usage.error}</div>}

              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant={signedOut ? 'default' : 'outline'} disabled={busy !== null} onClick={() => void signIn(account)}>
                  {signedOut
                    ? t('agents.login.button')
                    : t('agents.login.reLoginButton')}
                </Button>
                {backup && !account.isPrimary && (
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void saveSettings({ primaryAccountId: account.id })}>
                    {t('agents.codexAccounts.makePrimary', { defaultValue: 'Make primary' })}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <ProviderLoginModal
        isOpen={login !== null}
        provider="codex"
        customCommand={login?.command}
        onClose={() => {
          setLogin(null);
          void load(true);
        }}
        onComplete={() => void load(true)}
      />
    </div>
  );
}
