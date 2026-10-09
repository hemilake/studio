import { timingSafeEqual } from 'node:crypto';

import type { SessionShareRow } from '@/modules/database/index.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import {
  buildSharePreviewItems,
  filterSharedItems,
  type SharedTranscriptItem,
  type SharedTranscriptPreviewItem,
} from './share.filter.js';
import type { CloudShareConfig, createCloudShareSyncService } from './share.sync.js';

type ShareSessionRecord = {
  session_id: string;
  provider: string;
  custom_name: string | null;
  updated_at?: string | null;
};

type CloudSyncService = ReturnType<typeof createCloudShareSyncService>;

type ShareDependencies = {
  shares: {
    create(input: {
      userId: number;
      sessionId: string;
      provider: string;
      title?: string | null;
      hiddenIds?: string[];
      focusId?: string | null;
      mode?: 'local' | 'cloud';
      cloudId?: string | null;
      cloudUrl?: string | null;
      cloudExpiresAt?: string | null;
      cloudSyncedAt?: string | null;
      cloudError?: string | null;
      expiresAt?: string | null;
      nowIso?: string;
    }): SessionShareRow;
    getById(id: string): SessionShareRow | undefined;
    getByToken(token: string): SessionShareRow | undefined;
    getActiveBySession(userId: number, sessionId: string, nowIso: string): SessionShareRow | undefined;
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
    revoke(id: string, nowIso: string): SessionShareRow | undefined;
  };
  sessions: {
    getById(sessionId: string): ShareSessionRecord | undefined;
    fetchHistory(sessionId: string): Promise<{ messages: NormalizedMessage[] }>;
    isRunning(sessionId: string): boolean;
  };
  cloudSync?: CloudSyncService;
  now(): number;
};

/**
 * Owner-facing representation of a session share record.
 *
 * Consumed by `share.routes.ts` for `POST /api/shares`, `GET /api/shares`,
 * `PATCH /api/shares/:id`, and `GET /api/shares/:id/preview`.
 */
