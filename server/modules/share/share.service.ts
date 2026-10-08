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

type ShareSessionRecord = {
  session_id: string;
  provider: string;
  custom_name: string | null;
  updated_at?: string | null;
};

type ShareDependencies = {
  shares: {
    create(input: {
      userId: number;
      sessionId: string;
      provider: string;
      title?: string | null;
      hiddenIds?: string[];
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
        expiresAt?: string | null;
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
  sessionId: string;
  provider: string;
  title: string | null;
  hiddenIds: string[];
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
  running: boolean;
  updatedAt: string;
};

const DUMMY_TOKEN_BUFFER = Buffer.alloc(43, 0x61);

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

function computeLatestTimestamp( candidates: Array<string | null | undefined>, fallback: string): string {
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
    const urlPath = `/share/${row.token}`;
    const resolvedTitle = row.title !== null
      ? row.title
      : (resolvedSession?.custom_name?.trim() || null);

    return {
      id: row.id,
      token: row.token,
      urlPath,
      url: urlPath,
      sessionId: row.session_id,
      provider: row.provider,
      title: resolvedTitle,
      hiddenIds: parseHiddenIds(row.hidden_ids),
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
    createOrGetShare(
      userId: number,
      input: {
        sessionId: string;
        provider?: string;
      },
    ): OwnerSharePayload {
      const nowIso = new Date(dependencies.now()).toISOString();
      const existing = dependencies.shares.getActiveBySession(userId, input.sessionId, nowIso);
      if (existing && isShareRowActive(existing, nowIso)) {
        return formatOwnerShare(existing);
      }

      const session = dependencies.sessions.getById(input.sessionId);
      if (!session) {
        throw new AppError(`Session "${input.sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      const provider = session.provider || input.provider || 'claude';
      const initialTitle = session.custom_name?.trim() || null;

      const created = dependencies.shares.create({
        userId,
        sessionId: input.sessionId,
        provider,
        title: initialTitle,
        hiddenIds: [],
        nowIso,
      });

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

    updateShare(
      userId: number,
      id: string,
      updates: {
        title?: string | null;
        hiddenIds?: string[];
        expiresAt?: string | null;
      },
    ): OwnerSharePayload {
      const nowIso = new Date(dependencies.now()).toISOString();
      requireOwnedActiveShare(userId, id, nowIso);

      const updated = dependencies.shares.update(id, {
        ...updates,
        nowIso,
      });
      if (!updated) {
        throw notFoundError();
      }

      return formatOwnerShare(updated);
    },

    revokeShare(userId: number, id: string): { id: string; revokedAt: string } {
      const nowIso = new Date(dependencies.now()).toISOString();
      const row = dependencies.shares.getById(id);
      if (!row) {
        throw notFoundError();
      }
      if (row.user_id !== userId) {
        throw forbiddenError();
      }

      dependencies.shares.revoke(id, nowIso);
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
      if (!timingSafeMatchToken(row?.token, token) || !row || !isShareRowActive(row, nowIso)) {
        throw notFoundError();
      }

      const session = dependencies.sessions.getById(row.session_id);
      if (!session) {
        throw notFoundError();
      }

      const hiddenIds = parseHiddenIds(row.hidden_ids);
      const history = await dependencies.sessions.fetchHistory(row.session_id);
      const items = filterSharedItems(history.messages, hiddenIds);
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
        running,
        updatedAt,
      };
    },
  };
}
