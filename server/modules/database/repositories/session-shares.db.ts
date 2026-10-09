import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

/**
 * Database row shape for `session_shares`.
 *
 * Consumed by the Share module through the database barrel to persist and
 * resolve public read-only session links.
 */
export type SessionShareRow = {
  id: string;
  token: string;
  user_id: number;
  session_id: string;
  provider: string;
  title: string | null;
  hidden_ids: string;
  focus_id: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  expires_at: string | null;
};

const COLUMNS =
  'id, token, user_id, session_id, provider, title, hidden_ids, focus_id, created_at, updated_at, revoked_at, expires_at';

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Dummy 43-byte base64url token used to keep comparison time constant when no row matches. */
const DUMMY_TOKEN_BUFFER = Buffer.alloc(43, 0x61);

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString();
}

function normalizeRow(row: SessionShareRow | undefined): SessionShareRow | undefined {
  if (!row) {
    return undefined;
  }

  return {
    ...row,
    focus_id: row.focus_id ?? null,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
    revoked_at: normalizeTimestamp(row.revoked_at),
    expires_at: normalizeTimestamp(row.expires_at),
  };
}

function constantTimeTokenEquals(storedToken: string, candidateToken: string): boolean {
  const storedBuffer = Buffer.from(storedToken, 'utf8');
  const candidateBuffer = Buffer.from(candidateToken, 'utf8');
  if (storedBuffer.length !== candidateBuffer.length) {
    timingSafeEqual(DUMMY_TOKEN_BUFFER, DUMMY_TOKEN_BUFFER);
    return false;
  }

  return timingSafeEqual(storedBuffer, candidateBuffer);
}

/**
 * Repository for the `session_shares` table, used by the Share module to
 * create, update, revoke, and look up public session share links.
 */
export const sessionSharesDb = {
  create(input: {
    userId: number;
    sessionId: string;
    provider: string;
    title?: string | null;
    hiddenIds?: string[];
    focusId?: string | null;
    expiresAt?: string | null;
    token?: string;
    nowIso?: string;
  }): SessionShareRow {
    const db = getConnection();
    const id = randomUUID();
    const token = input.token ?? randomBytes(32).toString('base64url');
    const nowIso = input.nowIso ?? new Date().toISOString();
    const hiddenIdsJson = JSON.stringify(input.hiddenIds ?? []);

    db.prepare(
      `INSERT INTO session_shares (
         id, token, user_id, session_id, provider, title, hidden_ids, focus_id, created_at, updated_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      token,
      input.userId,
      input.sessionId,
      input.provider,
      input.title ?? null,
      hiddenIdsJson,
      input.focusId ?? null,
      nowIso,
      nowIso,
      input.expiresAt ?? null,
    );

    const row = db
      .prepare(`SELECT ${COLUMNS} FROM session_shares WHERE id = ?`)
      .get(id) as SessionShareRow | undefined;

    return normalizeRow(row) as SessionShareRow;
  },

  getById(id: string): SessionShareRow | undefined {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM session_shares WHERE id = ?`)
      .get(id) as SessionShareRow | undefined;

    return normalizeRow(row);
  },

  /**
   * Looks up a share by token and verifies the token using `timingSafeEqual`,
   * running a dummy comparison when no candidate row exists so missing and
   * non-matching tokens take the same path.
   */
  getByToken(token: string): SessionShareRow | undefined {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM session_shares WHERE token = ?`)
      .get(token) as SessionShareRow | undefined;

    if (!row) {
      constantTimeTokenEquals(DUMMY_TOKEN_BUFFER.toString('utf8'), token);
      return undefined;
    }

    if (!constantTimeTokenEquals(row.token, token)) {
      return undefined;
    }

    return normalizeRow(row);
  },

  getActiveBySession(userId: number, sessionId: string, nowIso = new Date().toISOString()): SessionShareRow | undefined {
    const row = getConnection()
      .prepare(
        `SELECT ${COLUMNS} FROM session_shares
         WHERE user_id = ?
           AND session_id = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(userId, sessionId, nowIso) as SessionShareRow | undefined;

    return normalizeRow(row);
  },

  update(
    id: string,
    updates: {
      title?: string | null;
      hiddenIds?: string[];
      focusId?: string | null;
      expiresAt?: string | null;
      nowIso?: string;
    },
  ): SessionShareRow | undefined {
    const db = getConnection();
    const existing = this.getById(id);
    if (!existing) {
      return undefined;
    }

    const nextTitle = updates.title !== undefined ? updates.title : existing.title;
    const nextHiddenIds = updates.hiddenIds !== undefined
      ? JSON.stringify(updates.hiddenIds)
      : existing.hidden_ids;
    const nextFocusId = updates.focusId !== undefined ? updates.focusId : existing.focus_id;
    const nextExpiresAt = updates.expiresAt !== undefined ? updates.expiresAt : existing.expires_at;
    const nowIso = updates.nowIso ?? new Date().toISOString();

    db.prepare(
      `UPDATE session_shares
       SET title = ?, hidden_ids = ?, focus_id = ?, expires_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(nextTitle, nextHiddenIds, nextFocusId, nextExpiresAt, nowIso, id);

    return this.getById(id);
  },

  revoke(id: string, nowIso = new Date().toISOString()): SessionShareRow | undefined {
    const db = getConnection();
    const result = db
      .prepare(
        `UPDATE session_shares
         SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
         WHERE id = ?`
      )
      .run(nowIso, nowIso, id);

    if (result.changes === 0) {
      return undefined;
    }

    return this.getById(id);
  },
};
