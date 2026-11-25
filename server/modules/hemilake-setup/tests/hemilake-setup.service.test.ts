import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHemilakeSetupService,
  type HemilakeSetupDependencies,
  normalizeLakeAddress,
  SetupError,
} from '../hemilake-setup.service.js';

const HOME = '/home/owner';
const SETTINGS = '/home/owner/.claude/settings.json';
const GLOBAL = '/home/owner/.claude.json';

function harness(overrides: Partial<HemilakeSetupDependencies> = {}, files: Record<string, string> = {}) {
  const store = { ...files };
  const claudeCalls: string[][] = [];
  const fetchCalls: { url: string; headers: Record<string, string> }[] = [];
  const responses: Record<string, { status: number; body?: unknown }> = {
    'https://elena.cloud.hemilake.app/.well-known/oauth-protected-resource': {
      status: 200,
      body: { resource: 'https://elena.cloud.hemilake.app/mcp', authorization_servers: ['https://elena.cloud.hemilake.app'] },
    },
    'https://api.anthropic.com/v1/models': { status: 200, body: { data: [] } },
    'https://litellm.example.com/v1/models': { status: 200, body: { data: [] } },
  };
  const deps: HemilakeSetupDependencies = {
    homeDirectory: HOME,
    environment: {},
    readText: async (filePath) => {
      if (!(filePath in store)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return store[filePath];
    },
    writeText: async (filePath, content) => {
      store[filePath] = content;
    },
    runClaude: async (args) => {
      claudeCalls.push(args);
      if (args[0] === 'mcp' && args[1] === 'get') {
        return { exitCode: 0, stdout: 'hemilake:\n  Scope: User config\n  Status: ! Needs authentication\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    claudeInstalled: async () => true,
    fetch: (async (url: string, init?: { headers?: Record<string, string> }) => {
      fetchCalls.push({ url, headers: init?.headers ?? {} });
      const answer = responses[url];
      if (!answer) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
    }) as unknown as typeof fetch,
    ...overrides,
  };
  return { service: createHemilakeSetupService(deps), store, claudeCalls, fetchCalls, responses };
}

test('normalizeLakeAddress takes a bare host, a console URL or the MCP address', () => {
  assert.equal(normalizeLakeAddress('elena.cloud.hemilake.app'), 'https://elena.cloud.hemilake.app/mcp');
  assert.equal(normalizeLakeAddress(' https://elena.cloud.hemilake.app/console/start '), 'https://elena.cloud.hemilake.app/mcp');
  assert.equal(normalizeLakeAddress('https://elena.cloud.hemilake.app/mcp'), 'https://elena.cloud.hemilake.app/mcp');
  assert.equal(normalizeLakeAddress('http://127.0.0.1:8095'), 'http://127.0.0.1:8095/mcp');
  assert.throws(() => normalizeLakeAddress('http://elena.cloud.hemilake.app'), SetupError);
  assert.throws(() => normalizeLakeAddress(''), SetupError);
});

test('a gateway connection writes base URL and token, keeps other settings, and probes the gateway', async () => {
  const { service, store, fetchCalls } = harness({}, {
    [SETTINGS]: JSON.stringify({ theme: 'dark', env: { FOO: '1', ANTHROPIC_API_KEY: 'old' } }),
  });
  const connection = await service.saveConnection({ mode: 'gateway', baseUrl: 'https://litellm.example.com/v1/', token: 'sk-gw' });
  assert.deepEqual(connection, { mode: 'gateway', baseUrl: 'https://litellm.example.com' });
  const saved = JSON.parse(store[SETTINGS]);
  assert.equal(saved.theme, 'dark');
  assert.deepEqual(saved.env, { FOO: '1', ANTHROPIC_BASE_URL: 'https://litellm.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-gw' });
  assert.equal(fetchCalls[0].headers.authorization, 'Bearer sk-gw');
});

test('a refused key is not saved', async () => {
  const { service, store, responses } = harness();
  responses['https://api.anthropic.com/v1/models'] = { status: 401 };
  await assert.rejects(service.saveConnection({ mode: 'api-key', apiKey: 'sk-bad' }), /refused the key/);
  assert.equal(store[SETTINGS], undefined);
});

test('back to the Claude account removes the key and gateway entries', async () => {
  const { service, store } = harness({}, {
    [SETTINGS]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_AUTH_TOKEN: 't' } }),
  });
  const connection = await service.saveConnection({ mode: 'account' });
  assert.deepEqual(connection, { mode: null, baseUrl: null });
  assert.deepEqual(JSON.parse(store[SETTINGS]), {});
});

test('connecting the lake checks its OAuth metadata, then adds it as a user-scoped HTTP server', async () => {
  const { service, claudeCalls } = harness();
  const result = await service.connectLake('elena.cloud.hemilake.app');
  assert.deepEqual(result, { url: 'https://elena.cloud.hemilake.app/mcp', loginCommand: 'claude mcp login hemilake' });
  assert.deepEqual(claudeCalls.at(-1), ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'hemilake', 'https://elena.cloud.hemilake.app/mcp']);
});

test('an address that is not a lake writes nothing', async () => {
  const { service, claudeCalls } = harness();
  await assert.rejects(service.connectLake('example.org'), /Could not reach|does not answer/);
  assert.equal(claudeCalls.length, 0);
});

test('a lake whose metadata names another origin is refused', async () => {
  const { service, responses, claudeCalls } = harness();
  responses['https://elena.cloud.hemilake.app/.well-known/oauth-protected-resource'] = {
    status: 200,
    body: { resource: 'https://evil.example.com/mcp' },
  };
  await assert.rejects(service.connectLake('elena.cloud.hemilake.app'), /does not answer as a Hemilake/);
  assert.equal(claudeCalls.length, 0);
});

test('status reads the lake from .claude.json and its sign-in state from claude mcp get', async () => {
  const { service } = harness({}, {
    [GLOBAL]: JSON.stringify({ mcpServers: { hemilake: { type: 'http', url: 'https://elena.cloud.hemilake.app/mcp' } } }),
    [SETTINGS]: JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk' } }),
  });
  const status = await service.getStatus();
  assert.equal(status.claude.installed, true);
  assert.deepEqual(status.connection, { mode: 'api-key', baseUrl: null });
  assert.equal(status.lake.url, 'https://elena.cloud.hemilake.app/mcp');
  assert.equal(status.lake.state, 'needs-sign-in');
});

test('without Claude Code the lake cannot be added', async () => {
  const { service } = harness({ claudeInstalled: async () => false });
  await assert.rejects(service.connectLake('elena.cloud.hemilake.app'), /Install Claude Code first/);
});
