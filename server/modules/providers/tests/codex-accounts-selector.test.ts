import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planWeight,
  remainingPercent,
  requiredHeadroomFor,
  selectCodexAccount,
} from '@/modules/providers/list/codex/accounts/codex-accounts.selector.js';
import type {
  CodexAccountRecord,
  CodexAccountsRegistry,
  CodexAccountUsage,
} from '@/modules/providers/list/codex/accounts/codex-accounts.types.js';

const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);
const IN_A_DAY = NOW + 86_400_000;

function account(id: string, enabled = true): CodexAccountRecord {
  return { id, label: id, codexHome: `/homes/${id}`, enabled, createdAt: '2026-10-26T00:00:00Z' };
}

function registry(overrides: Partial<CodexAccountsRegistry> = {}): CodexAccountsRegistry {
  return {
    version: 1,
    mode: 'backup',
    primaryAccountId: 'default',
    minHeadroomPercent: 5,
    planWeights: {},
    roundRobinCursor: null,
    accounts: [account('default'), account('b'), account('c')],
    ...overrides,
  };
}

function usage(usedPercent: number, overrides: Partial<CodexAccountUsage> = {}): CodexAccountUsage {
  return {
    fetchedAt: NOW,
    signedIn: true,
    email: null,
    planType: 'plus',
    windows: [{ usedPercent, windowDurationMins: 10080, resetsAt: IN_A_DAY }],
    reachedType: null,
    error: null,
    exhaustedUntil: null,
    ...overrides,
  };
}

const select = (reg: CodexAccountsRegistry, map: Record<string, CodexAccountUsage>, extra: {
  currentAccountId?: string | null;
  effort?: string;
  exclude?: Set<string>;
} = {}) => selectCodexAccount({
  registry: reg,
  usage: new Map(Object.entries(map)),
  currentAccountId: extra.currentAccountId ?? null,
  effort: extra.effort,
  exclude: extra.exclude,
  now: NOW,
});

test('a lone account is always picked without looking at usage', () => {
  const result = select(registry({ accounts: [account('default')] }), { default: usage(100) });
  assert.deepEqual(result, { accountId: 'default', reason: 'single', switchedFrom: null });
});

test('backup mode uses the primary while it has room, then falls through in order', () => {
  const reg = registry({ primaryAccountId: 'b' });
  assert.equal(select(reg, { default: usage(10), b: usage(50), c: usage(0) }).accountId, 'b');

  const fallthrough = select(reg, { default: usage(10), b: usage(99), c: usage(0) });
  assert.equal(fallthrough.accountId, 'default');
  assert.equal(fallthrough.reason, 'backup');
});

test('a session stays on its account until that account runs out', () => {
  const reg = registry();
  const sticky = select(reg, { default: usage(0), b: usage(80) }, { currentAccountId: 'b' });
  assert.deepEqual(sticky, { accountId: 'b', reason: 'sticky', switchedFrom: null });

  const moved = select(reg, { default: usage(0), b: usage(100) }, { currentAccountId: 'b' });
  assert.equal(moved.accountId, 'default');
  assert.equal(moved.switchedFrom, 'b');
});

test('round robin hands each new session to the next account with room', () => {
  const map = { default: usage(0), b: usage(100), c: usage(0) };
  const first = select(registry({ mode: 'round_robin' }), map);
  assert.equal(first.accountId, 'default');
  // b is out of room, so the rotation skips it.
  assert.equal(select(registry({ mode: 'round_robin', roundRobinCursor: 'default' }), map).accountId, 'c');
  assert.equal(select(registry({ mode: 'round_robin', roundRobinCursor: 'c' }), map).accountId, 'default');
});

test('higher effort needs more headroom, and plan size scales headroom', () => {
  // 8 % left: enough for medium (5), not for xhigh (15) on Plus.
  const reg = registry({ accounts: [account('default'), account('b')] });
  const map = { default: usage(92), b: usage(50) };
  assert.equal(select(reg, map, { effort: 'medium' }).accountId, 'default');
  assert.equal(select(reg, map, { effort: 'xhigh' }).accountId, 'b');

  // The same 8 % on Pro is 48 Plus-points of room.
  const pro = { default: usage(92, { planType: 'pro' }), b: usage(50) };
  assert.equal(select(reg, pro, { effort: 'xhigh' }).accountId, 'default');
  assert.equal(requiredHeadroomFor('xhigh', 5), 15);
});

test('signed-out, disabled and excluded accounts are skipped', () => {
  const reg = registry({ accounts: [account('default'), account('b', false), account('c')] });
  const map = { default: usage(0, { signedIn: false }), b: usage(0), c: usage(40) };
  assert.equal(select(reg, map).accountId, 'c');
  assert.equal(select(reg, map, { exclude: new Set(['c']) }).reason, 'fallback');
});

test('an unread account is tried rather than skipped', () => {
  const reg = registry({ accounts: [account('default'), account('b')], primaryAccountId: 'b' });
  assert.equal(select(reg, { default: usage(0) }).accountId, 'b');
});

test('with nobody left, the account with the most weighted room runs the turn', () => {
  const reg = registry();
  const result = select(reg, { default: usage(99), b: usage(97), c: usage(100) }, { effort: 'xhigh' });
  assert.deepEqual(result, { accountId: 'b', reason: 'fallback', switchedFrom: null });
});

test('reached limits, marked exhaustion and elapsed windows are read correctly', () => {
  assert.equal(remainingPercent(usage(20, { reachedType: 'primary' }), NOW), 0);
  assert.equal(remainingPercent(usage(20, { exhaustedUntil: NOW + 1000 }), NOW), 0);
  assert.equal(remainingPercent(usage(20, { exhaustedUntil: NOW - 1000 }), NOW), 80);
  const reset = usage(100, { windows: [{ usedPercent: 100, windowDurationMins: 300, resetsAt: NOW - 1 }] });
  assert.equal(remainingPercent(reset, NOW), 100);
  assert.equal(remainingPercent(undefined, NOW), null);
});

test('plan weights match compound plan names and honour overrides', () => {
  assert.equal(planWeight('pro'), 6);
  assert.equal(planWeight('self_serve_business_prolite'), 1);
  assert.equal(planWeight('self_serve_business_prolite', { self_serve_business_prolite: 3 }), 3);
  assert.equal(planWeight('mystery'), 1);
  assert.equal(planWeight(null), 1);
});
