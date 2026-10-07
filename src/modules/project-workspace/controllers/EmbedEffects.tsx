import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

import { useOpenChat } from '@/modules/chat-workspace';
import {
  useProjectMainState,
  useProjectSidebarState,
} from '@/modules/project-workspace/context/ProjectsStateContext';
import { api } from '@/shared/api';
import { readDraftText, writeDraftText } from '@/shared/chatDrafts';
import { useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import { APP_VERSION } from '@/shared/constants';
import { getEmbedMode, onConsoleMessage, postToConsole } from '@/shared/embedBridge';
import type {
  EmbedSessionSummary,
  Project,
  ProjectSession,
  ProjectWorkspaceShellProps,
  RecentConversationListItem,
} from '@/shared/types';
import { getSessionTitle } from '@/shared/utils';

const COMPOSER_SELECTOR = 'textarea[data-slot="prompt-input-textarea"]';
const PREFILL_STORAGE_PREFIX = 'studio-embed-prefill:';

/**
 * The composer text for a console prefill. A draft that is exactly the previous
 * prefill was abandoned and is replaced; anything the owner typed is kept and
 * the new prompt goes after it. The last prefill per scope is remembered for the
 * tab, because the console builds a new frame each time it opens the quick panel.
 */
function prefilledDraft(scope: string, prompt: string): string {
  const existing = readDraftText(scope).trim();
  let lastPrefill: string | null = null;
  try {
    lastPrefill = sessionStorage.getItem(PREFILL_STORAGE_PREFIX + scope);
    sessionStorage.setItem(PREFILL_STORAGE_PREFIX + scope, prompt);
  } catch {
    // Without storage an abandoned prefill is kept, like typed text.
  }
  if (!existing || existing === lastPrefill?.trim()) {
    return prompt;
  }
  return `${existing}\n\n${prompt}`;
}

/** A conversation the console asked for that has not been sent yet, so it has no session id. */
type PendingNewConversation = {
  requestId: string;
  projectId: string;
  requestedAt: number;
};

function findSession(projects: readonly Project[], sessionId: string): { session: ProjectSession; project: Project } | null {
  for (const project of projects) {
    const session = project.sessions?.find((candidate) => candidate.id === sessionId);
    if (session) {
      return { session, project };
    }
  }
  return null;
}

function summarize(session: ProjectSession, project: Project | null, providerSessionId: string | null): EmbedSessionSummary {
  return {
    id: session.id,
    title: getSessionTitle(session),
    provider: session.__provider ?? session.provider ?? null,
    projectId: project?.projectId ?? null,
    projectPath: project?.fullPath ?? null,
    providerSessionId,
  };
}

function sessionCreatedAt(session: ProjectSession): number | null {
  const raw = session.createdAt ?? session.created_at;
  const parsed = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Focuses the chat composer, waiting a few frames for it to mount after a navigation. */
function focusComposer(attemptsLeft = 10): void {
  const composer = document.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR);
  if (composer) {
    composer.focus();
    composer.setSelectionRange(composer.value.length, composer.value.length);
    return;
  }
  if (attemptsLeft > 0) {
    window.requestAnimationFrame(() => focusComposer(attemptsLeft - 1));
  }
}

/**
 * Headless controller rendered by ProjectWorkspaceShell when Studio is embedded
 * in a Hemilake console (docs/fork/embed.md): it reports the route, the open
 * conversation, the running and unread counts and finished or blocked runs,
 * and carries out what the console asks. A conversation the console starts is
 * only prefilled: the owner reads it and sends it.
 */
export default function EmbedEffects({ navigate }: Pick<ProjectWorkspaceShellProps, 'navigate'>) {
  const location = useLocation();
  const { sidebarSharedProps } = useProjectSidebarState();
  const { selectedProject, selectedSession, refreshProjectsSilently } = useProjectMainState();
  const { projects, attentionSessionIds, onNewSession } = sidebarSharedProps;
  const busySessionIds = useBusySessionIdSet();
  const { subscribe } = useWebSocket();

  // Latest values for the console listener, which is subscribed once.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const busyRef = useRef(busySessionIds);
  busyRef.current = busySessionIds;
  // Provider session ids already looked up; they never change once assigned.
  const providerIdsRef = useRef(new Map<string, string>());
  // The console's request waiting for its first message to become a session.
  const pendingNewRef = useRef<PendingNewConversation | null>(null);
  // The prompt to prefill once the chat workspace has been resolved.
  const pendingPromptRef = useRef<{ requestId: string; prompt: string } | null>(null);
  const previousSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  const previousBusyRef = useRef<ReadonlySet<string>>(busySessionIds);

  const startPrefilledConversation = useCallback((project: Project) => {
    const pending = pendingPromptRef.current;
    pendingPromptRef.current = null;
    if (pending?.prompt) {
      const scope = `project:${project.projectId}`;
      writeDraftText(scope, prefilledDraft(scope, pending.prompt));
    }
    if (pending) {
      pendingNewRef.current = { requestId: pending.requestId, projectId: project.projectId, requestedAt: Date.now() };
    }
    onNewSession(project);
    focusComposer();
  }, [onNewSession]);

  const { openChat, error: openChatError } = useOpenChat({
    projects,
    onNewSession: startPrefilledConversation,
    refreshProjects: refreshProjectsSilently,
  });

  // The chat workspace could not be resolved or created: tell the console
  // instead of leaving its request hanging.
  useEffect(() => {
    const pending = pendingPromptRef.current;
    if (!openChatError || !pending) {
      return;
    }
    pendingPromptRef.current = null;
    postToConsole({ v: 1, type: 'new.failed', requestId: pending.requestId, code: 'workspace_failed' });
  }, [openChatError]);

  useEffect(() => {
    postToConsole({ v: 1, type: 'studio.ready', version: APP_VERSION, embed: getEmbedMode() ?? 'full', signedIn: true });
  }, []);

  // route: the path inside Studio and the tab title, which Studio keeps current.
  useEffect(() => {
    const report = () => postToConsole({ v: 1, type: 'route', path: location.pathname, title: document.title });
    report();
    const titleElement = document.querySelector('title');
    if (!titleElement) {
      return undefined;
    }
    const observer = new MutationObserver(report);
    observer.observe(titleElement, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [location.pathname]);

  // session: the open conversation, with the provider's id once it exists, so
  // the console can find the conversation's saga in the lake.
  const selectedSessionId = selectedSession?.id ?? null;
  const selectedActivity = selectedSession?.lastActivity ?? selectedSession?.updated_at ?? null;
  useEffect(() => {
    let cancelled = false;
    const previousSessionId = previousSessionIdRef.current;
    previousSessionIdRef.current = selectedSessionId;

    if (!selectedSession) {
      postToConsole({ v: 1, type: 'session', session: null, projectPath: selectedProject?.fullPath ?? null });
      return undefined;
    }

    const session = selectedSession;
    const publish = (providerSessionId: string | null) => {
      if (cancelled) {
        return;
      }
      const summary = summarize(session, selectedProject, providerSessionId);
      postToConsole({ v: 1, type: 'session', session: summary, projectPath: summary.projectPath });

      // The console's new conversation became a session with its first message.
      const pending = pendingNewRef.current;
      const createdAt = sessionCreatedAt(session);
      if (
        pending
        && previousSessionId === null
        && summary.projectId === pending.projectId
        && (createdAt === null || createdAt >= pending.requestedAt - 5_000)
      ) {
        pendingNewRef.current = null;
        postToConsole({ v: 1, type: 'session.created', requestId: pending.requestId, session: summary });
      }
    };

    const known = providerIdsRef.current.get(session.id);
    if (known) {
      publish(known);
      return () => {
        cancelled = true;
      };
    }

    void api.providerSessionId(session.id)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { data?: { sessionId?: unknown } } | null) => {
        const providerSessionId = typeof payload?.data?.sessionId === 'string' && payload.data.sessionId
          ? payload.data.sessionId
          : null;
        if (providerSessionId) {
          providerIdsRef.current.set(session.id, providerSessionId);
        }
        publish(providerSessionId);
      })
      .catch(() => publish(null));

    return () => {
      cancelled = true;
    };
    // selectedActivity re-asks for the provider id after the first reply assigns it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, selectedActivity, selectedProject?.projectId]);

  // counts: the console's badge on its Studio entry.
  useEffect(() => {
    postToConsole({ v: 1, type: 'counts', running: busySessionIds.size, attention: attentionSessionIds.size });
  }, [attentionSessionIds, busySessionIds]);

  // notify done: a run that was producing a reply has stopped.
  useEffect(() => {
    const previous = previousBusyRef.current;
    previousBusyRef.current = busySessionIds;
    for (const sessionId of previous) {
      if (!busySessionIds.has(sessionId)) {
        const found = findSession(projectsRef.current, sessionId);
        postToConsole({
          v: 1,
          type: 'notify',
          kind: 'done',
          sessionId,
          title: found ? getSessionTitle(found.session) : '',
        });
      }
    }
  }, [busySessionIds]);

  // notify input: a run is waiting for a permission decision.
  useEffect(() => subscribe((event) => {
    if (event.kind !== 'permission_request' || typeof event.sessionId !== 'string' || !event.sessionId) {
      return;
    }
    const found = findSession(projectsRef.current, event.sessionId);
    postToConsole({
      v: 1,
      type: 'notify',
      kind: 'input',
      sessionId: event.sessionId,
      title: found ? getSessionTitle(found.session) : '',
    });
  }), [subscribe]);

  // What the console asks for.
  useEffect(() => onConsoleMessage((message) => {
    switch (message.type) {
      case 'navigate':
        navigate(message.path);
        return;
      case 'focus':
        focusComposer();
        return;
      case 'new': {
        pendingPromptRef.current = { requestId: message.requestId, prompt: message.prompt };
        if (!message.projectPath) {
          // No project named: the chat workspace, as the Chat shortcut does.
          openChat();
          return;
        }
        const project = projectsRef.current.find(
          (candidate) => candidate.fullPath === message.projectPath || candidate.path === message.projectPath,
        );
        if (!project) {
          // The console may only pick among projects Studio already has.
          pendingPromptRef.current = null;
          postToConsole({ v: 1, type: 'new.failed', requestId: message.requestId, code: 'no_project' });
          return;
        }
        startPrefilledConversation(project);
        return;
      }
      case 'recent.request':
        void api.recentConversations({ limit: message.limit, origin: 'app' })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload: { data?: { conversations?: RecentConversationListItem[] } } | null) => {
            const conversations = Array.isArray(payload?.data?.conversations) ? payload.data.conversations : [];
            postToConsole({
              v: 1,
              type: 'recent',
              requestId: message.requestId,
              items: conversations.map((conversation) => ({
                id: conversation.sessionId,
                title: conversation.sessionTitle,
                provider: conversation.provider,
                projectId: conversation.projectId,
                lastActivity: conversation.lastActivity,
                running: busyRef.current.has(conversation.sessionId),
              })),
            });
          })
          .catch(() => {
            postToConsole({ v: 1, type: 'recent', requestId: message.requestId, items: [] });
          });
        return;
      default:
        // auth and theme are handled by the auth module and the theme context.
        return;
    }
  }), [navigate, openChat, startPrefilledConversation]);

  return null;
}
