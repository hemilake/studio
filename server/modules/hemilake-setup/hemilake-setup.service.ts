import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import { getClaudeConfigDirectory, getClaudeGlobalConfigPath, readObjectRecord, readOptionalString } from '@/shared/utils.js';

/**
 * Fork (Hemilake): first-run setup for a Studio that runs on its own, without hemi.
 *
 * Three things a standalone Studio needs before its first useful chat, each done the way Claude Code itself
 * does it, so Studio keeps no state of its own here:
 * - Claude Code on the machine: the official installer, run in Studio's terminal (installCommand).
 * - How Claude Code reaches a model: the owner's Claude account (`claude /login`), an Anthropic API key, or an
 *   Anthropic-compatible gateway such as LiteLLM. The key and the gateway go into the `env` of Claude Code's
 *   user settings.json, which the CLI reads on every start.
 * - The owner's Hemilake, all of it: the Hemilake plugin's directory build (the zip hemilake.com publishes per
 *   channel: skills, `mcp_tool` hooks for recall and session memory, and the `hemilake` MCP server, no
 *   credential inside) unpacked into a local marketplace with its `.mcp.json` pointed at the owner's lake, and
 *   installed into Claude Code as `hemilake@hemilake-studio`. Its server is `plugin:hemilake:hemilake`, the
 *   name the hooks and the skills use; `claude mcp login plugin:hemilake:hemilake` signs it in with OAuth in
 *   Studio's terminal. Claude Code keeps the token; Studio never sees it.
 */

export const LAKE_SERVER_NAME = 'plugin:hemilake:hemilake';
const LEGACY_SERVER_NAME = 'hemilake'; // 1.37.3-hemilake.13 added the lake as a plain user MCP server
export const PLUGIN_MARKETPLACE = 'hemilake-studio';
export const PLUGIN_ID = `hemilake@${PLUGIN_MARKETPLACE}`;
export const DEFAULT_PLUGIN_URL = 'https://hemilake.com/stable/hemilake-plugin.zip';
export const CLAUDE_INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash';
export const LAKE_LOGIN_COMMAND = `claude mcp login ${LAKE_SERVER_NAME}`;

// The env keys a connection mode writes. Switching mode removes the other modes' keys, so a stale gateway URL
// never outlives a switch back to the Claude account.
const CONNECTION_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'] as const;

export type ClaudeConnectionMode = 'account' | 'api-key' | 'gateway';

export type ClaudeConnectionInput =
  | { mode: 'account' }
  | { mode: 'api-key'; apiKey: string }
  | { mode: 'gateway'; baseUrl: string; token: string };

export type LakeState = 'connected' | 'needs-sign-in' | 'failed' | 'unknown';

export type HemilakeSetupStatus = {
  claude: { installed: boolean; installCommand: string };
  connection: { mode: ClaudeConnectionMode | null; baseUrl: string | null };
  lake: { url: string | null; state: LakeState | null; loginCommand: string; plugin: boolean };
};

export class SetupError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

type CommandResult = { exitCode: number; stdout: string; stderr: string };

export type HemilakeSetupDependencies = {
  homeDirectory: string;
  environment: NodeJS.ProcessEnv;
  readText: (filePath: string) => Promise<string>;
  writeText: (filePath: string, content: string) => Promise<void>;
  runClaude: (args: string[]) => Promise<CommandResult>;
  claudeInstalled: () => Promise<boolean>;
  fetch: typeof fetch;
  /** Unpacks a zip into a directory that exists and is empty. */
  unzip: (zipPath: string, destination: string) => Promise<void>;
};

const defaultRunClaude = (environment: NodeJS.ProcessEnv) => (args: string[]): Promise<CommandResult> => {
  const cli = resolveClaudeCodeExecutablePath(environment.CLAUDE_CLI_PATH) ?? 'claude';
  return new Promise((resolve) => {
    execFile(cli, args, { timeout: 30_000, env: environment }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 0;
      resolve({ exitCode: error ? code || 1 : 0, stdout: String(stdout), stderr: String(stderr || (error && !code ? error.message : '')) });
    });
  });
};

const defaultWriteText = async (filePath: string, content: string) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { mode: 0o600 });
  await chmod(filePath, 0o600);
};

