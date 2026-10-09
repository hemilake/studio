import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';

import type { SessionShareRow } from '@/modules/database/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

import { filterSharedItems, type SharedTranscriptItem } from './share.filter.js';

const STUDIO_ASSERTION_ISSUER = 'hemilake-studio';
const STUDIO_ASSERTION_AUDIENCE = 'hemilake-console';
const STUDIO_ASSERTION_LIFETIME_S = 60;
const MIN_EMBED_SECRET_LENGTH = 32;
const DEFAULT_SYNC_INTERVAL_MS = 5_000;

/**
 * Configuration for reaching the local Hemilake console to upload cloud shares.
 *
 * Consumed by `share.service.ts`, `share.routes.ts`, and `share.module.ts`.
 */
export type CloudShareConfig = {
  available: boolean;
  consoleUrl: string | null;
  secret: string | null;
  reason: string | null;
};

/**
 * Payload sent to the local Hemilake console (`POST /api/studio/shares` and
 * `PUT /api/studio/shares/:id`).
 */
export type ConsoleShareWritePayload = {
  title: string;
  items: SharedTranscriptItem[];
  focusId: string | null;
  running: boolean;
  expiresAt: string | null;
};

/**
 * Result of a console cloud share create or update call.
 */
export type ConsoleShareResponse = {
  id: string;
  url: string;
  expiresAt: string;
  updatedAt?: string;
};

/**
 * Error returned when the local Hemilake console refuses or cannot complete a
 * cloud share request.
 */
