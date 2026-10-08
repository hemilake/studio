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
  initializeDatabase,
  sessionSharesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createPublicShareRouter, createShareRouter } from '../share.routes.js';
import { createShareService } from '../share.service.js';

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
