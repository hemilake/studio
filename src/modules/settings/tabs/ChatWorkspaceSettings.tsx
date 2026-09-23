import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { Input } from '@/shared/ui';
import { subscribeToUserPreferences } from '@/shared/userSettings';
import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/types';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import {
  fetchDefaultChatWorkspacePath,
  readChatWorkspaceEffortPreference,
  readChatWorkspaceModelPreference,
  readChatWorkspacePreference,
  writeChatWorkspaceEffortPreference,
  writeChatWorkspaceModelPreference,
  writeChatWorkspacePreference,
} from '@/modules/chat-workspace';

const SELECT_CLASS_NAME =
  'w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-64';

// Shown while the catalogue is loading or when the chosen model is not in it.
const FALLBACK_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Fork. Rendered by AppearanceSettingsTab: the folder, the default model and the default effort the "Chat" shortcut uses. */
export default function ChatWorkspaceSettings() {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState(readChatWorkspacePreference);
  const [model, setModel] = useState(readChatWorkspaceModelPreference);
  const [effort, setEffort] = useState(readChatWorkspaceEffortPreference);
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ProviderModelOption[] | null>(null);

  useEffect(
    () => subscribeToUserPreferences(() => {
      setDraft(readChatWorkspacePreference());
      setModel(readChatWorkspaceModelPreference());
      setEffort(readChatWorkspaceEffortPreference());
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
    api.providers.models('claude')
      .then((response) => readApiJson<{ data?: { models?: ProviderModelsDefinition } }>(response))
      .then((body) => {
        if (!cancelled) setModelOptions(body.data?.models?.OPTIONS ?? []);
      })
      .catch(() => {
        if (!cancelled) setModelOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const commitPath = () => {
    writeChatWorkspacePreference(draft);
    setDraft(readChatWorkspacePreference());
  };

  // The stored value is kept selectable even if the catalogue does not list it
  // (a custom model removed later, or the catalogue request failing).
  const options = modelOptions ?? [];
  const hasCurrent = options.some((option) => option.value === model);
  // Effort levels follow the chosen model; `default` leaves the choice to the model.
  const effortValues = options.find((option) => option.value === model)?.effort?.values.map((value) => value.value)
    ?? FALLBACK_EFFORT_VALUES;
  const hasCurrentEffort = effort === DEFAULT_EFFORT_VALUE || effortValues.includes(effort);

  return (
    <SettingsSection title={t('appearanceSettings.chatWorkspace.title')}>
      <SettingsCard divided>
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
            onBlur={commitPath}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
            }}
            className="w-full font-mono text-xs sm:w-64"
            aria-label={t('appearanceSettings.chatWorkspace.label')}
          />
        </SettingsRow>

        <SettingsRow
          label={t('appearanceSettings.chatWorkspace.modelLabel')}
          description={t('appearanceSettings.chatWorkspace.modelDescription')}
        >
          <select
            value={model}
            disabled={modelOptions === null}
            onChange={(event) => {
              writeChatWorkspaceModelPreference(event.target.value);
              setModel(readChatWorkspaceModelPreference());
            }}
            className={SELECT_CLASS_NAME}
            aria-label={t('appearanceSettings.chatWorkspace.modelLabel')}
          >
            {modelOptions === null && <option value={model}>{t('appearanceSettings.chatWorkspace.modelLoading')}</option>}
            {!hasCurrent && modelOptions !== null && <option value={model}>{model}</option>}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </SettingsRow>

        <SettingsRow
          label={t('appearanceSettings.chatWorkspace.effortLabel')}
          description={t('appearanceSettings.chatWorkspace.effortDescription')}
        >
          <select
            value={effort}
            onChange={(event) => {
              writeChatWorkspaceEffortPreference(event.target.value);
              setEffort(readChatWorkspaceEffortPreference());
            }}
            className={SELECT_CLASS_NAME}
            aria-label={t('appearanceSettings.chatWorkspace.effortLabel')}
          >
            <option value={DEFAULT_EFFORT_VALUE}>{t('appearanceSettings.chatWorkspace.effortModelDefault')}</option>
            {!hasCurrentEffort && <option value={effort}>{effort}</option>}
            {effortValues.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
