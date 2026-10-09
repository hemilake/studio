import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionSharesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createPublicShareRouter, createShareRouter } from '../share.routes.js';
import { createShareService } from '../share.service.js';
import {
  ConsoleShareError,
  createCloudShareSyncService,
  createConsoleShareClient,
  readCloudShareConfig,
  signStudioConsoleAssertion,
  type ConsoleShareClient,
  type ConsoleShareWritePayload,
} from '../share.sync.js';

const SESSION_ID = 'shared-session-1';

const SAMPLE_HISTORY: NormalizedMessage[] = [
  {
    id: 'msg-u1',
    sessionId: SESSION_ID,
    timestamp: '2026-10-08T12:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: 'Build the share feature\n<system-reminder>internal note</system-reminder>',
  },
  {
    id: 'msg-think',
    sessionId: SESSION_ID,
    timestamp: '2026-10-08T12:00:01.000Z',
    provider: 'claude',
    kind: 'thinking',
    role: 'assistant',
    content: 'Private reasoning',
  },
  {
    id: 'msg-tool',
    sessionId: SESSION_ID,
    timestamp: '2026-10-08T12:00:02.000Z',
    provider: 'claude',
    kind: 'tool_use',
    role: 'assistant',
    toolName: 'Bash',
    toolId: 'call-1',
    toolInput: { command: 'ls -la' },
    toolResult: { content: 'secret.txt', isError: false },
  },
  {
    id: 'msg-a1',
    sessionId: SESSION_ID,
    timestamp: '2026-10-08T12:00:03.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: 'Here is the share design.',
  },
  {
    id: 'msg-u2',
    sessionId: SESSION_ID,
    timestamp: '2026-10-08T12:01:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: 'Hide this follow-up prompt',
  },
  {
    id: 'msg-a2',
    sessionId: SESSION_ID,
    timestamp: '2026-10-08T12:01:05.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: 'Follow-up answer.',
  },
];

