import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createHemilakeSetupService,
  defaultHemilakeSetupDependencies,
  type HemilakeSetupDependencies,
  normalizeLakeAddress,
  SetupError,
} from '../hemilake-setup.service.js';

const LAKE = 'https://elena.cloud.hemilake.app';
const PLUGIN_URL = 'https://hemilake.com/stable/hemilake-plugin.zip';
const ZIP = Buffer.from('a zip, as far as the stubbed unzip cares');

async function harness(overrides: Partial<HemilakeSetupDependencies> = {}, files: Record<string, string> = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'hemilake-setup-'));
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(home, relative)), { recursive: true });
    await writeFile(path.join(home, relative), content);
  }
  const claudeCalls: string[][] = [];
  const fetchCalls: { url: string; headers: Record<string, string> }[] = [];
  const responses: Record<string, { status: number; body?: unknown; raw?: Buffer | string }> = {
    [`${LAKE}/.well-known/oauth-protected-resource`]: {
      status: 200,
      body: { resource: `${LAKE}/mcp`, authorization_servers: [LAKE] },
    },
    'https://api.anthropic.com/v1/models': { status: 200, body: { data: [] } },
    'https://litellm.example.com/v1/models': { status: 200, body: { data: [] } },
    [PLUGIN_URL]: { status: 200, raw: ZIP },
    [`${PLUGIN_URL}.sha256`]: { status: 200, raw: `${createHash('sha256').update(ZIP).digest('hex')}  hemilake-plugin.zip\n` },
  };
  const defaults = defaultHemilakeSetupDependencies({});
  const deps: HemilakeSetupDependencies = {
    ...defaults,
    homeDirectory: home,
    environment: {},
    runClaude: async (args) => {
      claudeCalls.push(args);
      if (args[0] === 'mcp' && args[1] === 'get') {
        return { exitCode: 0, stdout: `${args[2]}:\n  Scope: User config\n  Status: ! Needs authentication\n`, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    claudeInstalled: async () => true,
    fetch: (async (url: string, init?: { headers?: Record<string, string> }) => {
      fetchCalls.push({ url, headers: init?.headers ?? {} });
      const answer = responses[url];
      if (!answer) throw new TypeError('fetch failed');
      return new Response(answer.raw ?? JSON.stringify(answer.body ?? {}), { status: answer.status });
    }) as unknown as typeof fetch,
    // What the directory build holds, as far as these tests look at it.
    unzip: async (_zipPath, destination) => {
      await mkdir(path.join(destination, '.claude-plugin'), { recursive: true });
      await writeFile(path.join(destination, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hemilake', version: '0.20.42' }));
      await writeFile(path.join(destination, '.mcp.json'), JSON.stringify({ hemilake: { type: 'http', url: 'https://mcp.hemilake.app/mcp' } }));
      await mkdir(path.join(destination, 'skills', 'hemilake'), { recursive: true });
      await writeFile(path.join(destination, 'skills', 'hemilake', 'SKILL.md'), '# Hemilake');
    },
    ...overrides,
  };
  const read = async (relative: string) => readFile(path.join(home, relative), 'utf8');
  return {
    service: createHemilakeSetupService(deps),
    home,
    read,
    claudeCalls,
    fetchCalls,
    responses,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

test('normalizeLakeAddress takes a bare host, a console URL or the MCP address', () => {
  assert.equal(normalizeLakeAddress('elena.cloud.hemilake.app'), `${LAKE}/mcp`);
  assert.equal(normalizeLakeAddress(` ${LAKE}/console/start `), `${LAKE}/mcp`);
  assert.equal(normalizeLakeAddress(`${LAKE}/mcp`), `${LAKE}/mcp`);
  assert.equal(normalizeLakeAddress('http://127.0.0.1:8095'), 'http://127.0.0.1:8095/mcp');
  assert.throws(() => normalizeLakeAddress('http://elena.cloud.hemilake.app'), SetupError);
  assert.throws(() => normalizeLakeAddress(''), SetupError);
});

test('a gateway connection writes base URL and token, keeps other settings, and probes the gateway', async () => {
  const h = await harness({}, { '.claude/settings.json': JSON.stringify({ theme: 'dark', env: { FOO: '1', ANTHROPIC_API_KEY: 'old' } }) });
  const connection = await h.service.saveConnection({ mode: 'gateway', baseUrl: 'https://litellm.example.com/v1/', token: 'sk-gw' });
  assert.deepEqual(connection, { mode: 'gateway', baseUrl: 'https://litellm.example.com' });
  const saved = JSON.parse(await h.read('.claude/settings.json'));
  assert.equal(saved.theme, 'dark');
  assert.deepEqual(saved.env, { FOO: '1', ANTHROPIC_BASE_URL: 'https://litellm.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-gw' });
  assert.equal(h.fetchCalls[0].headers.authorization, 'Bearer sk-gw');
  await h.cleanup();
});

test('a refused key is not saved', async () => {
  const h = await harness();
  h.responses['https://api.anthropic.com/v1/models'] = { status: 401 };
  await assert.rejects(h.service.saveConnection({ mode: 'api-key', apiKey: 'sk-bad' }), /refused the key/);
  await assert.rejects(h.read('.claude/settings.json'));
  await h.cleanup();
});

test('back to the Claude account removes the key and gateway entries', async () => {
  const h = await harness({}, { '.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_AUTH_TOKEN: 't' } }) });
  assert.deepEqual(await h.service.saveConnection({ mode: 'account' }), { mode: null, baseUrl: null });
  assert.deepEqual(JSON.parse(await h.read('.claude/settings.json')), {});
  await h.cleanup();
});

test('connecting the lake installs the Hemilake plugin pointed at it, and its sign-in is the plugin server', async () => {
  const h = await harness();
  const result = await h.service.connectLake('elena.cloud.hemilake.app');
  assert.deepEqual(result, { url: `${LAKE}/mcp`, loginCommand: 'claude mcp login plugin:hemilake:hemilake', replaced: [] });

  const marketplace = path.join(h.home, '.cloudcli', 'hemilake-marketplace');
  assert.deepEqual(JSON.parse(await h.read('.cloudcli/hemilake-marketplace/hemilake/.mcp.json')), {
    hemilake: { type: 'http', url: `${LAKE}/mcp` },
  });
  assert.equal(JSON.parse(await h.read('.cloudcli/hemilake-marketplace/.claude-plugin/marketplace.json')).plugins[0].source, './hemilake');
  assert.equal(await h.read('.cloudcli/hemilake-marketplace/hemilake/skills/hemilake/SKILL.md'), '# Hemilake');
  assert.deepEqual(h.claudeCalls.slice(0, 3), [
    ['plugin', 'marketplace', 'add', marketplace],
    ['plugin', 'marketplace', 'update', 'hemilake-studio'],
    ['plugin', 'install', 'hemilake@hemilake-studio'],
  ]);

  const status = await h.service.getStatus();
  assert.deepEqual(status.lake, {
    url: `${LAKE}/mcp`,
    state: 'needs-sign-in',
    loginCommand: 'claude mcp login plugin:hemilake:hemilake',
    plugin: true,
    duplicates: [],
  });
  assert.deepEqual(h.claudeCalls.at(-1), ['mcp', 'get', 'plugin:hemilake:hemilake']);
  await h.cleanup();
});

test("connecting replaces hemi client's plugin and the plain server an earlier Studio added for the same lake", async () => {
  const h = await harness({}, {
    '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'hemilake@hemilake': true, 'other@x': true } }),
    '.claude.json': JSON.stringify({ mcpServers: { hemilake: { type: 'http', url: `${LAKE}/mcp` } } }),
  });
  const result = await h.service.connectLake(LAKE);
  assert.deepEqual(result.replaced, ['hemilake@hemilake', 'MCP server hemilake']);
  assert.ok(h.claudeCalls.some((call) => call.join(' ') === 'plugin disable hemilake@hemilake'));
  assert.ok(h.claudeCalls.some((call) => call.join(' ') === 'mcp remove --scope user hemilake'));
  assert.ok(!h.claudeCalls.some((call) => call.join(' ') === 'plugin disable other@x'));
  await h.cleanup();
});

test('any server the owner configured for the same lake goes, whatever its name and scope (Claude Code hides the plugin server otherwise)', async () => {
  const h = await harness({}, {
    '.claude.json': JSON.stringify({
      mcpServers: { 'hemilake-cloud': { type: 'http', url: `${LAKE}/mcp` }, other: { type: 'http', url: 'https://other.example.com/mcp' } },
      projects: { '/Users/elena/work': { mcpServers: { lake: { type: 'http', url: `${LAKE}/mcp` } } } },
    }),
  });
  const calls: { args: string[]; cwd?: string }[] = [];
  const service = createHemilakeSetupService({
    ...defaultHemilakeSetupDependencies({}),
    homeDirectory: h.home,
    environment: {},
    claudeInstalled: async () => true,
    fetch: (async (url: string) => {
      const answer = h.responses[url];
      if (!answer) throw new TypeError('fetch failed');
      return new Response(answer.raw ?? JSON.stringify(answer.body ?? {}), { status: answer.status });
    }) as unknown as typeof fetch,
    unzip: async (_zip, destination) => {
      await mkdir(path.join(destination, '.claude-plugin'), { recursive: true });
      await writeFile(path.join(destination, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hemilake' }));
    },
    runClaude: async (args, cwd) => {
      calls.push({ args, cwd });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  const before = await service.getStatus();
  assert.deepEqual(before.lake.duplicates, []); // no plugin yet: nothing to collide with

  const result = await service.connectLake(LAKE);
  assert.deepEqual(result.replaced, ['MCP server hemilake-cloud', 'MCP server lake']);
  const removes = calls.filter((call) => call.args[0] === 'mcp' && call.args[1] === 'remove');
  assert.deepEqual(removes, [
    { args: ['mcp', 'remove', '--scope', 'user', 'hemilake-cloud'], cwd: undefined },
    { args: ['mcp', 'remove', '--scope', 'local', 'lake'], cwd: '/Users/elena/work' },
  ]);
  await h.cleanup();
});

test('status names the servers that hide the plugin', async () => {
  const h = await harness({}, {
    '.claude.json': JSON.stringify({ mcpServers: { 'hemilake-cloud': { type: 'http', url: `${LAKE}/mcp` } } }),
    '.cloudcli/hemilake-marketplace/hemilake/.mcp.json': JSON.stringify({ hemilake: { type: 'http', url: `${LAKE}/mcp` } }),
  });
  const status = await h.service.getStatus();
  assert.deepEqual(status.lake.duplicates, ['hemilake-cloud']);
  await h.cleanup();
});

test('a plain hemilake server for another address is left alone', async () => {
  const h = await harness({}, { '.claude.json': JSON.stringify({ mcpServers: { hemilake: { type: 'http', url: 'https://other.example.com/mcp' } } }) });
  await h.service.connectLake(LAKE);
  assert.ok(!h.claudeCalls.some((call) => call[0] === 'mcp' && call[1] === 'remove'));
  await h.cleanup();
});

test('a plugin that does not match its checksum installs nothing', async () => {
  const h = await harness();
  h.responses[`${PLUGIN_URL}.sha256`] = { status: 200, raw: `${'0'.repeat(64)}  hemilake-plugin.zip\n` };
  await assert.rejects(h.service.connectLake(LAKE), /checksum/);
  await assert.rejects(h.read('.cloudcli/hemilake-marketplace/hemilake/.mcp.json'));
  assert.equal(h.claudeCalls.length, 0);
  await h.cleanup();
});

test('an address that is not a lake writes nothing', async () => {
  const h = await harness();
  await assert.rejects(h.service.connectLake('example.org'), /Could not reach|does not answer/);
  assert.equal(h.claudeCalls.length, 0);
  await h.cleanup();
});

test('a lake whose metadata names another origin is refused', async () => {
  const h = await harness();
  h.responses[`${LAKE}/.well-known/oauth-protected-resource`] = { status: 200, body: { resource: 'https://evil.example.com/mcp' } };
  await assert.rejects(h.service.connectLake('elena.cloud.hemilake.app'), /does not answer as a Hemilake/);
  assert.equal(h.claudeCalls.length, 0);
  await h.cleanup();
});

test('status still shows a lake an earlier Studio added as a plain server, as not yet a plugin', async () => {
  const h = await harness({}, {
    '.claude.json': JSON.stringify({ mcpServers: { hemilake: { type: 'http', url: `${LAKE}/mcp` } } }),
    '.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk' } }),
  });
  const status = await h.service.getStatus();
  assert.equal(status.claude.installed, true);
  assert.deepEqual(status.connection, { mode: 'api-key', baseUrl: null });
  assert.equal(status.lake.url, `${LAKE}/mcp`);
  assert.equal(status.lake.plugin, false);
  assert.equal(status.lake.loginCommand, 'claude mcp login hemilake');
  await h.cleanup();
});

test('without Claude Code the lake cannot be added', async () => {
  const h = await harness({ claudeInstalled: async () => false });
  await assert.rejects(h.service.connectLake('elena.cloud.hemilake.app'), /Install Claude Code first/);
  await h.cleanup();
});
