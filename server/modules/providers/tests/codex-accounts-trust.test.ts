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

test('untrusted, modified, project and managed hooks are not mirrored, nor the default home onto itself', () => {
  const skipped = [
    hook({ trustStatus: 'untrusted' }),
    hook({ trustStatus: 'modified' }),
    hook({ source: 'project', sourcePath: '/work/repo/.codex/hooks.json', key: '/work/repo/.codex/hooks.json:stop:0:0' }),
    hook({ source: 'system', trustStatus: 'managed' }),
    hook({ currentHash: '' }),
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