export function defaultHemilakeSetupDependencies(environment: NodeJS.ProcessEnv = process.env): HemilakeSetupDependencies {
  const runClaude = defaultRunClaude(environment);
  return {
    homeDirectory: os.homedir(),
    environment,
    readText: (filePath) => readFile(filePath, 'utf8'),
    writeText: defaultWriteText,
    runClaude,
    claudeInstalled: async () => (await runClaude(['--version'])).exitCode === 0,
    fetch: globalThis.fetch,
    unzip: (zipPath, destination) => new Promise((resolve, reject) => {
      // macOS and most Linux systems ship unzip; it refuses entries that leave the destination.
      execFile('unzip', ['-q', '-o', zipPath, '-d', destination], { timeout: 60_000 }, (error) => {
        if (error) reject(new SetupError(`Could not unpack the Hemilake plugin (${error.message}). Is unzip installed?`, 500));
        else resolve();
      });
    }),
  };
}

/** `elena.cloud.hemilake.app`, `https://…/`, `…/mcp` or a console URL: the lake's MCP address, or an error. */
export function normalizeLakeAddress(raw: string): string {
  let value = (raw || '').trim();
  if (!value) {
    throw new SetupError('Enter your Hemilake address.');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SetupError('That is not a web address. It looks like name.cloud.hemilake.app.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new SetupError('Your Hemilake address has to start with https://.');
  }
  return `${url.origin}/mcp`;
}

function normalizeBaseUrl(raw: string): string {
  const value = (raw || '').trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SetupError('The gateway address is not a web address, e.g. https://litellm.example.com.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SetupError('The gateway address has to start with https:// or http://.');
  }
  // Claude Code appends /v1/messages itself: a pasted …/v1 would double it.
  return value.replace(/\/v1$/, '');
}

export function createHemilakeSetupService(deps: HemilakeSetupDependencies) {
  const settingsPath = path.join(getClaudeConfigDirectory(deps.homeDirectory, deps.environment), 'settings.json');
  const globalConfigPath = getClaudeGlobalConfigPath(deps.homeDirectory, deps.environment);

  const readJson = async (filePath: string): Promise<Record<string, unknown>> => {
    let text: string;
    try {
      text = await deps.readText(filePath);
    } catch {
      return {};
    }
    try {
      return readObjectRecord(JSON.parse(text)) ?? {};
    } catch {
      throw new SetupError(`${filePath} is not valid JSON; fix or remove it first.`, 409);
    }
  };

  const readConnection = async (): Promise<HemilakeSetupStatus['connection']> => {
    const env = readObjectRecord((await readJson(settingsPath)).env) ?? {};
    const baseUrl = readOptionalString(env.ANTHROPIC_BASE_URL) ?? null;
    if (baseUrl) {
      return { mode: 'gateway', baseUrl };
    }
    if (readOptionalString(env.ANTHROPIC_API_KEY)) {
      return { mode: 'api-key', baseUrl: null };
    }
    return { mode: null, baseUrl: null };
  };

  // The local marketplace Studio keeps the plugin in, under Studio's own data directory.
  const marketplaceDir = path.join(deps.homeDirectory, '.cloudcli', 'hemilake-marketplace');
  const pluginMcpPath = path.join(marketplaceDir, 'hemilake', '.mcp.json');

  const readLake = async (): Promise<{ url: string | null; server: string; plugin: boolean }> => {
    const pluginServer = readObjectRecord((await readJson(pluginMcpPath)).hemilake);
    const pluginUrl = readOptionalString(pluginServer?.url);
    if (pluginUrl) return { url: pluginUrl, server: LAKE_SERVER_NAME, plugin: true };
    const servers = readObjectRecord((await readJson(globalConfigPath)).mcpServers) ?? {};
    const legacyUrl = readOptionalString(readObjectRecord(servers[LEGACY_SERVER_NAME])?.url) ?? null;
    return { url: legacyUrl, server: LEGACY_SERVER_NAME, plugin: false };
  };

  const lakeState = async (server: string): Promise<LakeState> => {
    const result = await deps.runClaude(['mcp', 'get', server]);
    const statusLine = `${result.stdout}\n${result.stderr}`.split('\n').find((line) => /^\s*Status:/i.test(line)) ?? '';
    if (/connected/i.test(statusLine) && !/not connected/i.test(statusLine)) return 'connected';
    if (/auth/i.test(statusLine)) return 'needs-sign-in';
    if (/fail|error/i.test(statusLine)) return 'failed';
    return 'unknown';
  };

  const getStatus = async (): Promise<HemilakeSetupStatus> => {
    const installed = await deps.claudeInstalled();
    const lake = await readLake();
    return {
      claude: { installed, installCommand: CLAUDE_INSTALL_COMMAND },
      connection: await readConnection(),
      lake: {
        url: lake.url,
        state: lake.url && installed ? await lakeState(lake.server) : null,
        loginCommand: lake.plugin ? LAKE_LOGIN_COMMAND : `claude mcp login ${LEGACY_SERVER_NAME}`,
        plugin: lake.plugin,
      },
    };
  };

  /** Checks a key or a gateway with one models listing: no tokens spent, and a wrong key fails here, not mid-chat. */
  const probe = async (url: string, headers: Record<string, string>, what: string) => {
    let response: Response;
    try {
      response = await deps.fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new SetupError(`Could not reach ${what} at ${new URL(url).origin}. Check the address and your connection.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SetupError(`${what} refused the key (HTTP ${response.status}). Check it and try again.`);
    }
    // Some gateways do not list models; anything but a refusal means the key and the address answer.
  };

  const saveConnection = async (input: ClaudeConnectionInput): Promise<HemilakeSetupStatus['connection']> => {
    const settings = await readJson(settingsPath);
    const env = { ...(readObjectRecord(settings.env) ?? {}) };
    for (const key of CONNECTION_ENV_KEYS) delete env[key];

    if (input.mode === 'api-key') {
      const apiKey = (input.apiKey || '').trim();
      if (!apiKey) throw new SetupError('Paste your Anthropic API key.');
      await probe('https://api.anthropic.com/v1/models', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, 'Anthropic');
      env.ANTHROPIC_API_KEY = apiKey;
    } else if (input.mode === 'gateway') {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      const token = (input.token || '').trim();
      if (!token) throw new SetupError('Paste the gateway key.');
      await probe(`${baseUrl}/v1/models`, { authorization: `Bearer ${token}` }, 'The gateway');
      env.ANTHROPIC_BASE_URL = baseUrl;
      env.ANTHROPIC_AUTH_TOKEN = token;
    } else if (input.mode !== 'account') {
      throw new SetupError('Unknown connection mode.');
    }

    const next: Record<string, unknown> = { ...settings };
    if (Object.keys(env).length) next.env = env;
    else delete next.env;
    await deps.writeText(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    return readConnection();
  };

  /** The plugin's directory build, checked against the `.sha256` published next to it. */
  const downloadPlugin = async (): Promise<Buffer> => {
    const url = deps.environment.CLOUDCLI_HEMILAKE_PLUGIN_URL?.trim() || DEFAULT_PLUGIN_URL;
    let zip: Buffer;
    let expected: string;
    try {
      const [zipResponse, sumResponse] = await Promise.all([
        deps.fetch(url, { signal: AbortSignal.timeout(60_000) }),
        deps.fetch(`${url}.sha256`, { signal: AbortSignal.timeout(30_000) }),
      ]);
      if (!zipResponse.ok || !sumResponse.ok) throw new Error(`HTTP ${zipResponse.status}/${sumResponse.status}`);
      zip = Buffer.from(await zipResponse.arrayBuffer());
      expected = (await sumResponse.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    } catch (error) {
      throw new SetupError(`Could not download the Hemilake plugin from ${new URL(url).origin} (${error instanceof Error ? error.message : error}).`, 502);
    }
    const actual = createHash('sha256').update(zip).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
      throw new SetupError('The Hemilake plugin did not match its published checksum; nothing was installed.', 502);
    }
    return zip;
  };

  /** Unpacks the plugin next to the marketplace, points its MCP server at the lake, then swaps it in whole. */
  const writeMarketplace = async (zip: Buffer, lakeUrl: string) => {
    await mkdir(path.dirname(marketplaceDir), { recursive: true });
    const staging = await mkdtemp(`${marketplaceDir}.new-`);
    try {
      const zipPath = path.join(staging, 'plugin.zip');
      await writeFile(zipPath, zip);
      const pluginDir = path.join(staging, 'hemilake');
      await mkdir(pluginDir);
      await deps.unzip(zipPath, pluginDir);
      await rm(zipPath);
      const manifest = readObjectRecord(JSON.parse(await readFile(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')));
      if (readOptionalString(manifest?.name) !== 'hemilake') {
        throw new SetupError('The download is not the Hemilake plugin; nothing was installed.', 502);
      }
      await writeFile(path.join(pluginDir, '.mcp.json'), `${JSON.stringify({ hemilake: { type: 'http', url: lakeUrl } }, null, 2)}\n`);
      await mkdir(path.join(staging, '.claude-plugin'));
      await writeFile(path.join(staging, '.claude-plugin', 'marketplace.json'), `${JSON.stringify({
        name: PLUGIN_MARKETPLACE,
        owner: { name: 'Hemilake' },
        plugins: [{ name: 'hemilake', source: './hemilake', description: 'Your Hemilake: recall, session memory, skills and tools' }],
      }, null, 2)}\n`);
      await rm(marketplaceDir, { recursive: true, force: true });
      await rename(staging, marketplaceDir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  };

  const connectLake = async (address: string) => {
    const url = normalizeLakeAddress(address);
    if (!(await deps.claudeInstalled())) {
      throw new SetupError('Install Claude Code first: Studio connects your Hemilake through it.', 409);
    }

    // The lake's OAuth metadata says it is a Hemilake MCP (or at least an OAuth-protected MCP) before anything is
    // written: a typo fails here with a plain message instead of as a server that never connects.
    const origin = new URL(url).origin;
    let resource: string | null = null;
    try {
      const response = await deps.fetch(`${origin}/.well-known/oauth-protected-resource`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        resource = readOptionalString(readObjectRecord(await response.json())?.resource) ?? null;
      }
    } catch {
      throw new SetupError(`Could not reach ${origin}. Check the address; it is in your Hemilake invitation email.`);
    }
    // Only a resource on the address the owner typed: a lake cannot redirect Studio's sign-in somewhere else.
    if (resource && resource.replace(/\/+$/, '') !== url) {
      resource = new URL(resource).origin === origin ? resource : null;
    }
    if (!resource) {
      throw new SetupError(`${origin} does not answer as a Hemilake. Check the address; it is in your Hemilake invitation email.`);
    }

    await writeMarketplace(await downloadPlugin(), resource);

    const run = async (args: string[], what: string) => {
      const result = await deps.runClaude(args);
      if (result.exitCode !== 0) {
        throw new SetupError(`Claude Code could not ${what}: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`, 500);
      }
    };
    await run(['plugin', 'marketplace', 'add', marketplaceDir], 'add the Hemilake plugin');
    await run(['plugin', 'marketplace', 'update', PLUGIN_MARKETPLACE], 'refresh the Hemilake plugin');
    await run(['plugin', 'install', PLUGIN_ID], 'install the Hemilake plugin');
    await deps.runClaude(['plugin', 'enable', PLUGIN_ID]); // fails only when it already is

    // Two plugins named hemilake do not load at once, and Claude Code prefers the other one (`hemi client`'s,
    // whose bridge points at a lake on this computer): it goes, so this one is the Hemilake Claude Code uses.
    const enabled = readObjectRecord((await readJson(settingsPath)).enabledPlugins) ?? {};
    const replaced: string[] = [];
    for (const [id, on] of Object.entries(enabled)) {
      if (on === true && id.startsWith('hemilake@') && id !== PLUGIN_ID) {
        if ((await deps.runClaude(['plugin', 'disable', id])).exitCode === 0) replaced.push(id);
      }
    }
    // The plain server an earlier Studio added for this lake would serve the same tools twice; one of the
    // owner's own with that name, for another address, stays.
    const servers = readObjectRecord((await readJson(globalConfigPath)).mcpServers) ?? {};
    const legacyUrl = readOptionalString(readObjectRecord(servers[LEGACY_SERVER_NAME])?.url);
    if (legacyUrl && URL.canParse(legacyUrl) && new URL(legacyUrl).origin === origin) {
      await deps.runClaude(['mcp', 'remove', '--scope', 'user', LEGACY_SERVER_NAME]);
    }

    return { url: resource, loginCommand: LAKE_LOGIN_COMMAND, replaced };
  };

  return { getStatus, saveConnection, connectLake };
}