export type OwnerSharePayload = {
  id: string;
  token: string;
  urlPath: string;
  url: string;
  mode: 'local' | 'cloud';
  cloudId: string | null;
  cloudUrl: string | null;
  cloudExpiresAt: string | null;
  cloudSyncedAt: string | null;
  cloudError: string | null;
  sessionId: string;
  provider: string;
  title: string | null;
  hiddenIds: string[];
  focusId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

/**
 * Owner preview payload combining the share metadata, public view fields, and
 * every candidate item (including hidden ones flagged `hidden: true`).
 */
export type OwnerSharePreviewPayload = OwnerSharePayload & {
  items: SharedTranscriptPreviewItem[];
  running: boolean;
};

/**
 * Public read-only payload returned by `GET /api/public/shares/:token`.
 */
export type PublicSharePayload = {
  title: string;
  provider: string;
  items: SharedTranscriptItem[];
  focusId: string | null;
  running: boolean;
  updatedAt: string;
};

const DUMMY_TOKEN_BUFFER = Buffer.alloc(43, 0x61);
const DEFAULT_CLOUD_EXPIRY_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function timingSafeMatchToken(storedToken: string | undefined, candidateToken: string): boolean {
  const storedBuffer = storedToken ? Buffer.from(storedToken, 'utf8') : DUMMY_TOKEN_BUFFER;
  const candidateBuffer = Buffer.from(candidateToken, 'utf8');
  if (storedBuffer.length !== candidateBuffer.length) {
    timingSafeEqual(DUMMY_TOKEN_BUFFER, DUMMY_TOKEN_BUFFER);
    return false;
  }

  const matches = timingSafeEqual(storedBuffer, candidateBuffer);
  return Boolean(storedToken) && matches;
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

function isShareRowActive(row: SessionShareRow, nowIso: string): boolean {
  if (row.revoked_at !== null) {
    return false;
  }
  if (row.expires_at !== null && row.expires_at <= nowIso) {
    return false;
  }
  return true;
}

function notFoundError(): AppError {
  return new AppError('Share not found', {
    code: 'SHARE_NOT_FOUND',
    statusCode: 404,
  });
}

function forbiddenError(): AppError {
  return new AppError('You do not have permission to access this share', {
    code: 'SHARE_FORBIDDEN',
    statusCode: 403,
  });
}

function computeLatestTimestamp(candidates: Array<string | null | undefined>, fallback: string): string {
  let latestMs = Number.NEGATIVE_INFINITY;
  let latestIso = fallback;

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const parsedMs = Date.parse(candidate);
    if (!Number.isNaN(parsedMs) && parsedMs > latestMs) {
      latestMs = parsedMs;
      latestIso = new Date(parsedMs).toISOString();
    }
  }

  return latestIso;
}

/**
 * Creates the Share application service for owner management and public read-only
 * viewing of shared sessions.
 *
 * Consumed by `share.module.ts` and unit-tested in `share.service.test.ts`.
 */
export function createShareService(dependencies: ShareDependencies) {
  const formatOwnerShare = (row: SessionShareRow, session?: ShareSessionRecord): OwnerSharePayload => {
    const resolvedSession = session ?? dependencies.sessions.getById(row.session_id);
    const mode = row.mode === 'cloud' ? 'cloud' : 'local';
    const urlPath = mode === 'cloud' ? (row.cloud_url ?? '') : `/share/${row.token}`;
    const resolvedTitle = row.title !== null
      ? row.title
      : (resolvedSession?.custom_name?.trim() || null);

    return {
      id: row.id,
      token: row.token,
      urlPath,
      url: mode === 'cloud' ? (row.cloud_url ?? '') : urlPath,
      mode,
      cloudId: row.cloud_id ?? null,
      cloudUrl: row.cloud_url ?? null,
      cloudExpiresAt: row.cloud_expires_at ?? row.expires_at ?? null,
      cloudSyncedAt: row.cloud_synced_at ?? null,
      cloudError: row.cloud_error ?? null,
      sessionId: row.session_id,
      provider: row.provider,
      title: resolvedTitle,
      hiddenIds: parseHiddenIds(row.hidden_ids),
      focusId: row.focus_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  };

  const requireOwnedActiveShare = (userId: number, id: string, nowIso: string): SessionShareRow => {
    const row = dependencies.shares.getById(id);
    if (!row) {
      throw notFoundError();
    }
    if (row.user_id !== userId) {
      throw forbiddenError();
    }
    if (!isShareRowActive(row, nowIso)) {
      throw notFoundError();
    }
    return row;
  };

  return {
    getCloudConfig(): { available: boolean; reason: string | null } {
      const cfg: CloudShareConfig | undefined = dependencies.cloudSync?.getCloudConfig();
      if (!cfg) {
        return {
          available: false,
          reason: 'Needs Hemilake: open Studio from your Hemilake console',
        };
      }
      return {
        available: cfg.available,
        reason: cfg.reason,
      };
    },

    async createOrGetShare(
      userId: number,
      input: {
        sessionId: string;
        provider?: string;
        mode?: 'local' | 'cloud';
        expiresAt?: string | null;
      },
    ): Promise<OwnerSharePayload> {
      const nowMs = dependencies.now();
      const nowIso = new Date(nowMs).toISOString();
      const existing = dependencies.shares.getActiveBySession(userId, input.sessionId, nowIso);
      if (existing && isShareRowActive(existing, nowIso)) {
        if (existing.mode === 'cloud' && !existing.cloud_id && dependencies.cloudSync) {
          const synced = await dependencies.cloudSync.syncShareNow(existing.id, { force: true });
          return formatOwnerShare(synced ?? existing);
        }
        return formatOwnerShare(existing);
      }

      const session = dependencies.sessions.getById(input.sessionId);
      if (!session) {
        throw new AppError(`Session "${input.sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      const mode = input.mode === 'cloud' ? 'cloud' : 'local';
      if (mode === 'cloud') {
        const cfg = dependencies.cloudSync?.getCloudConfig();
        if (!cfg || !cfg.available) {
          throw new AppError(
            cfg?.reason ?? 'Needs Hemilake: open Studio from your Hemilake console',
            {
              code: 'CLOUD_SHARE_UNAVAILABLE',
              statusCode: 409,
            },
          );
        }
      }

      const provider = session.provider || input.provider || 'claude';
      const initialTitle = session.custom_name?.trim() || null;
      const defaultCloudExpiresAt =
        mode === 'cloud'
          ? (input.expiresAt ?? new Date(nowMs + DEFAULT_CLOUD_EXPIRY_DAYS * MS_PER_DAY).toISOString())
          : (input.expiresAt ?? null);

      let created = dependencies.shares.create({
        userId,
        sessionId: input.sessionId,
        provider,
        title: initialTitle,
        hiddenIds: [],
        mode,
        expiresAt: defaultCloudExpiresAt,
        cloudExpiresAt: mode === 'cloud' ? defaultCloudExpiresAt : null,
        nowIso,
      });

      if (mode === 'cloud' && dependencies.cloudSync) {
        const synced = await dependencies.cloudSync.syncShareNow(created.id, { force: true });
        if (synced) {
          created = synced;
        }
      }

      return formatOwnerShare(created, session);
    },

    getActiveShareBySession(userId: number, sessionId: string): OwnerSharePayload {
      const nowIso = new Date(dependencies.now()).toISOString();
      const row = dependencies.shares.getActiveBySession(userId, sessionId, nowIso);
      if (!row || !isShareRowActive(row, nowIso)) {
        throw notFoundError();
      }
      return formatOwnerShare(row);
    },

    async updateShare(
      userId: number,
      id: string,
      updates: {
        title?: string | null;
        hiddenIds?: string[];
        focusId?: string | null;
        expiresAt?: string | null;
      },
    ): Promise<OwnerSharePayload> {
      const nowIso = new Date(dependencies.now()).toISOString();
      const existing = requireOwnedActiveShare(userId, id, nowIso);

      let updated = dependencies.shares.update(id, {
        ...updates,
        ...(existing.mode === 'cloud' && updates.expiresAt !== undefined
          ? { cloudExpiresAt: updates.expiresAt }
          : {}),
        nowIso,
      });
      if (!updated) {
        throw notFoundError();
      }

      if (updated.mode === 'cloud' && dependencies.cloudSync) {
        const synced = await dependencies.cloudSync.syncShareNow(updated.id, { force: true });
        if (synced) {
          updated = synced;
        }
      }

      return formatOwnerShare(updated);
    },

    async revokeShare(userId: number, id: string): Promise<{ id: string; revokedAt: string }> {
      const nowIso = new Date(dependencies.now()).toISOString();
      const row = dependencies.shares.getById(id);
      if (!row) {
        throw notFoundError();
      }
      if (row.user_id !== userId) {
        throw forbiddenError();
      }

      const revoked = dependencies.shares.revoke(id, nowIso);
      if (row.mode === 'cloud' && dependencies.cloudSync) {
        await dependencies.cloudSync.revokeCloudShare(revoked ?? row);
      }
      return { id: row.id, revokedAt: nowIso };
    },

    async getSharePreview(userId: number, id: string): Promise<OwnerSharePreviewPayload> {
      const nowIso = new Date(dependencies.now()).toISOString();
      const row = requireOwnedActiveShare(userId, id, nowIso);
      const session = dependencies.sessions.getById(row.session_id);
      const hiddenIds = parseHiddenIds(row.hidden_ids);
      const history = await dependencies.sessions.fetchHistory(row.session_id);
      const items = buildSharePreviewItems(history.messages, hiddenIds);
      const running = dependencies.sessions.isRunning(row.session_id);
      const lastItemTimestamp = items[items.length - 1]?.timestamp;
      const updatedAt = computeLatestTimestamp(
        [row.updated_at, session?.updated_at, lastItemTimestamp],
        row.updated_at,
      );

      const ownerShare = formatOwnerShare(row, session);
      return {
        ...ownerShare,
        title: ownerShare.title || 'Untitled session',
        items,
        running,
        updatedAt,
      };
    },

    async getPublicShare(tokenInput: string): Promise<PublicSharePayload> {
      const token = tokenInput.trim();
      if (!token) {
        timingSafeMatchToken(undefined, '');
        throw notFoundError();
      }

      const nowIso = new Date(dependencies.now()).toISOString();
      const row = dependencies.shares.getByToken(token);
      if (
        !timingSafeMatchToken(row?.token, token) ||
        !row ||
        row.mode === 'cloud' ||
        !isShareRowActive(row, nowIso)
      ) {
        throw notFoundError();
      }

      const session = dependencies.sessions.getById(row.session_id);
      if (!session) {
        throw notFoundError();
      }

      const hiddenIds = parseHiddenIds(row.hidden_ids);
      const history = await dependencies.sessions.fetchHistory(row.session_id);
      const items = filterSharedItems(history.messages, hiddenIds);
      const focusId =
        row.focus_id && items.some((item) => item.id === row.focus_id)
          ? row.focus_id
          : null;
      const running = dependencies.sessions.isRunning(row.session_id);
      const lastItemTimestamp = items[items.length - 1]?.timestamp;
      const updatedAt = computeLatestTimestamp(
        [row.updated_at, session.updated_at, lastItemTimestamp],
        row.updated_at,
      );
      const title = row.title?.trim() || session.custom_name?.trim() || 'Untitled session';

      return {
        title,
        provider: row.provider,
        items,
        focusId,
        running,
        updatedAt,
      };
    },
  };
}
