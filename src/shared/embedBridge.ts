import { api } from '@/shared/api';
import { getStoredAuthToken } from '@/shared/authToken';
import { APP_VERSION } from '@/shared/constants';
import type { ConsoleToStudioMessage, EmbedMode, StudioToConsoleMessage } from '@/shared/types';

/**
 * Fork (embed mode): Studio's side of the postMessage contract with a framing
 * Hemilake console (docs/fork/embed.md).
 *
 * Studio is embedded when it runs in a frame and was opened with `?embed=full`
 * or `?embed=compact`; the mode is kept in sessionStorage so in-app navigation,
 * which drops the query string, keeps it. Messages are only accepted from the
 * parent window and only from an origin the server lists in
 * CLOUDCLI_EMBED_ORIGINS; until that list has loaded nothing is accepted and
 * outgoing messages wait.
 */

const EMBED_MODE_STORAGE_KEY = 'studio-embed-mode';
const MAX_ASSERTION_LENGTH = 8_192;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_REQUEST_ID_LENGTH = 128;
const SESSION_PATH = /^\/(?:session\/[A-Za-z0-9._:-]{1,200})?$/;

const isEmbedMode = (value: unknown): value is EmbedMode => value === 'full' || value === 'compact';

/** The embed mode of a window: none unless it is framed and asked for one now or earlier in this tab. */
export function detectEmbedMode(win: Window): EmbedMode | null {
  if (win.parent === win) {
    return null;
  }

  const requested = new URLSearchParams(win.location.search).get('embed');
  if (isEmbedMode(requested)) {
    try {
      win.sessionStorage.setItem(EMBED_MODE_STORAGE_KEY, requested);
    } catch {
      // Without storage the mode lasts until the first in-app navigation.
    }
    return requested;
  }

  try {
    const stored = win.sessionStorage.getItem(EMBED_MODE_STORAGE_KEY);
    return isEmbedMode(stored) ? stored : null;
  } catch {
    return null;
  }
}

const embedMode: EmbedMode | null = typeof window === 'undefined' ? null : detectEmbedMode(window);

/** The mode Studio runs in inside a Hemilake console, or null when it is not embedded. Fixed for the page's life. */
export function getEmbedMode(): EmbedMode | null {
  return embedMode;
}

const asRequestId = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH ? value : null
);

/** A console message checked field by field, or null for anything off-contract. */
export function parseConsoleMessage(data: unknown): ConsoleToStudioMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const message = data as Record<string, unknown>;
  if (message.v !== 1 || typeof message.type !== 'string') {
    return null;
  }

  switch (message.type) {
    case 'auth':
      return typeof message.assertion === 'string' && message.assertion.length <= MAX_ASSERTION_LENGTH
        ? { v: 1, type: 'auth', assertion: message.assertion }
        : null;
    case 'theme':
      return message.mode === 'light' || message.mode === 'dark'
        ? { v: 1, type: 'theme', mode: message.mode }
        : null;
    case 'navigate':
      return typeof message.path === 'string' && SESSION_PATH.test(message.path)
        ? { v: 1, type: 'navigate', path: message.path }
        : null;
    case 'new': {
      const requestId = asRequestId(message.requestId);
      const prompt = message.prompt === undefined ? '' : message.prompt;
      const projectPath = message.projectPath === undefined ? null : message.projectPath;
      if (!requestId || typeof prompt !== 'string' || prompt.length > MAX_PROMPT_LENGTH) {
        return null;
      }
      if (projectPath !== null && typeof projectPath !== 'string') {
        return null;
      }
      return { v: 1, type: 'new', requestId, prompt, projectPath };
    }
    case 'focus':
      return { v: 1, type: 'focus' };
    case 'recent.request': {
      const requestId = asRequestId(message.requestId);
      const limit = typeof message.limit === 'number' && Number.isFinite(message.limit)
        ? Math.min(50, Math.max(1, Math.floor(message.limit)))
        : 20;
      return requestId ? { v: 1, type: 'recent.request', requestId, limit } : null;
    }
    default:
      return null;
  }
}

