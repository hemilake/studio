import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';

import { checkEdgeSession, resetEdgeSessionStateForTests } from '@/shared/edgeSession';

/**
 * Fork (edge session): the page reloads only when the proxy redirects
 * /health to its login, at most once a minute, and never inside a frame.
 */

const opaqueRedirect = () => ({ type: 'opaqueredirect' }) as Response;
const ok = () => ({ type: 'basic', status: 200 }) as Response;

const makeDeps = (respond: () => Response | Promise<Response>, overrides: { framed?: boolean; now?: number } = {}) => {
  const store = new Map<string, string>();
  let clock = overrides.now ?? 1_000_000;
  const deps = {
    fetch: vi.fn(async () => respond()) as unknown as typeof fetch,
    now: () => clock,
    reload: vi.fn(),
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
    framed: overrides.framed ?? false,
  };
  return { deps, advance: (ms: number) => { clock += ms; } };
};

beforeEach(() => {
  resetEdgeSessionStateForTests();
});

test('reloads when the proxy redirects the probe', async () => {
  const { deps } = makeDeps(opaqueRedirect);
  assert.equal(await checkEdgeSession(deps), true);
  assert.equal(deps.reload.mock.calls.length, 1);
  const init = (deps.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
  assert.equal(init.redirect, 'manual');
});

test('does nothing when the probe answers', async () => {
  const { deps } = makeDeps(ok);
  assert.equal(await checkEdgeSession(deps), false);
  assert.equal(deps.reload.mock.calls.length, 0);
});

test('does nothing when the network is down', async () => {
  const { deps } = makeDeps(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.equal(await checkEdgeSession(deps), false);
  assert.equal(deps.reload.mock.calls.length, 0);
});

test('never reloads inside a frame', async () => {
  const { deps } = makeDeps(opaqueRedirect, { framed: true });
  assert.equal(await checkEdgeSession(deps), false);
  assert.equal((deps.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length, 0);
});

test('concurrent checks share one probe and throttle the next', async () => {
  const { deps, advance } = makeDeps(ok);
  await Promise.all([checkEdgeSession(deps), checkEdgeSession(deps), checkEdgeSession(deps)]);
  advance(5_000);
  await checkEdgeSession(deps);
  assert.equal((deps.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  advance(15_000);
  await checkEdgeSession(deps);
  assert.equal((deps.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length, 2);
});

test('does not reload again within a minute of the last reload', async () => {
  const { deps, advance } = makeDeps(opaqueRedirect);
  assert.equal(await checkEdgeSession(deps), true);
  advance(20_000);
  assert.equal(await checkEdgeSession(deps), false);
  advance(45_000);
  assert.equal(await checkEdgeSession(deps), true);
  assert.equal(deps.reload.mock.calls.length, 2);
});
