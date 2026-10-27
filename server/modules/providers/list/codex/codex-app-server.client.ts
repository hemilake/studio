import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';

import { AppError } from '@/shared/utils.js';

/**
 * Minimal JSON-RPC client for `codex app-server`.
 *
 * Codex ships two entry points and they expose different things. The
 * `@openai/codex-sdk` this app runs conversations through is a wrapper around
 * `codex exec`, and its whole surface is `startThread` and `resumeThread` —
 * there is no way to branch a thread or to resume one partway. The same
 * binary's `app-server` subcommand speaks JSON-RPC and does have that
 * primitive, `thread/fork`, which is what the Codex IDE clients build their
 * own "fork" and "edit an earlier message" on top of.
 *
 * So this is a second transport to the same CLI, opened only for the
 * operations the SDK cannot express. Everything else still goes through the
 * SDK.
 */

/** How long a single request may take before the child is killed. */
const REQUEST_TIMEOUT_MS = 30_000;

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/**
 * One fork of a Codex thread.
 *
 * `path` is returned by the server rather than reconstructed: the rollout
 * lands in today's date directory, not next to the file it was copied from,
 * so deriving it from the source path would be wrong roughly every day.
 */
export type CodexThreadFork = {
  threadId: string;
  path: string;
};

/**
 * Resolves how to start `codex app-server`: the launcher shipped in
 * node_modules, run with this Node.
 *
 * Deliberately not the `codex` on PATH: a machine can have a second, older
 * install, and the protocol this speaks is only guaranteed against the
 * version this package depends on. Fork (Hemilake bundle): the bundle leaves
 * the Codex package out (its binaries weigh ~280 MB per platform), so there
 * the operator's `CODEX_CLI_PATH` is the only Codex there is.
 */
function resolveCodexLauncher(): { command: string; args: string[] } {
  const require_ = createRequire(import.meta.url);
  try {
    return { command: process.execPath, args: [require_.resolve('@openai/codex/bin/codex.js'), 'app-server'] };
  } catch {
    const configured = process.env.CODEX_CLI_PATH?.trim();
    if (configured) {
      return { command: configured, args: ['app-server'] };
    }
    throw new AppError('The Codex CLI package is not installed, so Codex conversations cannot be branched.', {
      code: 'CODEX_APP_SERVER_UNAVAILABLE',
      statusCode: 501,
    });
  }
}

/**
 * Runs one exchange against a freshly spawned `codex app-server`.
 *
 * A process per operation rather than a pooled long-lived one: the handshake
 * costs a fraction of a second, forking happens at most once per user action,
 * and a shared child would need lifecycle handling — restarts, back-pressure,
 * a crash taking every pending fork with it — for no measurable gain next to
 * the model turn that follows.
 */
