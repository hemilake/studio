import assert from 'node:assert/strict';
import test from 'node:test';

import { createUserService } from '../user.service.js';

type UserDependencies = Parameters<typeof createUserService>[0];

function createDependencies(overrides: Partial<UserDependencies> = {}): UserDependencies {
  return {
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: () => undefined,
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    preferences: {
      getPreferences: () => ({}),
      savePreferences: () => undefined,
    },
    drafts: {
      getDrafts: () => [],
      saveDraft: () => undefined,
      deleteDraft: () => undefined,
    },
    readSystemGitConfig: async () => ({ git_name: null, git_email: null }),
    applyGlobalGitConfig: async () => undefined,
    applyGlobalGitValue: async () => undefined,
    logInfo: () => undefined,
    logError: () => undefined,
    ...overrides,
  };
}

test('getGitConfig imports system configuration when the repository is empty', async () => {
  const updates: unknown[][] = [];
  const service = createUserService(createDependencies({
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: (...args) => updates.push(args),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    readSystemGitConfig: async () => ({ git_name: 'Alice', git_email: 'alice@example.com' }),
  }));

  const result = await service.getGitConfig(7);

  assert.equal(result.gitName, 'Alice');
  assert.deepEqual(updates, [[7, 'Alice', 'alice@example.com']]);
});

test('updateGitConfig persists valid input and invokes the Git adapter', async () => {
  const operations: string[] = [];
  const service = createUserService(createDependencies({
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: (_id, name, email) => operations.push(`persist:${name}:${email}`),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    applyGlobalGitConfig: async (name, email) => {
      operations.push(`git:${name}:${email}`);
    },
  }));

  await service.updateGitConfig(1, 'Alice', 'alice@example.com');
  assert.deepEqual(operations, [
    'persist:Alice:alice@example.com',
    'git:Alice:alice@example.com',
  ]);
});

test('seedGitIdentity fills an empty account and the machine git from the console', async () => {
  const operations: string[] = [];
  const service = createUserService(createDependencies({
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: (_id, name, email) => operations.push(`persist:${name}:${email}`),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    applyGlobalGitValue: async (key, value) => {
      operations.push(`git:${key}:${value}`);
    },
  }));

  await service.seedGitIdentity(4, { name: 'Alice', email: 'alice@example.com' });
  assert.deepEqual(operations, [
    'persist:Alice:alice@example.com',
    'git:user.name:Alice',
    'git:user.email:alice@example.com',
  ]);
});

test('seedGitIdentity never replaces the identity the machine git already has', async () => {
  const operations: string[] = [];
  const service = createUserService(createDependencies({
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: (_id, name, email) => operations.push(`persist:${name}:${email}`),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    readSystemGitConfig: async () => ({ git_name: 'Own Name', git_email: null }),
    applyGlobalGitValue: async (key, value) => {
      operations.push(`git:${key}:${value}`);
    },
  }));

  await service.seedGitIdentity(4, { name: 'Alice', email: 'alice@example.com' });
  assert.deepEqual(operations, [
    'persist:Own Name:alice@example.com',
    'git:user.email:alice@example.com',
  ]);
});

test('seedGitIdentity leaves an account that has an identity alone, and never throws', async () => {
  const operations: string[] = [];
  const kept = createUserService(createDependencies({
    users: {
      getGitConfig: () => ({ git_name: 'Kept', git_email: 'kept@example.com' }),
      updateGitConfig: () => operations.push('persist'),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    readSystemGitConfig: async () => {
      operations.push('read');
      return { git_name: null, git_email: null };
    },
  }));
  await kept.seedGitIdentity(4, { name: 'Alice', email: 'alice@example.com' });
  assert.deepEqual(operations, []);

  const errors: string[] = [];
  const failing = createUserService(createDependencies({
    readSystemGitConfig: async () => {
      throw new Error('no git');
    },
    logError: (message) => errors.push(message),
  }));
  await failing.seedGitIdentity(4, { name: 'Alice', email: 'alice@example.com' });
  assert.equal(errors.length, 1);
});

test('savePreferences forwards only the keys the client sent', () => {
  const saved: Array<Record<string, unknown>> = [];
  const service = createUserService(createDependencies({
    preferences: {
      getPreferences: () => ({ theme: 'dark' }),
      savePreferences: (_id, updates) => saved.push(updates),
    },
  }));

  const result = service.savePreferences(3, { theme: 'light' });

  assert.deepEqual(saved, [{ theme: 'light' }]);
  assert.deepEqual(result.preferences, { theme: 'dark' });
});

test('savePreferences rejects a non-object body', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.savePreferences(3, ['theme']), /object/i);
  assert.throws(() => service.savePreferences(3, 'theme'), /object/i);
});

test('savePreferences rejects an over-long preference key', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.savePreferences(3, { ['k'.repeat(201)]: 1 }), /1-200/);
});

test('saveDraft stores the text and queued message under the given scope', () => {
  const saved: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: {
      getDrafts: () => [],
      saveDraft: (...args) => saved.push(args),
      deleteDraft: () => undefined,
    },
  }));

  service.saveDraft(5, 'session-1', {
    scope: 'session-1',
    text: 'half a thought',
    queuedMessage: { content: 'later' },
  });

  assert.deepEqual(saved, [[5, 'session-1', {
    text: 'half a thought',
    queuedMessage: { content: 'later' },
  }]]);
});

test('saveDraft defaults a missing queued message to null rather than dropping the row', () => {
  const saved: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: {
      getDrafts: () => [],
      saveDraft: (...args) => saved.push(args),
      deleteDraft: () => undefined,
    },
  }));

  service.saveDraft(5, 'session-1', { scope: 'session-1', text: 'typing' });

  assert.deepEqual(saved, [[5, 'session-1', { text: 'typing', queuedMessage: null }]]);
});

test('saveDraft rejects a blank or over-long scope', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.saveDraft(5, '   ', { text: 'x' }), /scope/i);
  assert.throws(() => service.saveDraft(5, 'x'.repeat(201), { text: 'x' }), /scope/i);
});

test('saveDraft rejects text past the storage limit', () => {
  const service = createUserService(createDependencies());

  assert.throws(
    () => service.saveDraft(5, 'session-1', { text: 'x'.repeat(100_001) }),
    /too long/i,
  );
});
