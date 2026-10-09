import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import {
  createEmbedService,
  EMBED_ASSERTION_AUDIENCE,
  EMBED_ASSERTION_MAX_AGE_S,
  readConsoleIdentity,
} from '../embed.service.js';

type EmbedDependencies = Parameters<typeof createEmbedService>[0];

// jsonwebtoken has no declarations in this project; type the two calls the tests make.
const jwt = createRequire(import.meta.url)('jsonwebtoken') as {
  sign(payload: Record<string, unknown>, secret: string, options: { algorithm: string }): string;
  verify(token: string, secret: string, options: Record<string, unknown>): string | Record<string, unknown>;
};

const SECRET = 's'.repeat(48);
const CONSOLE = 'https://lake.example.com';
const NOW = Date.UTC(2026, 9, 7, 10, 0, 0);

// The same verification the module composes, so the tests exercise real signatures.
const verifyAssertion: EmbedDependencies['verifyAssertion'] = (assertion, secret, issuers) => {
  const claims = jwt.verify(assertion, secret, {
    algorithms: ['HS256'],
    audience: EMBED_ASSERTION_AUDIENCE,
    issuer: issuers,
    maxAge: `${EMBED_ASSERTION_MAX_AGE_S}s`,
    clockTimestamp: Math.floor(NOW / 1000),
    clockTolerance: 30,
  });
  return typeof claims === 'string' ? {} : claims;
};

function sign(claims: Record<string, unknown> = {}, secret = SECRET): string {
  const iat = Math.floor(NOW / 1000);
  return jwt.sign(
    { aud: EMBED_ASSERTION_AUDIENCE, iss: CONSOLE, sub: 'owner', jti: 'j-1', iat, exp: iat + 60, ...claims },
    secret,
    { algorithm: 'HS256' },
  );
}

function createDependencies(overrides: Partial<EmbedDependencies> = {}): EmbedDependencies {
  return {
    readConfig: () => ({ origins: [CONSOLE], secret: SECRET, only: false }),
    verifyAssertion,
    users: {
      getFirstUser: () => ({ id: 7, username: 'owner' }),
      createConsoleOwner: () => assert.fail('an existing account is reused'),
      updateLastLogin: () => undefined,
      seedGitIdentity: async () => undefined,
    },
    generateToken: (user) => `studio-token-for-${user.username}`,
    now: () => NOW,
    ...overrides,
  };
}

async function assertRefused(action: () => Promise<unknown>, code: string, statusCode: number) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  });
}

test('public config says whether the exchange is usable without revealing the secret', () => {
  assert.deepEqual(createEmbedService(createDependencies()).getPublicConfig(), { origins: [CONSOLE], exchange: true, only: false });
  assert.deepEqual(
    createEmbedService(createDependencies({ readConfig: () => ({ origins: [CONSOLE], secret: null, only: false }) })).getPublicConfig(),
    { origins: [CONSOLE], exchange: false, only: false },
  );
  assert.deepEqual(
    createEmbedService(createDependencies({ readConfig: () => ({ origins: [], secret: SECRET, only: false }) })).getPublicConfig(),
    { origins: [], exchange: false, only: false },
  );
});

test('a valid assertion signs in the first user and records the login', async () => {
  const logins: number[] = [];
  const service = createEmbedService(createDependencies({
    users: {
      getFirstUser: () => ({ id: 7, username: 'owner' }),
      createConsoleOwner: () => assert.fail('an existing account is reused'),
      updateLastLogin: (userId) => logins.push(userId),
      seedGitIdentity: async () => assert.fail('an assertion without a name and e-mail seeds nothing'),
    },
  }));

  assert.deepEqual(await service.exchange(sign()), {
    success: true,
    user: { id: 7, username: 'owner' },
    token: 'studio-token-for-owner',
  });
  assert.deepEqual(logins, [7]);
});

test('an assertion is good once', async () => {
  const service = createEmbedService(createDependencies());
  await service.exchange(sign({ jti: 'once' }));
  await assertRefused(() => service.exchange(sign({ jti: 'once' })), 'EMBED_ASSERTION_REPLAYED', 401);
});

test('wrong secret, audience, issuer, age, a missing or oversized jti are refused alike', async () => {
  const service = createEmbedService(createDependencies());
  const iat = Math.floor(NOW / 1000);
  for (const assertion of [
    sign({}, 'another-secret-another-secret-another'),
    sign({ aud: 'someone-else' }),
    sign({ iss: 'https://evil.example' }),
    sign({ iat: iat - 600, exp: iat - 300 }),
    sign({ iat: iat - 3600, exp: iat + 3600 }),
    sign({ jti: undefined }),
    sign({ jti: 'j'.repeat(129) }),
  ]) {
    await assertRefused(() => service.exchange(assertion), 'EMBED_ASSERTION_INVALID', 401);
  }
});

