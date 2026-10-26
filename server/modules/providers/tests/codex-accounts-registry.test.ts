import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isPrivateCodexHomeEntry,
  readRegistry,
  removeAccountHome,
  sanitizeRegistry,
  syncAccountHome,
  writeRegistry,
} from '@/modules/providers/list/codex/accounts/codex-accounts.registry.js';

async function withHomes(run: (dirs: { shared: string; root: string }) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(tmpdir(), 'codex-accounts-'));
  const shared = path.join(base, 'dot-codex');
  const root = path.join(base, 'accounts');
  const previous = { home: process.env.CODEX_HOME, root: process.env.CLOUDCLI_CODEX_ACCOUNTS_DIR };
  process.env.CODEX_HOME = shared;
  process.env.CLOUDCLI_CODEX_ACCOUNTS_DIR = root;
  try {
    await mkdir(shared, { recursive: true });
    await run({ shared, root });
  } finally {
    for (const [key, value] of [['CODEX_HOME', previous.home], ['CLOUDCLI_CODEX_ACCOUNTS_DIR', previous.root]] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(base, { recursive: true, force: true });
  }
}

test('a missing or broken registry degrades to the default account', async () => {
  await withHomes(async ({ shared, root }) => {
    const missing = await readRegistry();
    assert.deepEqual(missing.accounts.map((account) => [account.id, account.codexHome]), [['default', shared]]);
    assert.equal(missing.mode, 'backup');

    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'accounts.json'), '{ not json');
    assert.equal((await readRegistry()).accounts.length, 1);
  });
});

test('sanitizing keeps valid entries in order and never trusts a stored home', async () => {
  await withHomes(async ({ shared, root }) => {
    const registry = sanitizeRegistry({
      mode: 'round_robin',
      primaryAccountId: 'gone',
      minHeadroomPercent: 500,
      planWeights: { Pro: 4, plus: -1 },
      accounts: [
        { id: 'acct-b', label: ' Work ', codexHome: '/etc' },
        { id: '../evil', label: 'x' },
        { id: 'acct-b', label: 'duplicate' },
        { id: 'default', label: 'Mine', enabled: false },
      ],
    });
    assert.deepEqual(registry.accounts.map((account) => account.id), ['acct-b', 'default']);
    assert.equal(registry.accounts[0].codexHome, path.join(root, 'acct-b'));
    assert.equal(registry.accounts[0].label, 'Work');
    assert.equal(registry.accounts[1].codexHome, shared);
    assert.equal(registry.accounts[1].enabled, false);
    assert.equal(registry.primaryAccountId, 'default');
    assert.equal(registry.minHeadroomPercent, 100);
    assert.deepEqual(registry.planWeights, { pro: 4 });
  });
});

test('the registry round-trips through disk', async () => {
  await withHomes(async ({ root }) => {
    const registry = sanitizeRegistry({ accounts: [{ id: 'default' }, { id: 'acct-1', label: 'One' }], mode: 'round_robin' });
    await writeRegistry(registry);
    const stored = JSON.parse(await readFile(path.join(root, 'accounts.json'), 'utf8'));
    assert.equal(stored.version, 1);
    assert.deepEqual((await readRegistry()).accounts.map((account) => account.label), ['Default', 'One']);
  });
});

test('an account home links everything shareable and keeps its own login', async () => {
  await withHomes(async ({ shared, root }) => {
    for (const name of ['auth.json', 'config.toml', 'state_5.sqlite', 'state_5.sqlite-wal', 'logs_2.sqlite', 'models_cache.json']) {
      await writeFile(path.join(shared, name), name);
    }
    await mkdir(path.join(shared, 'sessions'));
    await mkdir(path.join(shared, 'app-server-control'));

    const home = path.join(root, 'acct-1');
    await syncAccountHome(home);
    assert.deepEqual((await readdir(home)).sort(), ['config.toml', 'sessions', 'state_5.sqlite']);
    assert.equal(await readlink(path.join(home, 'sessions')), path.join(shared, 'sessions'));

    // Later entries get linked on the next sync; local files are left alone.
    await writeFile(path.join(home, 'auth.json'), 'own login');
    await writeFile(path.join(shared, 'state_6.sqlite'), 'upgrade');
    await syncAccountHome(home);
    assert.equal(await readFile(path.join(home, 'auth.json'), 'utf8'), 'own login');
    assert.ok((await lstat(path.join(home, 'state_6.sqlite'))).isSymbolicLink());
  });
});

test('removing an account home deletes the links, not the shared files', async () => {
  await withHomes(async ({ shared, root }) => {
    await writeFile(path.join(shared, 'config.toml'), 'keep me');
    const home = path.join(root, 'acct-1');
    await syncAccountHome(home);
    await removeAccountHome(home);
    assert.equal(await readFile(path.join(shared, 'config.toml'), 'utf8'), 'keep me');
    await assert.rejects(lstat(home));
    await assert.rejects(removeAccountHome(shared), /Refusing/);
    await assert.rejects(removeAccountHome(path.join(root, 'acct-1', '..', '..')), /Refusing/);
  });
});

test('private entries are recognised', () => {
  for (const name of ['auth.json', 'cache', 'logs_2.sqlite', 'state_5.sqlite-shm', 'goals_1.sqlite-wal']) {
    assert.equal(isPrivateCodexHomeEntry(name), true, name);
  }
  for (const name of ['sessions', 'state_5.sqlite', 'config.toml', 'AGENTS.md', 'thread-writer-locks']) {
    assert.equal(isPrivateCodexHomeEntry(name), false, name);
  }
});
