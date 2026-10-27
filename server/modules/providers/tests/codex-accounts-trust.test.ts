import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { accountTrustEdits, codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';

const HOME = '/srv/studio/codex';
const ACCOUNT = '/home/owner/.cloudcli/codex-accounts/work';

const hook = (overrides: Record<string, unknown> = {}) => ({
  key: `${HOME}/hooks.json:user_prompt_submit:0:0`,
  sourcePath: `${HOME}/hooks.json`,
  source: 'user',
  trustStatus: 'trusted',
  currentHash: 'sha256:abc',
  ...overrides,
});

test('a hook the default home trusts gets the same hash under each account path', () => {
  assert.deepEqual(accountTrustEdits([hook()], HOME, [ACCOUNT]), {
    [`${ACCOUNT}/hooks.json:user_prompt_submit:0:0`]: { trusted_hash: 'sha256:abc' },
  });
});

test('config.toml hooks are mirrored under the account config.toml path', () => {
  const inToml = hook({ key: `${HOME}/config.toml:stop:0:0`, sourcePath: `${HOME}/config.toml` });
  assert.deepEqual(Object.keys(accountTrustEdits([inToml], HOME, [ACCOUNT])), [`${ACCOUNT}/config.toml:stop:0:0`]);
});

test('a hook the default home does not trust is removed from each account, a turned-off one stays off', () => {
  assert.deepEqual(accountTrustEdits([hook({ trustStatus: 'untrusted' })], HOME, [ACCOUNT]), {
    [`${ACCOUNT}/hooks.json:user_prompt_submit:0:0`]: null,
  });
  assert.deepEqual(accountTrustEdits([hook({ trustStatus: 'modified' })], HOME, [ACCOUNT]), {
    [`${ACCOUNT}/hooks.json:user_prompt_submit:0:0`]: null,
  });
  assert.deepEqual(accountTrustEdits([hook({ enabled: false })], HOME, [ACCOUNT]), {
    [`${ACCOUNT}/hooks.json:user_prompt_submit:0:0`]: { trusted_hash: 'sha256:abc', enabled: false },
  });
});

test('project, managed and system hooks are left alone, and the default home is not mirrored onto itself', () => {
  const skipped = [
    hook({ source: 'project', sourcePath: '/work/repo/.codex/hooks.json', key: '/work/repo/.codex/hooks.json:stop:0:0' }),
    hook({ source: 'system', trustStatus: 'managed' }),
    hook({ sourcePath: '/elsewhere/hooks.json', key: '/elsewhere/hooks.json:stop:0:0' }),
  ];
  assert.deepEqual(accountTrustEdits(skipped, HOME, [ACCOUNT]), {});
  assert.deepEqual(accountTrustEdits([hook()], HOME, [HOME]), {});
});

function codexAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
    return true;
  } catch {
    return false;
  }
}

// Against the Codex this package depends on: the account's own path is what Codex keys the trust by.
test('an extra account home runs the hooks the default home trusts', { skip: !codexAvailable(), timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-trust-'));
  try {
    const home = path.join(root, 'default');
    const account = path.join(root, 'work');
    await mkdir(home, { recursive: true });
    await mkdir(account, { recursive: true });
    const handler = { type: 'command', command: 'python3 /opt/example/hook.py', timeout: 5 };
    await writeFile(path.join(home, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [handler] }] } }));
    const [listed] = await codexAppServer.listHooks({ codexHome: home }) as Array<{ key: string; currentHash: string }>;
    await writeFile(
      path.join(home, 'config.toml'),
      `[hooks.state.${JSON.stringify(listed.key)}]\ntrusted_hash = ${JSON.stringify(listed.currentHash)}\n`,
    );
    for (const name of ['hooks.json', 'config.toml']) {
      await symlink(path.join(home, name), path.join(account, name));
    }
    const before = await codexAppServer.listHooks({ codexHome: account }) as Array<{ trustStatus: string }>;
    assert.equal(before[0]?.trustStatus, 'untrusted');

    assert.equal(await codexAppServer.mirrorHookTrust({ defaultHome: home, accountHomes: [account] }), 1);
    const after = await codexAppServer.listHooks({ codexHome: account }) as Array<{ trustStatus: string }>;
    assert.equal(after[0]?.trustStatus, 'trusted');
    const still = await codexAppServer.listHooks({ codexHome: home }) as Array<{ trustStatus: string }>;
    assert.equal(still[0]?.trustStatus, 'trusted');

    // The owner revokes it in the default home: the next mirror takes it away from the account too.
    await writeFile(path.join(home, 'config.toml'), '');
    assert.equal(await codexAppServer.mirrorHookTrust({ defaultHome: home, accountHomes: [account] }), 1);
    const revoked = await codexAppServer.listHooks({ codexHome: account }) as Array<{ trustStatus: string }>;
    assert.equal(revoked[0]?.trustStatus, 'untrusted');
    // Again, with nothing left to remove: Codex takes the removal of a missing key as done.
    assert.equal(await codexAppServer.mirrorHookTrust({ defaultHome: home, accountHomes: [account] }), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
