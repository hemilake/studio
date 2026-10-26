import assert from 'node:assert/strict';
import test from 'node:test';

import { isUsageLimitMessage } from '@/modules/providers/list/codex/accounts/codex-accounts.service.js';
import type { CodexAccountRecord } from '@/modules/providers/list/codex/accounts/codex-accounts.types.js';
import {
  CodexAccountUsageTracker,
  normalizeAccountSnapshot,
} from '@/modules/providers/list/codex/accounts/codex-accounts.usage.js';

// Shape returned by codex-cli 0.153.4 on 2026-10-26 (email redacted).
const SNAPSHOT = {
  account: { account: { type: 'chatgpt', email: 'someone@example.com', planType: 'self_serve_business_prolite' }, requiresOpenaiAuth: true },
  rateLimits: {
    rateLimits: { limitId: 'codex', primary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: 1793600788 } },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        primary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: 1793600788 },
        secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1793500000 },
        planType: 'self_serve_business_prolite',
        rateLimitReachedType: null,
      },
    },
  },
};

const ACCOUNT: CodexAccountRecord = { id: 'acct-1', label: 'One', codexHome: '/homes/one', enabled: true, createdAt: '' };

test('an app-server snapshot becomes windows, plan and email', () => {
  const usage = normalizeAccountSnapshot(SNAPSHOT, 1000);
  assert.equal(usage.signedIn, true);
  assert.equal(usage.email, 'someone@example.com');
  assert.equal(usage.planType, 'self_serve_business_prolite');
  assert.deepEqual(usage.windows, [
    { usedPercent: 64, windowDurationMins: 10080, resetsAt: 1793600788000 },
    { usedPercent: 12, windowDurationMins: 300, resetsAt: 1793500000000 },
  ]);
  assert.equal(usage.reachedType, null);
});

test('an account without auth.json is reported signed out without starting Codex', async () => {
  let reads = 0;
  const tracker = new CodexAccountUsageTracker(async () => {
    reads += 1;
    return SNAPSHOT;
  }, async () => false, () => 1000);
  const usage = await tracker.refresh(ACCOUNT);
  assert.equal(usage.signedIn, false);
  assert.equal(reads, 0);
});

test('a failed read keeps the last numbers and concurrent reads share one call', async () => {
  let reads = 0;
  let fail = false;
  const tracker = new CodexAccountUsageTracker(async () => {
    reads += 1;
    if (fail) {
      throw new Error('app-server down');
    }
    return SNAPSHOT;
  }, async () => true, () => 1000);

  await Promise.all([tracker.refresh(ACCOUNT), tracker.refresh(ACCOUNT)]);
  assert.equal(reads, 1);

  fail = true;
  const usage = await tracker.refresh(ACCOUNT);
  assert.equal(usage.error, 'app-server down');
  assert.equal(usage.windows[0].usedPercent, 64);
});

test('an exhaustion mark survives reads until one confirms room a minute later', async () => {
  let now = 1_793_400_000_000;
  const tracker = new CodexAccountUsageTracker(async () => SNAPSHOT, async () => true, () => now);
  await tracker.refresh(ACCOUNT);
  tracker.markExhausted(ACCOUNT.id);
  // Earliest future reset of the account's windows.
  assert.equal(tracker.get(ACCOUNT.id)?.exhaustedUntil, 1793500000000);

  now += 10_000;
  await tracker.refresh(ACCOUNT);
  assert.equal(tracker.get(ACCOUNT.id)?.exhaustedUntil, 1793500000000);

  now += 60_000;
  await tracker.refresh(ACCOUNT);
  assert.equal(tracker.get(ACCOUNT.id)?.exhaustedUntil, null);
});

test('ensureFresh only reads stale accounts and does not wait past its timeout', async () => {
  let reads = 0;
  const tracker = new CodexAccountUsageTracker(async () => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return SNAPSHOT;
  }, async () => true);
  const started = Date.now();
  await tracker.ensureFresh([ACCOUNT], 60_000, 20);
  assert.ok(Date.now() - started < 150);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await tracker.ensureFresh([ACCOUNT], 60_000, 20);
  assert.equal(reads, 1);
});

test('Codex usage-limit wording is recognised', () => {
  for (const message of [
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits",
    "You've hit your usage limit for GPT-5.5. Try again at 3:00 PM.",
    'usage_limit_reached',
  ]) {
    assert.equal(isUsageLimitMessage(message), true, message);
  }
  assert.equal(isUsageLimitMessage('stream disconnected before completion'), false);
  assert.equal(isUsageLimitMessage(undefined), false);
});
