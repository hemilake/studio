import { useCallback, useEffect, useRef, useState } from 'react';

import type { Project } from '@/shared/types';
import { ensureChatProject, resolveChatWorkspacePath } from '@/modules/chat-workspace/chatWorkspace';

type UseOpenChatOptions = {
  projects: readonly Project[];
  onNewSession: (project: Project) => void;
  refreshProjects: () => Promise<void> | void;
};

export type OpenChatState = {
  openChat: () => void;
  isOpening: boolean;
  error: string | null;
};

/**
 * Resolves the chat workspace (creating it on first use) and starts a new
 * session in it. Used by the sidebar shortcut and, through the palette ops
 * registry, by the command palette and the keyboard shortcut.
 */
export function useOpenChat({ projects, onNewSession, refreshProjects }: UseOpenChatOptions): OpenChatState {
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Refs keep `openChat` stable while the project list refreshes every few seconds.
  const projectsRef = useRef(projects);
  const onNewSessionRef = useRef(onNewSession);
  const refreshProjectsRef = useRef(refreshProjects);
  const inFlightRef = useRef(false);

  useEffect(() => {
    projectsRef.current = projects;
    onNewSessionRef.current = onNewSession;
    refreshProjectsRef.current = refreshProjects;
  }, [projects, onNewSession, refreshProjects]);

  const openChat = useCallback(() => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setIsOpening(true);
    setError(null);

    void (async () => {
      try {
        const targetPath = await resolveChatWorkspacePath();
        const known = projectsRef.current;
        const project = await ensureChatProject(targetPath, known);
        if (!known.some((candidate) => candidate.projectId === project.projectId)) {
          void refreshProjectsRef.current();
        }
        onNewSessionRef.current(project);
      } catch (caught) {
        console.error('Failed to open the chat workspace', caught);
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        inFlightRef.current = false;
        setIsOpening(false);
      }
    })();
  }, []);

  return { openChat, isOpening, error };
}

const isMacLike = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const OPEN_CHAT_SHORTCUT_LABEL = `${isMacLike ? '⌘' : 'Ctrl'}+Shift+O`;

/** Ctrl/Cmd+Shift+O opens a chat from anywhere in the app. */
export function useOpenChatShortcut(openChat: () => void): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'o') return;
      event.preventDefault();
      openChat();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openChat]);
}
