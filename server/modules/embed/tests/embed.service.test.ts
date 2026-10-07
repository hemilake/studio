import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import {
  createEmbedService,
  EMBED_ASSERTION_AUDIENCE,
  EMBED_ASSERTION_MAX_AGE_S,
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
      createConsoleOwner: () => assert.fail('only console-only mode creates an account'),
      updateLastLogin: () => undefined,
    },
    generateToken: (user) => `studio-token-for-${user.username}`,
    now: () => NOW,
    ...overrides,
  };
}

function assertRefused(action: () => unknown, code: string, statusCode: number) {
  assert.throws(action, (error: unknown) => {
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

test('a valid assertion signs in the first user and records the login', () => {
  const logins: number[] = [];
  const service = createEmbedService(createDependencies({
    users: {
      getFirstUser: () => ({ id: 7, username: 'owner' }),
      createConsoleOwner: () => assert.fail('an existing account is reused'),
      updateLastLogin: (userId) => logins.push(userId),
    },
  }));

  assert.deepEqual(service.exchange(sign()), {
    success: true,
    user: { id: 7, username: 'owner' },
    token: 'studio-token-for-owner',
  });
  assert.deepEqual(logins, [7]);
});

test('an assertion is good once', () => {
  const service = createEmbedService(createDependencies());
  service.exchange(sign({ jti: 'once' }));
  assertRefused(() => service.exchange(sign({ jti: 'once' })), 'EMBED_ASSERTION_REPLAYED', 401);
});

test('wrong secret, audience, issuer, age or a missing jti are refused alike', () => {
  const service = createEmbedService(createDependencies());
  const iat = Math.floor(NOW / 1000);
  for (const assertion of [
    sign({}, 'another-secret-another-secret-another'),
    sign({ aud: 'someone-else' }),
    sign({ iss: 'https://evil.example' }),
    sign({ iat: iat - 600, exp: iat - 300 }),
    sign({ iat: iat - 3600, exp: iat + 3600 }),
    sign({ jti: undefined }),
  ]) {
    assertRefused(() => service.exchange(assertion), 'EMBED_ASSERTION_INVALID', 401);
  }
});

test('garbage is a bad request, not a verification attempt', () => {
  let verified = false;
  const service = createEmbedService(createDependencies({
    verifyAssertion: () => {
      verified = true;
      return {};
    },
  }));
  assertRefused(() => service.exchange('not-a-jwt'), 'EMBED_ASSERTION_REQUIRED', 400);
  assertRefused(() => service.exchange(undefined), 'EMBED_ASSERTION_REQUIRED', 400);
  assert.equal(verified, false);
});

test('without origins or a secret the exchange does not exist', () => {
  const noSecret = createEmbedService(createDependencies({ readConfig: () => ({ origins: [CONSOLE], secret: null, only: false }) }));
  assertRefused(() => noSecret.exchange(sign()), 'EMBED_EXCHANGE_DISABLED', 404);
  const noOrigins = createEmbedService(createDependencies({ readConfig: () => ({ origins: [], secret: SECRET, only: false }) }));
  assertRefused(() => noOrigins.exchange(sign()), 'EMBED_EXCHANGE_DISABLED', 404);
});

test('an instance without an account answers 409 so the client can fall back to setup', () => {
  const service = createEmbedService(createDependencies({
    users: {
      getFirstUser: () => undefined,
      createConsoleOwner: () => assert.fail('only console-only mode creates an account'),
      updateLastLogin: () => undefined,
    },
  }));
  assertRefused(() => service.exchange(sign()), 'EMBED_NO_USER', 409);
});

test('console-only mode says so in the public config', () => {
  const service = createEmbedService(createDependencies({
    readConfig: () => ({ origins: [CONSOLE], secret: SECRET, only: true }),
  }));
  assert.deepEqual(service.getPublicConfig(), { origins: [CONSOLE], exchange: true, only: true });
});

test('console-only mode creates the account on the first valid assertion, and reuses it after', () => {
  const accounts: { id: number; username: string }[] = [];
  const service = createEmbedService(createDependencies({
    readConfig: () => ({ origins: [CONSOLE], secret: SECRET, only: true }),
    users: {
      getFirstUser: () => accounts[0],
      createConsoleOwner: () => {
        accounts.push({ id: 1, username: 'owner' });
        return accounts[0];
      },
      updateLastLogin: () => undefined,
    },
  }));

  assert.equal(service.exchange(sign({ jti: 'first' })).token, 'studio-token-for-owner');
  assert.equal(service.exchange(sign({ jti: 'second' })).token, 'studio-token-for-owner');
  assert.equal(accounts.length, 1);
});

test('console-only mode creates nothing for an assertion it refuses', () => {
  const service = createEmbedService(createDependencies({
    readConfig: () => ({ origins: [CONSOLE], secret: SECRET, only: true }),
    users: {
      getFirstUser: () => undefined,
      createConsoleOwner: () => assert.fail('a refused assertion creates no account'),
      updateLastLogin: () => undefined,
    },
  }));
  assertRefused(() => service.exchange(sign({}, 'x'.repeat(48))), 'EMBED_ASSERTION_INVALID', 401);
});