export class ConsoleShareError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 502) {
    super(message);
    this.name = 'ConsoleShareError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Client contract for talking to the local Hemilake console's
 * `/api/studio/shares` endpoints.
 *
 * Consumed by `createCloudShareSyncService` and unit-tested in
 * `share.service.test.ts`.
 */
export type ConsoleShareClient = {
  getConfig(): CloudShareConfig;
  createShare(payload: ConsoleShareWritePayload): Promise<ConsoleShareResponse>;
  updateShare(cloudId: string, payload: ConsoleShareWritePayload): Promise<ConsoleShareResponse>;
  deleteShare(cloudId: string): Promise<void>;
};

type SyncShareSessionRecord = {
  session_id: string;
  provider: string;
  custom_name: string | null;
  updated_at?: string | null;
};

type CloudShareSyncDependencies = {
  shares: {
    getById(id: string): SessionShareRow | undefined;
    listActiveCloudShares(nowIso: string): SessionShareRow[];
    listPendingCloudDeletes(): SessionShareRow[];
    update(
      id: string,
      updates: {
        title?: string | null;
        hiddenIds?: string[];
        focusId?: string | null;
        expiresAt?: string | null;
        cloudId?: string | null;
        cloudUrl?: string | null;
        cloudExpiresAt?: string | null;
        cloudSyncedAt?: string | null;
        cloudError?: string | null;
        nowIso?: string;
      },
    ): SessionShareRow | undefined;
  };
  sessions: {
    getById(sessionId: string): SyncShareSessionRecord | undefined;
    fetchHistory(sessionId: string): Promise<{ messages: NormalizedMessage[] }>;
    isRunning(sessionId: string): boolean;
  };
  consoleClient: ConsoleShareClient;
  now(): number;
  intervalMs?: number;
};

function readEmbedSecret(env: NodeJS.ProcessEnv): string | null {
  let secret = env.CLOUDCLI_EMBED_SECRET?.trim() ?? '';
  const secretFile = env.CLOUDCLI_EMBED_SECRET_FILE?.trim();
  if (!secret && secretFile) {
    try {
      secret = fs.readFileSync(secretFile, 'utf8').trim();
    } catch {
      secret = '';
    }
  }
  return secret.length >= MIN_EMBED_SECRET_LENGTH ? secret : null;
}

function normalizeConsoleUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.origin + parsed.pathname.replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * Reads `CLOUDCLI_CONSOLE_URL` and `CLOUDCLI_EMBED_SECRET(_FILE)` from the
 * environment to determine whether "Upload to Hemilake" is available.
 *
 * Consumed by `createConsoleShareClient` and tested in `share.service.test.ts`.
 */
export function readCloudShareConfig(env: NodeJS.ProcessEnv = process.env): CloudShareConfig {
  const consoleUrl = normalizeConsoleUrl(env.CLOUDCLI_CONSOLE_URL);
  const secret = readEmbedSecret(env);
  if (!consoleUrl || !secret) {
    return {
      available: false,
      consoleUrl,
      secret: null,
      reason: 'Needs Hemilake: open Studio from your Hemilake console',
    };
  }
  return {
    available: true,
    consoleUrl,
    secret,
    reason: null,
  };
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Signs a short-lived HS256 JWT assertion (`iss: "hemilake-studio"`,
 * `aud: "hemilake-console"`, `exp <= 60s`, unique `jti`) over the shared embed
 * secret for `Authorization: Studio <jwt>`.
 *
 * Consumed by `createConsoleShareClient` and tested in `share.service.test.ts`.
 */
export function signStudioConsoleAssertion(
  secret: string,
  nowMs = Date.now(),
  jti: string = randomUUID(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + STUDIO_ASSERTION_LIFETIME_S;
  const headerSegment = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const payloadSegment = base64UrlJson({
    iss: STUDIO_ASSERTION_ISSUER,
    aud: STUDIO_ASSERTION_AUDIENCE,
    jti,
    iat,
    exp,
  });
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(signingInput, 'ascii')
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

function formatConsoleErrorMessage(code: string, detail: string): string {
  switch (code) {
    case 'feature_not_licensed':
      return 'Your Hemilake licence does not include Studio cloud shares (hemilake.studio.share).';
    case 'no_licence':
      return 'This Hemilake installation has no active licence.';
    case 'payload_too_large':
      return 'This conversation exceeds the 2 MB cloud share limit.';
    case 'share_limit':
      return 'You have reached the limit of 100 active cloud shares on this licence.';
    case 'rate_limited':
      return 'Cloud share updates are rate-limited; changes will sync shortly.';
    case 'admin_unreachable':
      return 'Could not reach Hemilake share server; Studio will retry automatically.';
    default:
      return detail || `Sync failed (${code})`;
  }
}

function parseHiddenIds(rawJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  } catch {
    return [];
  }
}

/**
 * Creates the HTTP client that relays Studio cloud share operations to the
 * local Hemilake console (`/api/studio/shares`).
 *
 * Consumed by `share.module.ts` and `share.service.test.ts`.
 */
const CONSOLE_REQUEST_TIMEOUT_MS = 20_000;

export function createConsoleShareClient(options: {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fetchImpl?: typeof fetch;
} = {}): ConsoleShareClient {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const request = async (
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: ConsoleShareWritePayload,
  ): Promise< unknown > => {
    const config = readCloudShareConfig(options.env ?? process.env);
    if (!config.available || !config.consoleUrl || !config.secret) {
      throw new ConsoleShareError(
        'console_not_configured',
        config.reason ?? 'Needs Hemilake: open Studio from your Hemilake console',
        409,
      );
    }

    const assertion = signStudioConsoleAssertion(config.secret, now());
    const url = `${config.consoleUrl}/api/studio/shares${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Studio ${assertion}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        // A console that never answers would hold the sync tick (and every other share) forever.
        signal: AbortSignal.timeout(CONSOLE_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Console unreachable';
      throw new ConsoleShareError('admin_unreachable', formatConsoleErrorMessage('admin_unreachable', detail), 502);
    }

    if (method === 'DELETE' && (response.status === 204 || response.status === 404)) {
      return null;
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    if (!response.ok) {
      const rawCode =
        (typeof parsed.code === 'string' && parsed.code) ||
        (typeof parsed.error === 'string' && parsed.error) ||
        'admin_unreachable';
      const rawDetail =
        (typeof parsed.detail === 'string' && parsed.detail) ||
        (typeof parsed.message === 'string' && parsed.message) ||
        `HTTP ${response.status}`;
      throw new ConsoleShareError(
        rawCode,
        formatConsoleErrorMessage(rawCode, rawDetail),
        response.status,
      );
    }

    return parsed;
  };

  return {
    getConfig() {
      return readCloudShareConfig(options.env ?? process.env);
    },

    async createShare(payload) {
      const data = (await request('POST', '', payload)) as Record<string, unknown>;
      return {
        id: String(data.id ?? ''),
        url: String(data.url ?? ''),
        expiresAt: String(data.expiresAt ?? ''),
      };
    },

    async updateShare(cloudId, payload) {
      const data = (await request('PUT', `/${encodeURIComponent(cloudId)}`, payload)) as Record<string, unknown>;
      return {
        id: String(data.id ?? cloudId),
        url: String(data.url ?? ''),
        expiresAt: String(data.expiresAt ?? ''),
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
      };
    },

    async deleteShare(cloudId) {
      await request('DELETE', `/${encodeURIComponent(cloudId)}`);
    },
  };
}

type ShareSyncCacheEntry = {
  lastSessionUpdatedAt: string | null;
  lastRunning: boolean;
  lastPayloadHash: string | null;
};

/**
 * Creates the cloud share sync service that pushes filtered session items to
 * the Hemilake console on create, on owner metadata edits, and every 5 seconds
 * while active (skipping history rebuilds when the session's `updated_at` and
 * running state are unchanged, and only PUTting when the payload hash changed,
 * plus one final PUT with `running: false` when a run ends), and retries
 * DELETEs for revoked cloud shares until the console confirms deletion.
 *
 * Consumed by `share.service.ts` and `share.module.ts`, and unit-tested in
 * `share.service.test.ts`.
 */
export function createCloudShareSyncService(dependencies: CloudShareSyncDependencies) {
  const cache = new Map<string, ShareSyncCacheEntry>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let tickInFlight = false;

  const buildWritePayload = async (
    row: SessionShareRow,
    session?: SyncShareSessionRecord,
  ): Promise<{ payload: ConsoleShareWritePayload; hash: string; running: boolean; sessionUpdatedAt: string | null }> => {
    const resolvedSession = session ?? dependencies.sessions.getById(row.session_id);
    const hiddenIds = parseHiddenIds(row.hidden_ids);
    const history = await dependencies.sessions.fetchHistory(row.session_id);
    const items = filterSharedItems(history.messages, hiddenIds);
    const focusId =
      row.focus_id && items.some((item) => item.id === row.focus_id)
        ? row.focus_id
        : null;
    const running = dependencies.sessions.isRunning(row.session_id);
    const title = row.title?.trim() || resolvedSession?.custom_name?.trim() || 'Untitled session';
    const expiresAt = row.expires_at ?? null;
    const payload: ConsoleShareWritePayload = {
      title,
      items,
      focusId,
      running,
      expiresAt,
    };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return {
      payload,
      hash,
      running,
      sessionUpdatedAt: resolvedSession?.updated_at ?? null,
    };
  };

  const syncShareNow = async (
    shareId: string,
    options: { force?: boolean } = {},
  ): Promise<SessionShareRow | undefined> => {
    const row = dependencies.shares.getById(shareId);
    if (!row || row.mode !== 'cloud' || row.revoked_at !== null) {
      cache.delete(shareId);
      return row;
    }

    const session = dependencies.sessions.getById(row.session_id);
    const running = dependencies.sessions.isRunning(row.session_id);
    const sessionUpdatedAt = session?.updated_at ?? null;
    const cached = cache.get(shareId);

    // Skip rebuilding history on periodic ticks if the session was not running,
    // is not running now, its updated_at did not move, and we already synced it.
    if (
      !options.force &&
      row.cloud_id &&
      !row.cloud_error &&
      cached &&
      cached.lastPayloadHash !== null &&
      !cached.lastRunning &&
      !running &&
      cached.lastSessionUpdatedAt === sessionUpdatedAt
    ) {
      return row;
    }

    try {
      const built = await buildWritePayload(row, session);
      const nowIso = new Date(dependencies.now()).toISOString();

      if (!row.cloud_id) {
        const created = await dependencies.consoleClient.createShare(built.payload);
        cache.set(shareId, {
          lastSessionUpdatedAt: built.sessionUpdatedAt,
          lastRunning: built.running,
          lastPayloadHash: built.hash,
        });
        return dependencies.shares.update(shareId, {
          cloudId: created.id,
          cloudUrl: created.url,
          cloudExpiresAt: created.expiresAt || row.expires_at,
          expiresAt: created.expiresAt || row.expires_at,
          cloudSyncedAt: nowIso,
          cloudError: null,
          nowIso,
        });
      }

      const hashChanged = !cached || cached.lastPayloadHash !== built.hash;
      const runEnded = Boolean(cached?.lastRunning && !built.running);
      if (!options.force && !hashChanged && !runEnded && !row.cloud_error) {
        cache.set(shareId, {
          lastSessionUpdatedAt: built.sessionUpdatedAt,
          lastRunning: built.running,
          lastPayloadHash: built.hash,
        });
        return row;
      }

      const updated = await dependencies.consoleClient.updateShare(row.cloud_id, built.payload);
      cache.set(shareId, {
        lastSessionUpdatedAt: built.sessionUpdatedAt,
        lastRunning: built.running,
        lastPayloadHash: built.hash,
      });
      return dependencies.shares.update(shareId, {
        cloudUrl: updated.url || row.cloud_url,
        cloudExpiresAt: updated.expiresAt || row.cloud_expires_at || row.expires_at,
        expiresAt: updated.expiresAt || row.expires_at,
        cloudSyncedAt: updated.updatedAt || nowIso,
        cloudError: null,
        nowIso,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to sync with Hemilake';
      const nowIso = new Date(dependencies.now()).toISOString();
      return dependencies.shares.update(shareId, {
        cloudError: message,
        nowIso,
      });
    }
  };

  const revokeCloudShare = async (row: SessionShareRow): Promise<void> => {
    cache.delete(row.id);
    if (!row.cloud_id) {
      return;
    }
    try {
      await dependencies.consoleClient.deleteShare(row.cloud_id);
      dependencies.shares.update(row.id, {
        cloudId: null,
        cloudError: null,
        nowIso: new Date(dependencies.now()).toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Pending cloud deletion';
      dependencies.shares.update(row.id, {
        cloudError: message,
        nowIso: new Date(dependencies.now()).toISOString(),
      });
    }
  };

  const tick = async (): Promise<void> => {
    if (tickInFlight) {
      return;
    }
    tickInFlight = true;
    try {
      const nowIso = new Date(dependencies.now()).toISOString();
      const activeRows = dependencies.shares.listActiveCloudShares(nowIso);
      for (const row of activeRows) {
        await syncShareNow(row.id);
      }

      const pendingDeletes = dependencies.shares.listPendingCloudDeletes();
      for (const row of pendingDeletes) {
        await revokeCloudShare(row);
      }
    } catch {
      // Never crash the server from a background sync tick.
    } finally {
      tickInFlight = false;
    }
  };

  return {
    getCloudConfig(): CloudShareConfig {
      return dependencies.consoleClient.getConfig();
    },

    syncShareNow,

    revokeCloudShare,

    tick,

    start(): void {
      if (timer) {
        return;
      }
      const intervalMs = dependencies.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
      void tick();
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
