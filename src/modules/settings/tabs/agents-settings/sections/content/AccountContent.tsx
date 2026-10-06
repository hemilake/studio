import { LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, Button, LLMProviderLogo } from '@/shared/ui';
import type { AgentProvider, ProviderAuthStatus } from '@/shared/types';

type AccountContentProps = {
  agent: AgentProvider;
  authStatus: ProviderAuthStatus;
  onLogin: () => void;
};

type AgentVisualConfig = {
  name: string;
  description?: string;
};

// Fork (Hemilake Studio): every agent gets the same plain card; only its own logo keeps its colours.
const agentConfig: Record<AgentProvider, AgentVisualConfig> = {
  claude: { name: 'Claude' },
  cursor: { name: 'Cursor' },
  codex: { name: 'Codex' },
  opencode: { name: 'OpenCode', description: 'OpenCode CLI assistant' },
  antigravity: { name: 'Antigravity', description: 'Antigravity CLI assistant' },
};

/** The server reports token auth as the literal email 'Auth Token'; say it in words. */
const AUTH_TOKEN_EMAIL = 'Auth Token';

/** Rendered by AgentCategoryContentSection for the "account" category to show sign-in state for one provider. */
export default function AccountContent({ agent, authStatus, onLogin }: AccountContentProps) {
  const { t } = useTranslation('settings');
  const config = agentConfig[agent];

  return (
    <div className="space-y-6">
      <div className="mb-4 flex items-center gap-3">
        <LLMProviderLogo provider={agent} className="h-6 w-6" />
        <div>
          <h3 className="text-lg font-medium text-foreground">{config.name}</h3>
          <p className="text-sm text-muted-foreground">
            {t(`agents.account.${agent}.description`, {
              defaultValue: config.description || `${config.name} CLI assistant`,
            })}
          </p>
        </div>
      </div>

      <div className="rounded-[10px] border border-border bg-card p-4">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="font-medium text-foreground">
                {t('agents.connectionStatus')}
              </div>
              <div className="text-sm text-muted-foreground">
                {authStatus.loading ? (
                  t('agents.authStatus.checkingAuth')
                ) : authStatus.authenticated && authStatus.email === AUTH_TOKEN_EMAIL ? (
                  t('agents.authStatus.signedInWithToken', { defaultValue: 'Signed in with an auth token' })
                ) : authStatus.authenticated ? (
                  t('agents.authStatus.loggedInAs', {
                    email: authStatus.email || t('agents.authStatus.authenticatedUser'),
                  })
                ) : (
                  t('agents.authStatus.notConnected')
                )}
              </div>
            </div>
            <div>
              {authStatus.loading ? (
                <Badge variant="secondary" className="bg-muted">
                  {t('agents.authStatus.checking')}
                </Badge>
              ) : authStatus.authenticated ? (
                <Badge variant="secondary" className="gap-1.5 rounded-full bg-hemi-ok-tint text-hemi-ok hover:bg-hemi-ok-tint">
                  <span className="h-1.5 w-1.5 rounded-full bg-hemi-ok" aria-hidden />
                  {t('agents.authStatus.connected')}
                </Badge>
              ) : (
                <Badge variant="secondary" className="rounded-full">
                  {t('agents.authStatus.disconnected')}
                </Badge>
              )}
            </div>
          </div>

          {authStatus.method !== 'api_key' && (
            <div className="border-t border-border/50 pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-foreground">
                    {authStatus.authenticated ? t('agents.login.reAuthenticate') : t('agents.login.title')}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {authStatus.authenticated
                      ? t('agents.login.reAuthDescription')
                      : t('agents.login.description', { agent: config.name })}
                  </div>
                </div>
                <Button
                  onClick={onLogin}
                  size="sm"
                >
                  <LogIn className="mr-2 h-4 w-4" />
                  {authStatus.authenticated ? t('agents.login.reLoginButton') : t('agents.login.button')}
                </Button>
              </div>
            </div>
          )}

          {authStatus.error && (
            <div className="border-t border-border/50 pt-4">
              <div className="text-sm text-destructive">
                {t('agents.error', { error: authStatus.error })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