type ConsoleListener = (message: ConsoleToStudioMessage) => void;

const listeners = new Set<ConsoleListener>();
let allowedOrigins: string[] | null = null;
let consoleOrigin: string | null = null;
let exchangeAvailable = false;
let startPromise: Promise<void> | null = null;
const outbox: StudioToConsoleMessage[] = [];

function deliver(message: StudioToConsoleMessage): void {
  if (!allowedOrigins) {
    outbox.push(message);
    return;
  }
  // Before the console has spoken its origin is unknown: address every allowed
  // origin, and the browser drops the copies whose origin does not match.
  const targets = consoleOrigin ? [consoleOrigin] : allowedOrigins;
  for (const origin of targets) {
    window.parent.postMessage(message, origin);
  }
}

/** Posts one message to the framing console; a no-op when Studio is not embedded. */
export function postToConsole(message: StudioToConsoleMessage): void {
  if (!embedMode) {
    return;
  }
  deliver(message);
}

/** Subscribes to the console's checked messages; returns the unsubscribe function. */
export function onConsoleMessage(listener: ConsoleListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function handleWindowMessage(event: MessageEvent): void {
  if (event.source !== window.parent || !allowedOrigins?.includes(event.origin)) {
    return;
  }
  const message = parseConsoleMessage(event.data);
  if (!message) {
    return;
  }
  consoleOrigin = event.origin;
  for (const listener of listeners) {
    listener(message);
  }
}

function handleShortcut(event: KeyboardEvent): void {
  // The console's quick panel opens on ⌘J / Ctrl+J; with focus inside the frame
  // the console never sees the key, so Studio passes it up.
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'j') {
    event.preventDefault();
    postToConsole({ v: 1, type: 'shortcut', combo: 'mod+j' });
  }
}

/** Whether the server accepts console assertions; false until the configuration has loaded. */
export function isEmbedExchangeAvailable(): boolean {
  return exchangeAvailable;
}

/**
 * Starts the bridge once, from main.tsx: loads the allowed origins, starts
 * listening and announces Studio to the console. Later calls return the same
 * promise, so a caller can wait for the configuration. Not embedded, it does nothing.
 */
export function startEmbedBridge(): Promise<void> {
  if (!embedMode) {
    return Promise.resolve();
  }
  if (startPromise) {
    return startPromise;
  }
  window.addEventListener('message', handleWindowMessage);
  document.addEventListener('keydown', handleShortcut, true);

  startPromise = api.embed.config()
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { origins?: unknown; exchange?: unknown } | null) => {
      allowedOrigins = Array.isArray(body?.origins)
        ? body.origins.filter((origin): origin is string => typeof origin === 'string')
        : [];
      exchangeAvailable = body?.exchange === true;
    })
    .catch(() => {
      allowedOrigins = [];
    })
    .then(() => {
      const pending = outbox.splice(0);
      deliver({ v: 1, type: 'studio.ready', version: APP_VERSION, embed: embedMode, signedIn: Boolean(getStoredAuthToken()) });
      for (const message of pending) {
        deliver(message);
      }
    });
  return startPromise;
}

/**
 * Asks the console for a sign-in assertion and resolves with it, or with null
 * when the console does not answer within `timeoutMs`.
 */
export function requestConsoleAssertion(timeoutMs: number): Promise<string | null> {
  if (!embedMode) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      unsubscribe();
      resolve(null);
    }, timeoutMs);
    const unsubscribe = onConsoleMessage((message) => {
      if (message.type !== 'auth') {
        return;
      }
      window.clearTimeout(timer);
      unsubscribe();
      resolve(message.assertion);
    });
    postToConsole({ v: 1, type: 'auth.request' });
  });
}
