import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
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
 * - The owner's Hemilake: its MCP address added as the user-scoped HTTP server `hemilake`
 *   (`claude mcp add`), then signed in with OAuth by `claude mcp login hemilake` in Studio's terminal. The lake
 *   never hands Studio a token: Claude Code keeps it.
 */

export const LAKE_SERVER_NAME = 'hemilake';
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
  lake: { url: string | null; state: LakeState | null; loginCommand: string };
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

  const readLakeUrl = async (): Promise<string | null> => {
    const servers = readObjectRecord((await readJson(globalConfigPath)).mcpServers) ?? {};
    return readOptionalString(readObjectRecord(servers[LAKE_SERVER_NAME])?.url) ?? null;
  };

  const lakeState = async (): Promise<LakeState> => {
    const result = await deps.runClaude(['mcp', 'get', LAKE_SERVER_NAME]);
    const statusLine = `${result.stdout}\n${result.stderr}`.split('\n').find((line) => /^\s*Status:/i.test(line)) ?? '';
    if (/connected/i.test(statusLine) && !/not connected/i.test(statusLine)) return 'connected';
    if (/auth/i.test(statusLine)) return 'needs-sign-in';
    if (/fail|error/i.test(statusLine)) return 'failed';
    return 'unknown';
  };

  const getStatus = async (): Promise<HemilakeSetupStatus> => {
    const installed = await deps.claudeInstalled();
    const url = await readLakeUrl();
    return {
      claude: { installed, installCommand: CLAUDE_INSTALL_COMMAND },
      connection: await readConnection(),
      lake: { url, state: url && installed ? await lakeState() : null, loginCommand: LAKE_LOGIN_COMMAND },
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

    await deps.runClaude(['mcp', 'remove', '--scope', 'user', LAKE_SERVER_NAME]);
    const added = await deps.runClaude(['mcp', 'add', '--transport', 'http', '--scope', 'user', LAKE_SERVER_NAME, resource]);
    if (added.exitCode !== 0) {
      throw new SetupError(`Claude Code could not add your Hemilake: ${(added.stderr || added.stdout).trim() || `exit ${added.exitCode}`}`, 500);
    }
    return { url: resource, loginCommand: LAKE_LOGIN_COMMAND };
  };

  return { getStatus, saveConnection, connectLake };
}
