import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';

import { closeConnection, codexSessionAccountsDb, initializeDatabase } from '@/modules/database/index.js';
import { codexAccountsService } from '@/modules/providers/list/codex/accounts/codex-accounts.service.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

const LIMIT_MESSAGE = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits";

async function withAccounts(run: (dirs: { shared: string; root: string }) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), 'codex-accounts-runtime-'));
  const shared = path.join(base, 'dot-codex');
  const root = path.join(base, 'accounts');
  const previous = {
    CODEX_HOME: process.env.CODEX_HOME,
    CLOUDCLI_CODEX_ACCOUNTS_DIR: process.env.CLOUDCLI_CODEX_ACCOUNTS_DIR,
    DATABASE_PATH: process.env.DATABASE_PATH,
  };
  process.env.CODEX_HOME = shared;
  process.env.CLOUDCLI_CODEX_ACCOUNTS_DIR = root;
  process.env.DATABASE_PATH = path.join(base, 'auth.db');
  closeConnection();
  await initializeDatabase();
  try {
    await mkdir(path.join(root, 'acct-b'), { recursive: true });
    await mkdir(shared, { recursive: true });
    await writeFile(path.join(shared, 'auth.json'), '{}');
    await writeFile(path.join(root, 'acct-b', 'auth.json'), '{}');
    await writeFile(path.join(root, 'accounts.json'), JSON.stringify({
      version: 1,
      mode: 'backup',
      primaryAccountId: 'default',
      accounts: [{ id: 'default', label: 'Main' }, { id: 'acct-b', label: 'Spare' }],
    }));
    await run({ shared, root });
  } finally {
    closeConnection();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(base, { recursive: true, force: true });
  }
}

const context: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => 'test-model',
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

function homeOf(codex: unknown): string | undefined {
  return (codex as { exec?: { envOverride?: Record<string, string> } }).exec?.envOverride?.CODEX_HOME;
}

test('a turn stopped by the usage limit moves to the next account and stays there', async (t) => {
  await withAccounts(async ({ shared, root }) => {
    t.mock.method(codexAccountsService.usage, 'ensureFresh', async () => {});
    const homes: (string | undefined)[] = [];
    const exhausted = {
      id: 'native-thread',
      async runStreamed() {
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'native-thread' };
          yield { type: 'turn.started' };
          yield { type: 'error', message: LIMIT_MESSAGE };
          yield { type: 'turn.failed', error: { message: LIMIT_MESSAGE } };
        })() };
      },
    } as unknown as Thread;
    const working = {
      id: 'native-thread',
      async runStreamed() {
        return { events: (async function* () {
          yield { type: 'turn.started' };
          yield { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'done' } };
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
        })() };
      },
    } as unknown as Thread;
    t.mock.method(Codex.prototype, 'startThread', function (this: Codex) {
      homes.push(homeOf(this));
      return exhausted;
    });
    const resume = t.mock.method(Codex.prototype, 'resumeThread', function (this: Codex, id: string) {
      assert.equal(id, 'native-thread');
      homes.push(homeOf(this));
      return working;
    });

    const messages: any[] = [];
    await codexRuntime.run('hello', { sessionId: 'app-1', cwd: process.cwd() }, {
      isWebSocketWriter: true,
      send: (message) => messages.push(message),
    }, context);

    assert.deepEqual(homes, [shared, path.join(root, 'acct-b')]);
    assert.equal(resume.mock.callCount(), 1);
    assert.ok(messages.some((message) => message.kind === 'status' && /out of usage/.test(message.text)));
    assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 0));
    assert.equal(codexSessionAccountsDb.getAccountId('app-1'), 'acct-b');
    assert.ok((codexAccountsService.usage.get('default')?.exhaustedUntil ?? 0) > Date.now());

    // The next turn of the same session stays on the spare account.
    const next = await codexAccountsService.resolveForTurn({ sessionId: 'app-1' });
    assert.equal(next.account.id, 'acct-b');
    assert.equal(next.reason, 'sticky');
  });
});

test('a lone default account runs without an environment override', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'codex-accounts-single-'));
  const previous = process.env.CLOUDCLI_CODEX_ACCOUNTS_DIR;
  process.env.CLOUDCLI_CODEX_ACCOUNTS_DIR = path.join(base, 'missing');
  try {
    let home: string | undefined = 'unset';
    const thread = {
      id: 'native-thread',
      async runStreamed() {
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'native-thread' };
        })() };
      },
    } as unknown as Thread;
    t.mock.method(Codex.prototype, 'startThread', function (this: Codex) {
      home = homeOf(this);
      return thread;
    });
    await codexRuntime.run('hello', { cwd: process.cwd() }, { isWebSocketWriter: true, send: () => {} }, context);
    assert.equal(home, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.CLOUDCLI_CODEX_ACCOUNTS_DIR;
    } else {
      process.env.CLOUDCLI_CODEX_ACCOUNTS_DIR = previous;
    }
    await rm(base, { recursive: true, force: true });
  }
});
