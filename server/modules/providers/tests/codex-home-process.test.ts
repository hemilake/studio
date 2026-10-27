// Fork (Hemilake): Studio's Codex readers under a CODEX_HOME set before any module loads, as hemi starts Studio.
// node:test runs each file in a process of its own, so the variable is set here and nowhere else.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'codex-home-process-'));
const codexHome = path.join(root, 'studio-codex');
process.env.CODEX_HOME = codexHome;
await mkdir(path.join(codexHome, 'skills'), { recursive: true });
await writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');
await writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test' }));

const { CodexProviderAuth } = await import('@/modules/providers/list/codex/codex-auth.provider.js');
const { CodexProviderModels } = await import('@/modules/providers/list/codex/codex-models.provider.js');
const { CodexSkillsProvider } = await import('@/modules/providers/list/codex/codex-skills.provider.js');

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('the sign-in, the active model and the skills come from CODEX_HOME', async () => {
  const auth = await (new CodexProviderAuth() as unknown as { checkCredentials: () => Promise<{ method: string | null }> })
    .checkCredentials();
  assert.equal(auth.method, 'api_key');
  assert.deepEqual(await new CodexProviderModels().getCurrentActiveModel(), { model: 'gpt-5.6-sol' });
  const sources = await (new CodexSkillsProvider() as unknown as {
    getSkillSources: (workspace: string) => Promise<Array<{ rootDir: string }>>;
  }).getSkillSources(root);
  const roots = sources.map((source) => source.rootDir);
  assert.ok(roots.includes(path.join(codexHome, 'skills')));
  assert.ok(roots.includes(path.join(codexHome, 'skills', '.system')));
  assert.ok(!roots.some((dir) => dir.startsWith(path.join(os.homedir(), '.codex'))));
});
