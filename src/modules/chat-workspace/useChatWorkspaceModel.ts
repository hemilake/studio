import { useCallback, useEffect, useState } from 'react';

import { subscribeToUserPreferences } from '@/shared/userSettings';
import type { Project } from '@/shared/types';
import {
  fetchDefaultChatWorkspacePath,
  isChatWorkspaceProject,
  readChatWorkspaceEffortPreference,
  readChatWorkspaceModelPreference,
} from '@/modules/chat-workspace/chatWorkspace';

type UseChatWorkspaceModelArgs = {
  selectedProject: Project | null;
  provider: string;
  hasSession: boolean;
};

export type ChatWorkspaceModelState = {
  /** Model a new session should start with, or null when the override does not apply. */
  model: string | null;
  /** Records a manual pick for the current new chat without touching the global default. */
  setModel: (model: string) => void;
  /** Effort a new session should start with, or null when the override does not apply. */
  effort: string | null;
  /** Records a manual effort pick for the current new chat, same scope as `setModel`. */
  setEffort: (effort: string) => void;
};

/**
 * Fork. Used by useChatProviderState: while the chat workspace is selected and
 * no session exists yet, new sessions start with the chat model and effort
 * (Opus at medium by default) instead of the per-provider defaults. Once the
 * first turn is sent the server records both on the session, so the override
 * stops mattering.
 */
export function useChatWorkspaceModel({ selectedProject, provider, hasSession }: UseChatWorkspaceModelArgs): ChatWorkspaceModelState {
  const [preferredModel, setPreferredModel] = useState(readChatWorkspaceModelPreference);
  const [preferredEffort, setPreferredEffort] = useState(readChatWorkspaceEffortPreference);
  const [override, setOverride] = useState<string | null>(null);
  const [effortOverride, setEffortOverride] = useState<string | null>(null);
  // Bumped when the default path resolves so `isChatWorkspaceProject` is re-evaluated.
  const [, setResolvedTick] = useState(0);

  useEffect(() => subscribeToUserPreferences(() => {
    setPreferredModel(readChatWorkspaceModelPreference());
    setPreferredEffort(readChatWorkspaceEffortPreference());
  }), []);

  useEffect(() => {
    let cancelled = false;
    fetchDefaultChatWorkspacePath()
      .then(() => {
        if (!cancelled) setResolvedTick((tick) => tick + 1);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const projectId = selectedProject?.projectId ?? null;
  // A manual pick lives for one new chat: leaving the project or opening a session drops it.
  useEffect(() => {
    setOverride(null);
    setEffortOverride(null);
  }, [projectId, hasSession]);

  const applies = provider === 'claude' && !hasSession && isChatWorkspaceProject(selectedProject);
  const setModel = useCallback((model: string) => setOverride(model), []);
  const setEffort = useCallback((effort: string) => setEffortOverride(effort), []);

  return {
    model: applies ? override ?? preferredModel : null,
    setModel,
    effort: applies ? effortOverride ?? preferredEffort : null,
    setEffort,
  };
}