async function withAppServer<T>(
  run: (call: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const launcher = resolveCodexLauncher();
  const child = spawn(launcher.command, launcher.args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // The server logs sandbox and skill warnings to stderr on every start. They
  // are not failures and drowning the app log in them helps nobody, so stderr
  // is only kept around to explain a spawn that dies.
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });

  let nextRequestId = 1;
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let exitReason: string | null = null;

  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      // Server-to-client notifications and any non-JSON banner are not
      // replies to anything this client asked for.
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  const failPending = (reason: string) => {
    exitReason = reason;
    for (const resolve of pending.values()) {
      resolve({ error: { message: reason } });
    }
    pending.clear();
  };

  child.on('error', (error) => failPending(error.message));
  child.on('exit', (code, signal) => {
    failPending(`codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
  });
  // A child that dies mid-request leaves its pipes broken, and the next write
  // raises EPIPE on the stream rather than at the call site. Without a
  // listener that is an unhandled 'error' event, which takes the whole server
  // down over one failed fork.
  child.stdin?.on('error', (error) => failPending(error.message));
  child.stdout?.on('error', (error) => failPending(error.message));
  child.stderr?.on('error', () => {});

  const call = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (exitReason) {
        reject(new AppError(`Codex app-server is not running: ${exitReason}`, {
          code: 'CODEX_APP_SERVER_UNAVAILABLE',
          statusCode: 502,
        }));
        return;
      }

      const id = nextRequestId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AppError(`Codex app-server did not answer "${method}" within ${REQUEST_TIMEOUT_MS}ms.`, {
          code: 'CODEX_APP_SERVER_TIMEOUT',
          statusCode: 504,
        }));
      }, REQUEST_TIMEOUT_MS);

      pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.error) {
          reject(new AppError(response.error.message || `Codex app-server rejected "${method}".`, {
            code: 'CODEX_APP_SERVER_ERROR',
            statusCode: 502,
            details: { method, rpcCode: response.error.code },
          }));
          return;
        }
        resolve(response.result);
      });

      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    // `capabilities` is deliberately empty. `thread/fork` with `lastTurnId` is
    // in the stable protocol; only `beforeTurnId` and the turn-listing methods
    // are gated behind `experimentalApi`, and neither is needed here.
    await call('initialize', {
      clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1' },
      capabilities: {},
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);

    return await run(call);
  } catch (error) {
    if (error instanceof AppError && exitReason) {
      throw new AppError(`${error.message}${stderr ? ` — ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`, {
        code: error.code,
        statusCode: error.statusCode,
      });
    }
    throw error;
  } finally {
    reader.close();
    child.kill();
  }
}

/**
 * What `account/read` and `account/rateLimits/read` report for one signed-in
 * account. Both payloads are passed through untouched; the accounts module
 * owns their normalization so this client stays a transport.
 */
export type CodexAccountSnapshot = {
  account: unknown;
  rateLimits: unknown;
};

/** One account hook's trust state, as `hooks.state."<key>"` holds it; null removes the entry. */
export type HookStateEdit = { trusted_hash: string; enabled?: false } | null;

/**
 * What each extra account's hook trust must be so that it matches the
 * default home's.
 *
 * Fork (Hemilake): an extra account's `hooks.json` and `config.toml` are
 * symlinks to the default home's, so Codex finds the same hooks there, but it
 * keys its trust by the path of the file that declares a hook
 * (`<hooks.json path>:<event>:<group>:<handler>`), and a hook trusted under
 * `~/.codex/hooks.json` is untrusted under `<account>/hooks.json`. For every
 * user hook declared in the default home, the same key under each account's
 * path gets the hash Codex reports when the default home trusts it (and
 * `enabled = false` when it is turned off there), and is removed when the
 * default home does not trust it, so a revoked hook stops on every account.
 * Project, managed and system hooks are left alone.
 */
export function accountTrustEdits(
  hooks: unknown,
  defaultHome: string,
  accountHomes: string[],
): Record<string, HookStateEdit> {
  const edits: Record<string, HookStateEdit> = {};
  const home = path.resolve(defaultHome);
  for (const hook of Array.isArray(hooks) ? hooks : []) {
    const entry = hook as Record<string, unknown> | null;
    const key = entry?.key;
    const sourcePath = entry?.sourcePath;
    const digest = entry?.currentHash;
    if (
      entry?.source !== 'user'
      || typeof key !== 'string'
      || typeof sourcePath !== 'string'
      || path.dirname(path.resolve(sourcePath)) !== home
      || !key.startsWith(`${sourcePath}:`)
    ) {
      continue;
    }
    const trusted = entry.trustStatus === 'trusted' && typeof digest === 'string' && digest !== '';
    const state: HookStateEdit = trusted
      ? { trusted_hash: digest as string, ...(entry.enabled === false ? { enabled: false as const } : {}) }
      : null;
    for (const account of accountHomes) {
      if (path.resolve(account) === home) {
        continue;
      }
      edits[path.join(account, path.basename(sourcePath)) + key.slice(sourcePath.length)] = state;
    }
  }
  return edits;
}

/** `hooks.state."<key>"` as a config keyPath: the key quoted, its `"` and `\` escaped. */
function hookStateKeyPath(key: string): string {
  return `hooks.state."${key.replace(/[\\"]/g, '\\$&')}"`;
}

export const codexAppServer = {
  /**
   * Reads the account and plan limits of whichever login lives in
   * `codexHome`. Each account is its own CODEX_HOME, so pointing the server
   * at one is all it takes to ask about that account instead of the default.
   */
  async readAccount(input: { codexHome: string }): Promise<CodexAccountSnapshot> {
    return withAppServer(async (call) => {
      const account = await call('account/read', {});
      const rateLimits = await call('account/rateLimits/read', {});
      return { account, rateLimits };
    }, { ...process.env, CODEX_HOME: input.codexHome });
  },

  /** The hooks Codex finds under `codexHome`, with their trust status and hash (`hooks/list`). */
  async listHooks(input: { codexHome: string }): Promise<unknown[]> {
    return withAppServer(async (call) => {
      const listed = await call('hooks/list', { cwds: [input.codexHome] }) as { data?: unknown } | undefined;
      return (Array.isArray(listed?.data) ? listed.data : [])
        .flatMap((entry) => (Array.isArray((entry as { hooks?: unknown })?.hooks) ? (entry as { hooks: unknown[] }).hooks : []));
    }, { ...process.env, CODEX_HOME: input.codexHome });
  },

  /**
   * Gives each account home the trust the default home has in the hooks they
   * share (accountTrustEdits), in one app-server exchange that lists and
   * writes the default home's `config.toml`, which every account links to.
   * Returns how many keys were written.
   */
  async mirrorHookTrust(input: { defaultHome: string; accountHomes: string[] }): Promise<number> {
    return withAppServer(async (call) => {
      const listed = await call('hooks/list', { cwds: [input.defaultHome] }) as { data?: unknown } | undefined;
      const hooks = (Array.isArray(listed?.data) ? listed.data : [])
        .flatMap((entry) => (Array.isArray((entry as { hooks?: unknown })?.hooks) ? (entry as { hooks: unknown[] }).hooks : []));
      const edits = Object.entries(accountTrustEdits(hooks, input.defaultHome, input.accountHomes));
      if (edits.length === 0) {
        return 0;
      }
      await call('config/batchWrite', {
        edits: edits.map(([key, value]) => ({ keyPath: hookStateKeyPath(key), value, mergeStrategy: 'replace' })),
      });
      return edits.length;
    }, { ...process.env, CODEX_HOME: input.defaultHome });
  },

  /**
   * Copies a thread into a new one that ends at `lastTurnId`, or copies the
   * whole thread when it is omitted.
   *
   * `lastTurnId` is inclusive of the turn it names, which is the same
   * convention the app's edit anchor uses ("the last row to keep").
   *
   * `cwd` decides the working directory recorded in the copy's `session_meta`,
   * and that field is what the session indexer keys a session's project off —
   * omitting it would file every fork under whatever directory this server
   * happens to be running from.
   */
  async forkThread(input: {
    threadId: string;
    lastTurnId?: string;
    cwd: string;
  }): Promise<CodexThreadFork> {
    return withAppServer(async (call) => {
      const result = await call('thread/fork', {
        threadId: input.threadId,
        ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }) as { thread?: { id?: unknown; path?: unknown } } | undefined;

      const threadId = typeof result?.thread?.id === 'string' ? result.thread.id : '';
      const path = typeof result?.thread?.path === 'string' ? result.thread.path : '';
      if (!threadId || !path) {
        throw new AppError('Codex reported a fork without a thread id or transcript path.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      // Confirmed rather than trusted: both callers are about to point a
      // database row at this file, and a row naming a transcript that is not
      // there is a session that can never be opened.
      try {
        await stat(path);
      } catch {
        throw new AppError('Codex reported a fork but wrote no transcript for it.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      return { threadId, path };
    });
  },
};