test('garbage is a bad request, not a verification attempt', async () => {
  let verified = false;
  const service = createEmbedService(createDependencies({
    verifyAssertion: () => {
      verified = true;
      return {};
    },
  }));
  await assertRefused(() => service.exchange('not-a-jwt'), 'EMBED_ASSERTION_REQUIRED', 400);
  await assertRefused(() => service.exchange(undefined), 'EMBED_ASSERTION_REQUIRED', 400);
  assert.equal(verified, false);
});

test('without origins or a secret the exchange does not exist', async () => {
  const noSecret = createEmbedService(createDependencies({ readConfig: () => ({ origins: [CONSOLE], secret: null, only: false }) }));
  await assertRefused(() => noSecret.exchange(sign()), 'EMBED_EXCHANGE_DISABLED', 404);
  const noOrigins = createEmbedService(createDependencies({ readConfig: () => ({ origins: [], secret: SECRET, only: false }) }));
  await assertRefused(() => noOrigins.exchange(sign()), 'EMBED_EXCHANGE_DISABLED', 404);
});

for (const only of [false, true]) {
  test(`the first valid assertion creates the account and reuses it after (console-only ${only})`, async () => {
    const accounts: { id: number; username: string }[] = [];
    const service = createEmbedService(createDependencies({
      readConfig: () => ({ origins: [CONSOLE], secret: SECRET, only }),
      users: {
        getFirstUser: () => accounts[0],
        createConsoleOwner: () => {
          accounts.push({ id: 1, username: 'owner' });
          return accounts[0];
        },
        updateLastLogin: () => undefined,
        seedGitIdentity: async () => undefined,
      },
    }));

    assert.equal((await service.exchange(sign({ jti: 'first' }))).token, 'studio-token-for-owner');
    assert.equal((await service.exchange(sign({ jti: 'second' }))).token, 'studio-token-for-owner');
    assert.equal(accounts.length, 1);
  });
}

test('console-only mode says so in the public config', () => {
  const service = createEmbedService(createDependencies({
    readConfig: () => ({ origins: [CONSOLE], secret: SECRET, only: true }),
  }));
  assert.deepEqual(service.getPublicConfig(), { origins: [CONSOLE], exchange: true, only: true });
});

test('a refused assertion creates no account and seeds nothing', async () => {
  for (const only of [false, true]) {
    const service = createEmbedService(createDependencies({
      readConfig: () => ({ origins: [CONSOLE], secret: SECRET, only }),
      users: {
        getFirstUser: () => undefined,
        createConsoleOwner: () => assert.fail('a refused assertion creates no account'),
        updateLastLogin: () => undefined,
        seedGitIdentity: async () => assert.fail('a refused assertion seeds nothing'),
      },
    }));
    await assertRefused(
      () => service.exchange(sign({ name: 'Alice', email: 'alice@example.com' }, 'x'.repeat(48))),
      'EMBED_ASSERTION_INVALID',
      401,
    );
  }
});

test('the name and e-mail an assertion carries seed the git identity before the answer', async () => {
  const seeded: unknown[] = [];
  const service = createEmbedService(createDependencies({
    users: {
      getFirstUser: () => ({ id: 7, username: 'owner' }),
      createConsoleOwner: () => assert.fail('an existing account is reused'),
      updateLastLogin: () => undefined,
      seedGitIdentity: async (userId, identity) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seeded.push([userId, identity]);
      },
    },
  }));

  await service.exchange(sign({ name: ' Alice Example ', email: 'alice@example.com' }));
  assert.deepEqual(seeded, [[7, { name: 'Alice Example', email: 'alice@example.com' }]]);
});

test('an identity is only read when both values are there and look right', () => {
  const ok = { name: 'Alice', email: 'alice@example.com' };
  assert.deepEqual(readConsoleIdentity(ok), ok);
  for (const claims of [
    {},
    { name: 'Alice' },
    { email: 'alice@example.com' },
    { name: '', email: 'alice@example.com' },
    { name: 'Alice', email: 'not-an-email' },
    { name: 'Alice\n[core]\n\tsshCommand = evil', email: 'alice@example.com' },
    { name: 'Alice', email: 'alice@example.com\r\n' + 'x' },
    { name: '--global', email: 'alice@example.com' },
    { name: 'Alice', email: '-x@example.com' },
    { name: 'A'.repeat(201), email: 'alice@example.com' },
    { name: 'Alice', email: `${'a'.repeat(250)}@example.com` },
    { name: 42, email: 'alice@example.com' },
  ]) {
    assert.equal(readConsoleIdentity(claims), null, JSON.stringify(claims));
  }
});
