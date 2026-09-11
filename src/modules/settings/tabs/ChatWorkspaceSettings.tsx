import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/shared/ui';
import { subscribeToUserPreferences } from '@/shared/userSettings';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import {
  fetchDefaultChatWorkspacePath,
  readChatWorkspacePreference,
  writeChatWorkspacePreference,
} from '@/modules/chat-workspace';

/** Fork. Rendered by AppearanceSettingsTab: lets the user pick the folder the "Chat" shortcut opens. */
export default function ChatWorkspaceSettings() {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState(readChatWorkspacePreference);
  const [defaultPath, setDefaultPath] = useState<string | null>(null);

  useEffect(
    () => subscribeToUserPreferences(() => {
      setDraft(readChatWorkspacePreference());
    }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    fetchDefaultChatWorkspacePath()
      .then((resolved) => {
        if (!cancelled) setDefaultPath(resolved);
      })
      .catch(() => {
        if (!cancelled) setDefaultPath(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = () => {
    writeChatWorkspacePreference(draft);
    setDraft(readChatWorkspacePreference());
  };

  return (
    <SettingsSection title={t('appearanceSettings.chatWorkspace.title')}>
      <SettingsCard>
        <SettingsRow
          label={t('appearanceSettings.chatWorkspace.label')}
          description={
            defaultPath
              ? t('appearanceSettings.chatWorkspace.descriptionWithDefault', { defaultPath })
              : t('appearanceSettings.chatWorkspace.description')
          }
        >
          <Input
            value={draft}
            placeholder={defaultPath ?? ''}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
            }}
            className="w-full font-mono text-xs sm:w-64"
            aria-label={t('appearanceSettings.chatWorkspace.label')}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