async function withShareTestServer(
  runTest: (ctx: {
    baseUrl: string;
    ownerId: number;
    otherUserId: number;
    setRunning: (running: boolean) => void;
    advanceClockMs: (ms: number) => void;
  }) => Promise<void>,
  options: { maxRequestsPerMinute?: number } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'session-shares-test-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();

  let nowMs = Date.UTC(2026, 9, 8, 12, 5, 0);
  let isRunning = false;

  const owner = userDb.createUser('owner', 'hash-1');
  const other = userDb.createUser('intruder', 'hash-2');
  sessionsDb.createAppSession(SESSION_ID, 'claude', tempDir, 'My Shared Session');

  const service = createShareService({
    shares: {
      create: (input) => sessionSharesDb.create(input),
      getById: (id) => sessionSharesDb.getById(id),
      getByToken: (token) => sessionSharesDb.getByToken(token),
      getActiveBySession: (userId, sessionId, nowIso) =>
        sessionSharesDb.getActiveBySession(userId, sessionId, nowIso),
      update: (id, updates) => sessionSharesDb.update(id, updates),
      revoke: (id, nowIso) => sessionSharesDb.revoke(id, nowIso),
    },
    sessions: {
      getById: (sessionId) => sessionsDb.getSessionById(sessionId) ?? undefined,
      fetchHistory: async () => ({ messages: SAMPLE_HISTORY }),
      isRunning: () => isRunning,
    },
    now: () => nowMs,
  });

  const app = express();
  app.use(express.json());

  // Public route mounted before any auth middleware, just like server/index.ts.
  app.use(
    '/api/public/shares',
    createPublicShareRouter(service, {
      maxRequestsPerMinute: options.maxRequestsPerMinute ?? 120,
      now: () => nowMs,
    }),
  );

  // Simulated authenticateToken middleware reading x-test-user-id header.
  const requireTestUser = (req: Request, res: Response, next: NextFunction) => {
    const rawUserId = req.headers['x-test-user-id'];
    if (!rawUserId) {
      res.status(401).json({ error: 'Access token required' });
      return;
    }
    (req as Request & { user?: { id: number } }).user = { id: Number(rawUserId) };
    next();
  };

  app.use('/api/shares', requireTestUser, createShareRouter(service));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        success: false,
        error: { code: err.code, message: err.message },
      });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await runTest({
      baseUrl: `http://127.0.0.1:${address.port}`,
      ownerId: Number(owner.id),
      otherUserId: Number(other.id),
      setRunning: (next) => {
        isRunning = next;
      },
      advanceClockMs: (ms) => {
        nowMs += ms;
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

test('creating a share, fetching public view without auth, ETag 304, hiding items, and revoking → 404', async () => {
  await withShareTestServer(async ({ baseUrl, ownerId, setRunning }) => {
    // Public route needs no auth; owner route without auth returns 401.
    const unauthOwnerRes = await fetch(`${baseUrl}/api/shares?sessionId=${SESSION_ID}`);
    assert.equal(unauthOwnerRes.status, 401);

    // Create share via POST /api/shares
    const createRes = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(ownerId),
      },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    assert.equal(createRes.status, 200);
    const created = (await createRes.json()) as {
      id: string;
      token: string;
      urlPath: string;
      title: string;
      hiddenIds: string[];
    };
    assert.ok(created.id);
    assert.equal(created.token.length, 43); // 32 bytes base64url
    assert.equal(created.urlPath, `/share/${created.token}`);
    assert.equal(created.title, 'My Shared Session');
    assert.deepEqual(created.hiddenIds, []);

    // Posting again returns the same active share.
    const createAgainRes = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(ownerId),
      },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    const createdAgain = (await createAgainRes.json()) as { id: string; token: string };
    assert.equal(createdAgain.id, created.id);
    assert.equal(createdAgain.token, created.token);

    // Public route works with NO auth headers and sets required security headers.
    setRunning(true);
    const publicRes = await fetch(`${baseUrl}/api/public/shares/${created.token}`);
    assert.equal(publicRes.status, 200);
    assert.equal(publicRes.headers.get('cache-control'), 'no-store');
    assert.equal(publicRes.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(publicRes.headers.get('referrer-policy'), 'no-referrer');
    const etag = publicRes.headers.get('etag');
    assert.ok(etag);

    const publicBody = (await publicRes.json()) as {
      title: string;
      provider: string;
      running: boolean;
      items: Array<{ id: string; role: string; text: string }>;
    };
    assert.equal(publicBody.title, 'My Shared Session');
    assert.equal(publicBody.provider, 'claude');
    assert.equal(publicBody.running, true);
    assert.equal(publicBody.items.length, 4);

    const rawPublicJson = JSON.stringify(publicBody);
    assert.ok(!rawPublicJson.includes('system-reminder'));
    assert.ok(!rawPublicJson.includes('Private reasoning'));
    assert.ok(!rawPublicJson.includes('Bash'));
    assert.ok(!rawPublicJson.includes('secret.txt'));

    // Polling with If-None-Match returns 304 Not Modified.
    const notModifiedRes = await fetch(`${baseUrl}/api/public/shares/${created.token}`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(notModifiedRes.status, 304);

    // Owner hides msg-u2 and updates title via PATCH /api/shares/:id.
    const patchRes = await fetch(`${baseUrl}/api/shares/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(ownerId),
      },
      body: JSON.stringify({
        title: 'Custom Public Title',
        hiddenIds: ['msg-u2'],
      }),
    });
    assert.equal(patchRes.status, 200);

    // Preview endpoint still includes msg-u2 with hidden: true.
    const previewRes = await fetch(`${baseUrl}/api/shares/${created.id}/preview`, {
      headers: { 'x-test-user-id': String(ownerId) },
    });
    assert.equal(previewRes.status, 200);
    const previewBody = (await previewRes.json()) as {
      items: Array<{ id: string; hidden: boolean }>;
    };
    assert.equal(previewBody.items.length, 4);
    assert.equal(previewBody.items.find((i) => i.id === 'msg-u2')?.hidden, true);

    // Public endpoint omits msg-u2 completely and reflects the new title.
    const afterHideRes = await fetch(`${baseUrl}/api/public/shares/${created.token}`);
    assert.equal(afterHideRes.status, 200);
    const afterHideBody = (await afterHideRes.json()) as {
      title: string;
      items: Array<{ id: string; text: string }>;
    };
    assert.equal(afterHideBody.title, 'Custom Public Title');
    assert.deepEqual(
      afterHideBody.items.map((item) => item.id),
      ['msg-u1', 'msg-a1', 'msg-a2'],
    );
    assert.ok(!JSON.stringify(afterHideBody).includes('Hide this follow-up prompt'));

    // Revoking via DELETE /api/shares/:id makes the token return 404 forever.
    const deleteRes = await fetch(`${baseUrl}/api/shares/${created.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user-id': String(ownerId) },
    });
    assert.equal(deleteRes.status, 200);

    const revokedPublicRes = await fetch(`${baseUrl}/api/public/shares/${created.token}`);
    assert.equal(revokedPublicRes.status, 404);
    const revokedBody = await revokedPublicRes.json();

    const unknownPublicRes = await fetch(`${baseUrl}/api/public/shares/unknown-token-value`);
    assert.equal(unknownPublicRes.status, 404);
    const unknownBody = await unknownPublicRes.json();

    assert.deepEqual(revokedBody, unknownBody);
  });
});

test('expired share returns the exact same 404 body as unknown and revoked tokens', async () => {
  await withShareTestServer(async ({ baseUrl, ownerId, advanceClockMs }) => {
    const createRes = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(ownerId),
      },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    const created = (await createRes.json()) as { id: string; token: string };

    // Set expiresAt 10 seconds in the future.
    const expiresAt = new Date(Date.UTC(2026, 9, 8, 12, 5, 10)).toISOString();
    const patchRes = await fetch(`${baseUrl}/api/shares/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(ownerId),
      },
      body: JSON.stringify({ expiresAt }),
    });
    assert.equal(patchRes.status, 200);

    // Before expiry: 200 OK
    const beforeRes = await fetch(`${baseUrl}/api/public/shares/${created.token}`);
    assert.equal(beforeRes.status, 200);

    // Advance clock past expiry: 404 with identical body to unknown token
    advanceClockMs(20_000);
    const expiredRes = await fetch(`${baseUrl}/api/public/shares/${created.token}`);
    assert.equal(expiredRes.status, 404);

    const unknownRes = await fetch(`${baseUrl}/api/public/shares/nonexistent-token`);
    assert.equal(unknownRes.status, 404);

    assert.deepEqual(await expiredRes.json(), await unknownRes.json());
  });
});

test('owner routes reject another user', async () => {
  await withShareTestServer(async ({ baseUrl, ownerId, otherUserId }) => {
    const createRes = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(ownerId),
      },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    const created = (await createRes.json()) as { id: string; token: string };

    // Another user cannot see active share by sessionId (404)
    const getByOther = await fetch(`${baseUrl}/api/shares?sessionId=${SESSION_ID}`, {
      headers: { 'x-test-user-id': String(otherUserId) },
    });
    assert.equal(getByOther.status, 404);

    // Another user cannot preview the owner's share (403)
    const previewByOther = await fetch(`${baseUrl}/api/shares/${created.id}/preview`, {
      headers: { 'x-test-user-id': String(otherUserId) },
    });
    assert.equal(previewByOther.status, 403);

    // Another user cannot PATCH the owner's share (403)
    const patchByOther = await fetch(`${baseUrl}/api/shares/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(otherUserId),
      },
      body: JSON.stringify({ title: 'Hacked title' }),
    });
    assert.equal(patchByOther.status, 403);

    // Another user cannot DELETE the owner's share (403)
    const deleteByOther = await fetch(`${baseUrl}/api/shares/${created.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user-id': String(otherUserId) },
    });
    assert.equal(deleteByOther.status, 403);

    // Owner's share still works unchanged
    const publicRes = await fetch(`${baseUrl}/api/public/shares/${created.token}`);
    assert.equal(publicRes.status, 200);
    const publicBody = (await publicRes.json()) as { title: string };
    assert.equal(publicBody.title, 'My Shared Session');
  });
});

test('public share endpoint enforces per-IP rate limiting with 429', async () => {
  await withShareTestServer(
    async ({ baseUrl, ownerId }) => {
      const createRes = await fetch(`${baseUrl}/api/shares`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-user-id': String(ownerId),
        },
        body: JSON.stringify({ sessionId: SESSION_ID }),
      });
      const created = (await createRes.json()) as { token: string };

      for (let i = 0; i < 3; i += 1) {
        const okRes = await fetch(`${baseUrl}/api/public/shares/${created.token}`);
        assert.equal(okRes.status, 200);
      }

      const rateLimitedRes = await fetch(`${baseUrl}/api/public/shares/${created.token}`);
      assert.equal(rateLimitedRes.status, 429);
      assert.ok(rateLimitedRes.headers.get('retry-after'));
    },
    { maxRequestsPerMinute: 3 },
  );
});

test('public rate limit keys on the forwarded address behind a local tunnel', async () => {
  await withShareTestServer(
    async ({ baseUrl, ownerId }) => {
      const createRes = await fetch(`${baseUrl}/api/shares`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-user-id': String(ownerId),
        },
        body: JSON.stringify({ sessionId: SESSION_ID }),
      });
      const created = (await createRes.json()) as { token: string };
      const fetchAs = (ip: string) => fetch(`${baseUrl}/api/public/shares/${created.token}`, {
        headers: { 'cf-connecting-ip': ip },
      });

      assert.equal((await fetchAs('203.0.113.1')).status, 200);
      assert.equal((await fetchAs('203.0.113.1')).status, 200);
      assert.equal((await fetchAs('203.0.113.1')).status, 429);
      assert.equal((await fetchAs('203.0.113.2')).status, 200);
    },
    { maxRequestsPerMinute: 2 },
  );
});

test('focusId is saved, returned on public payload when visible, null when hidden or unknown, and validated', async () => {
  await withShareTestServer(async ({ baseUrl, ownerId }) => {
    const createRes = await fetch(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(ownerId),
      },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    assert.equal(createRes.status, 200);
    const created = (await createRes.json()) as {
      id: string;
      token: string;
      focusId: string | null;
    };
    assert.equal(created.focusId, null);

    // Public payload has focusId: null initially.
    const initialPublicRes = await fetch(`${baseUrl}/api/public/shares/${created.token}`);
    const initialPublicBody = (await initialPublicRes.json()) as { focusId: string | null };
    assert.equal(initialPublicBody.focusId, null);

    // Set focusId to a visible item ('msg-a1').
    const setFocusRes = await fetch(`${baseUrl}/api/shares/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(ownerId),
      },
      body: JSON.stringify({ focusId: 'msg-a1' }),
    });
    assert.equal(setFocusRes.status, 200);
    const setFocusBody = (await setFocusRes.json()) as { focusId: string | null };
    assert.equal(setFocusBody.focusId, 'msg-a1');

    // Preview payload includes focusId: 'msg-a1'.
    const previewRes = await fetch(`${baseUrl}/api/shares/${created.id}/preview`, {
      headers: { 'x-test-user-id': String(ownerId) },
    });
    const previewBody = (await previewRes.json()) as { focusId: string | null };
    assert.equal(previewBody.focusId, 'msg-a1');

    // Public payload includes focusId: 'msg-a1'.
    const focusedPublicRes = await fetch(`${baseUrl}/api/public/shares/${created.token}`);
    const focusedPublicBody = (await focusedPublicRes.json()) as { focusId: string | null };
    assert.equal(focusedPublicBody.focusId, 'msg-a1');

    // Hiding the focused item makes public focusId null while owner focusId remains 'msg-a1'.
    const hideFocusedRes = await fetch(`${baseUrl}/api/shares/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(ownerId),
      },
      body: JSON.stringify({ hiddenIds: ['msg-a1'] }),
    });
    assert.equal(hideFocusedRes.status, 200);
    const hideFocusedOwner = (await hideFocusedRes.json()) as { focusId: string | null };
    assert.equal(hideFocusedOwner.focusId, 'msg-a1');

    const hiddenPublicRes = await fetch(`${baseUrl}/api/public/shares/${created.token}`);
    const hiddenPublicBody = (await hiddenPublicRes.json()) as { focusId: string | null };
    assert.equal(hiddenPublicBody.focusId, null);

    // Setting focusId to an unknown or filtered-out item makes public focusId null.
    const unknownFocusRes = await fetch(`${baseUrl}/api/shares/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(ownerId),
      },
      body: JSON.stringify({ hiddenIds: [], focusId: 'msg-think' }),
    });
    assert.equal(unknownFocusRes.status, 200);
    const unknownPublicRes = await fetch(`${baseUrl}/api/public/shares/${created.token}`);
    const unknownPublicBody = (await unknownPublicRes.json()) as { focusId: string | null };
    assert.equal(unknownPublicBody.focusId, null);

    // Clearing focusId with null sets owner focusId back to null.
    const clearFocusRes = await fetch(`${baseUrl}/api/shares/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(ownerId),
      },
      body: JSON.stringify({ focusId: null }),
    });
    assert.equal(clearFocusRes.status, 200);
    const clearFocusBody = (await clearFocusRes.json()) as { focusId: string | null };
    assert.equal(clearFocusBody.focusId, null);

    // Validation: focusId > 200 chars is rejected with 400.
    const tooLongRes = await fetch(`${baseUrl}/api/shares/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(ownerId),
      },
      body: JSON.stringify({ focusId: 'x'.repeat(201) }),
    });
    assert.equal(tooLongRes.status, 400);

    // Validation: non-string / non-null focusId is rejected with 400.
    const invalidTypeRes = await fetch(`${baseUrl}/api/shares/${created.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user-id': String(ownerId),
      },
      body: JSON.stringify({ focusId: 42 }),
    });
    assert.equal(invalidTypeRes.status, 400);
  });
});

test('migration adds focus_id to an existing session_shares table created without it', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'session-shares-migration-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'legacy.db');

  try {
    await initializeDatabase();
    const owner = userDb.createUser('owner', 'hash');
    sessionsDb.createAppSession('s-1', 'claude', tempDir, 'Legacy');

    const db = getConnection();
    db.exec(`
      DROP TABLE session_shares;
      CREATE TABLE session_shares (
        id TEXT PRIMARY KEY,
        token TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        title TEXT,
        hidden_ids TEXT NOT NULL DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME,
        expires_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
    `);
    db.prepare(`
      INSERT INTO session_shares (
        id, token, user_id, session_id, provider, title, hidden_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-share-1',
      'legacy_token_01234567890123456789012345678901',
      Number(owner.id),
      's-1',
      'claude',
      'Legacy Share',
      '[]',
    );

    const beforeColumns = (db.prepare('PRAGMA table_info(session_shares)').all() as Array<{ name: string }>)
      .map((col) => col.name);
    assert.ok(!beforeColumns.includes('focus_id'));

    await initializeDatabase();

    const afterColumns = (db.prepare('PRAGMA table_info(session_shares)').all() as Array<{ name: string }>)
      .map((col) => col.name);
    assert.ok(afterColumns.includes('focus_id'));

    const legacyRow = sessionSharesDb.getById('legacy-share-1');
    assert.ok(legacyRow);
    assert.equal(legacyRow.focus_id, null);
    assert.equal(legacyRow.mode, 'local');
    assert.equal(legacyRow.cloud_id, null);
    assert.equal(legacyRow.cloud_url, null);
    assert.equal(legacyRow.cloud_expires_at, null);
    assert.equal(legacyRow.cloud_synced_at, null);
    assert.equal(legacyRow.cloud_error, null);

    const updatedRow = sessionSharesDb.update('legacy-share-1', { focusId: 'msg-a2' });
    assert.ok(updatedRow);
    assert.equal(updatedRow.focus_id, 'msg-a2');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('cloud share lifecycle: no local public route, sync only PUTs on change, final PUT on run end, revoke DELETE with retry, errors surfaced', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'cloud-shares-test-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();

  try {
    let nowMs = Date.UTC(2026, 9, 9, 12, 0, 0);
    let isRunning = true;
    let historyMessages: NormalizedMessage[] = [...SAMPLE_HISTORY];
    let fetchHistoryCount = 0;

    const owner = userDb.createUser('owner', 'hash-1');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDir, 'Cloud Session');

    const consoleCalls: Array<{
      op: 'create' | 'update' | 'delete';
      cloudId?: string;
      payload?: ConsoleShareWritePayload;
    }> = [];
    let failNextCreate: Error | null = null;
    let failNextUpdate: Error | null = null;
    let failNextDelete: Error | null = null;

    const fakeConsoleClient: ConsoleShareClient = {
      getConfig: () => ({
        available: true,
        consoleUrl: 'http://127.0.0.1:8095',
        secret: 's'.repeat(48),
        reason: null,
      }),
      createShare: async (payload) => {
        consoleCalls.push({ op: 'create', payload });
        if (failNextCreate) {
          const err = failNextCreate;
          failNextCreate = null;
          throw err;
        }
        return {
          id: 'cloud-row-1',
          url: 'https://share.hemilake.com/s/cloud_tok_123',
          expiresAt: payload.expiresAt || '2026-11-08T12:00:00.000Z',
        };
      },
      updateShare: async (cloudId, payload) => {
        consoleCalls.push({ op: 'update', cloudId, payload });
        if (failNextUpdate) {
          const err = failNextUpdate;
          failNextUpdate = null;
          throw err;
        }
        return {
          id: cloudId,
          url: 'https://share.hemilake.com/s/cloud_tok_123',
          expiresAt: payload.expiresAt || '2026-11-08T12:00:00.000Z',
          updatedAt: new Date(nowMs).toISOString(),
        };
      },
      deleteShare: async (cloudId) => {
        consoleCalls.push({ op: 'delete', cloudId });
        if (failNextDelete) {
          const err = failNextDelete;
          failNextDelete = null;
          throw err;
        }
      },
    };

    const sessionsAdapter = {
      getById: (sessionId: string) => sessionsDb.getSessionById(sessionId) ?? undefined,
      fetchHistory: async () => {
        fetchHistoryCount += 1;
        return { messages: historyMessages };
      },
      isRunning: () => isRunning,
    };

    const cloudSync = createCloudShareSyncService({
      shares: {
        getById: (id) => sessionSharesDb.getById(id),
        listActiveCloudShares: (nowIso) => sessionSharesDb.listActiveCloudShares(nowIso),
        listPendingCloudDeletes: () => sessionSharesDb.listPendingCloudDeletes(),
        update: (id, updates) => sessionSharesDb.update(id, updates),
      },
      sessions: sessionsAdapter,
      consoleClient: fakeConsoleClient,
      now: () => nowMs,
    });

    const service = createShareService({
      shares: {
        create: (input) => sessionSharesDb.create(input),
        getById: (id) => sessionSharesDb.getById(id),
        getByToken: (token) => sessionSharesDb.getByToken(token),
        getActiveBySession: (userId, sessionId, nowIso) =>
          sessionSharesDb.getActiveBySession(userId, sessionId, nowIso),
        update: (id, updates) => sessionSharesDb.update(id, updates),
        revoke: (id, nowIso) => sessionSharesDb.revoke(id, nowIso),
      },
      sessions: sessionsAdapter,
      cloudSync,
      now: () => nowMs,
    });

    // 1. Create cloud share -> triggers immediate POST to console
    const created = await service.createOrGetShare(Number(owner.id), {
      sessionId: SESSION_ID,
      mode: 'cloud',
    });
    assert.equal(created.mode, 'cloud');
    assert.equal(created.cloudId, 'cloud-row-1');
    assert.equal(created.cloudUrl, 'https://share.hemilake.com/s/cloud_tok_123');
    assert.equal(created.url, 'https://share.hemilake.com/s/cloud_tok_123');
    assert.equal(created.cloudError, null);
    assert.equal(consoleCalls.length, 1);
    assert.equal(consoleCalls[0].op, 'create');
    assert.equal(consoleCalls[0].payload?.running, true);
    assert.equal(consoleCalls[0].payload?.items.length, 4);

    // 2. Cloud share has NO local public route: getPublicShare throws 404
    await assert.rejects(
      () => service.getPublicShare(created.token),
      (err: unknown) => err instanceof AppError && err.statusCode === 404,
    );

    // 3. Periodic tick while running with NO content change -> does NOT PUT
    nowMs += 5_000;
    await cloudSync.tick();
    assert.equal(consoleCalls.length, 1);

    // 4. New user prompt arrives while running -> tick hashes payload and PUTs once
    historyMessages = [
      ...SAMPLE_HISTORY,
      {
        id: 'msg-u3',
        sessionId: SESSION_ID,
        timestamp: '2026-10-09T12:00:10.000Z',
        provider: 'claude',
        kind: 'text',
        role: 'user',
        content: 'Follow-up question while running',
      },
    ];
    nowMs += 5_000;
    await cloudSync.tick();
    assert.equal(consoleCalls.length, 2);
    assert.equal(consoleCalls[1].op, 'update');
    assert.equal(consoleCalls[1].payload?.items.length, 5);
    assert.equal(consoleCalls[1].payload?.running, true);

    // 5. Run ends (`running: false`) -> tick performs one final PUT with `running: false`
    isRunning = false;
    nowMs += 5_000;
    await cloudSync.tick();
    assert.equal(consoleCalls.length, 3);
    assert.equal(consoleCalls[2].op, 'update');
    assert.equal(consoleCalls[2].payload?.running, false);

    // 6. Subsequent ticks when not running and session updated_at unchanged -> skips fetchHistory and PUT
    const historyFetchesBeforeIdleTick = fetchHistoryCount;
    nowMs += 5_000;
    await cloudSync.tick();
    assert.equal(fetchHistoryCount, historyFetchesBeforeIdleTick);
    assert.equal(consoleCalls.length, 3);

    // 7. Owner metadata change (hide item + focus) -> immediate PUT; if console errors, error lands in cloudError
    failNextUpdate = new ConsoleShareError(
      'feature_not_licensed',
      'Your Hemilake licence does not include Studio cloud shares (hemilake.studio.share).',
      403,
    );
    const updatedWithError = await service.updateShare(Number(owner.id), created.id, {
      hiddenIds: ['msg-u2'],
      focusId: 'msg-a1',
    });
    assert.equal(consoleCalls.length, 4);
    assert.ok(updatedWithError.cloudError?.includes('hemilake.studio.share'));

    // Next tick retries because cloud_error is set, and clears cloudError on success
    nowMs += 5_000;
    await cloudSync.tick();
    assert.equal(consoleCalls.length, 5);
    const afterRecovery = service.getActiveShareBySession(Number(owner.id), SESSION_ID);
    assert.equal(afterRecovery.cloudError, null);

    // 8. Revoke when console is down -> revokes locally immediately, retains cloud_id, and retries DELETE on next tick
    failNextDelete = new ConsoleShareError('admin_unreachable', 'Console down', 502);
    await service.revokeShare(Number(owner.id), created.id);
    assert.equal(consoleCalls.length, 6);
    assert.equal(consoleCalls[5].op, 'delete');

    // Locally revoked immediately
    assert.throws(
      () => service.getActiveShareBySession(Number(owner.id), SESSION_ID),
      (err: unknown) => err instanceof AppError && err.statusCode === 404,
    );
    // Pending cloud delete remains queued because first DELETE failed
    assert.equal(sessionSharesDb.listPendingCloudDeletes().length, 1);

    // Next tick retries DELETE and clears cloud_id
    nowMs += 5_000;
    await cloudSync.tick();
    assert.equal(consoleCalls.length, 7);
    assert.equal(consoleCalls[6].op, 'delete');
    assert.equal(sessionSharesDb.listPendingCloudDeletes().length, 0);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('readCloudShareConfig and createConsoleShareClient sign valid Studio assertions and map console error codes', async () => {
  const missingCfg = readCloudShareConfig({});
  assert.equal(missingCfg.available, false);
  assert.equal(missingCfg.reason, 'Needs Hemilake: open Studio from your Hemilake console');

  const validEnv = {
    CLOUDCLI_CONSOLE_URL: 'http://127.0.0.1:8095/',
    CLOUDCLI_EMBED_SECRET: 'k'.repeat(48),
  };
  const validCfg = readCloudShareConfig(validEnv);
  assert.equal(validCfg.available, true);
  assert.equal(validCfg.consoleUrl, 'http://127.0.0.1:8095');

  const jwt = signStudioConsoleAssertion('k'.repeat(48), 1_791_500_000_000, 'jti-test-1');
  const [headerB64, claimsB64, sigB64] = jwt.split('.');
  assert.ok(headerB64 && claimsB64 && sigB64);
  const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.equal(claims.iss, 'hemilake-studio');
  assert.equal(claims.aud, 'hemilake-console');
  assert.equal(claims.jti, 'jti-test-1');
  assert.equal(Number(claims.exp) - Number(claims.iat), 60);

  let seenAuthHeader = '';
  const client = createConsoleShareClient({
    env: validEnv,
    now: () => 1_791_500_000_000,
    fetchImpl: async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      seenAuthHeader = headers.Authorization;
      return new Response(
        JSON.stringify({ code: 'feature_not_licensed', detail: 'Not licensed' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  await assert.rejects(
    () =>
      client.createShare({
        title: 'Test',
        items: [],
        focusId: null,
        running: false,
        expiresAt: null,
      }),
    (err: unknown) =>
      err instanceof ConsoleShareError &&
      err.code === 'feature_not_licensed' &&
      err.statusCode === 403,
  );
  assert.ok(seenAuthHeader.startsWith('Studio '));
});
