/**
 * The Codex account registry on disk.
 *
 * Layout under the accounts root (`$CLOUDCLI_CODEX_ACCOUNTS_DIR`, else
 * `~/.cloudcli/codex-accounts`):
 *
 *   accounts.json        the registry, also read by the Codex Usage plugin
 *   <account-id>/        one CODEX_HOME per extra account
 *
 * The default account is the user's ordinary `~/.codex` (or `$CODEX_HOME`)
 * and is always present as id `default`, so a user who never adds an account
 * runs exactly as before. An extra account's home holds its own `auth.json`
 * and a symlink to every other entry of the default home: Codex then finds
 * the same sessions, config, skills, hooks and thread databases whichever
 * account runs the turn, and a session started on one account resumes on
 * another. Checked on 2026-10-26 with codex-cli 0.153.4: a thread started in
 * `~/.codex` resumes from such a home, and SQLite follows the symlinked
 * databases (no stray WAL next to the link).
 */

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CodexAccountMode, CodexAccountRecord, CodexAccountsRegistry } from './codex-accounts.types.js';

export const DEFAULT_CODEX_ACCOUNT_ID = 'default';
const REGISTRY_FILE = 'accounts.json';
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Entries of the default home an extra account must NOT share. `auth.json`
 * is the whole point of the account; the model cache and caches depend on
 * the plan; the control socket belongs to one running app-server; logs and
 * temp dirs are per process anyway.
 */
const PRIVATE_ENTRIES = new Set([
  'auth.json',
  'app-server-control',
  'models_cache.json',
  'cache',
  'installation_id',
  'log',
  'tmp',
  '.tmp',
]);
const PRIVATE_ENTRY_PATTERNS = [/^logs_\d+\.sqlite$/, /-(wal|shm|journal)$/];

export function isPrivateCodexHomeEntry(name: string): boolean {
  return PRIVATE_ENTRIES.has(name) || PRIVATE_ENTRY_PATTERNS.some((pattern) => pattern.test(name));
}

export function codexAccountsRoot(): string {
  const configured = process.env.CLOUDCLI_CODEX_ACCOUNTS_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.cloudcli', 'codex-accounts');
}

export function defaultCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex');
}

function defaultAccount(createdAt = new Date().toISOString()): CodexAccountRecord {
  return {
    id: DEFAULT_CODEX_ACCOUNT_ID,
    label: 'Default',
    codexHome: defaultCodexHome(),
    enabled: true,
    createdAt,
  };
}

export function emptyRegistry(): CodexAccountsRegistry {
  return {
    version: 1,
    mode: 'backup',
    primaryAccountId: DEFAULT_CODEX_ACCOUNT_ID,
    minHeadroomPercent: 5,
    planWeights: {},
    roundRobinCursor: null,
    accounts: [defaultAccount()],
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Rebuilds a registry from whatever the file holds, keeping only what is
 * valid. A hand-edited or half-written file degrades to the default account
 * rather than stopping Codex.
 */
export function sanitizeRegistry(raw: unknown): CodexAccountsRegistry {
  const base = emptyRegistry();
  const input = readRecord(raw);
  if (!input) {
    return base;
  }

  const root = codexAccountsRoot();
  const seen = new Set<string>();
  const accounts: CodexAccountRecord[] = [];
  for (const entry of Array.isArray(input.accounts) ? input.accounts : []) {
    const record = readRecord(entry);
    const id = typeof record?.id === 'string' ? record.id : '';
    if (!record || !ACCOUNT_ID_PATTERN.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const createdAt = typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString();
    if (id === DEFAULT_CODEX_ACCOUNT_ID) {
      accounts.push({
        ...defaultAccount(createdAt),
        label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : 'Default',
        enabled: record.enabled !== false,
      });
      continue;
    }
    accounts.push({
      id,
      label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : id,
      // The home is derived, never trusted from the file: a registry entry
      // must not be able to point Codex at an arbitrary directory.
      codexHome: path.join(root, id),
      enabled: record.enabled !== false,
      createdAt,
    });
  }
  if (!seen.has(DEFAULT_CODEX_ACCOUNT_ID)) {
    accounts.unshift(defaultAccount());
  }

  const mode: CodexAccountMode = input.mode === 'round_robin' ? 'round_robin' : 'backup';
  const primaryAccountId = typeof input.primaryAccountId === 'string' && seen.has(input.primaryAccountId)
    ? input.primaryAccountId
    : DEFAULT_CODEX_ACCOUNT_ID;
  const minHeadroom = Number(input.minHeadroomPercent);
  const planWeights: Record<string, number> = {};
  for (const [plan, weight] of Object.entries(readRecord(input.planWeights) ?? {})) {
    const value = Number(weight);
    if (Number.isFinite(value) && value > 0) {
      planWeights[plan.toLowerCase()] = value;
    }
  }

  return {
    version: 1,
    mode,
    primaryAccountId,
    minHeadroomPercent: Number.isFinite(minHeadroom) ? Math.min(Math.max(minHeadroom, 0), 100) : base.minHeadroomPercent,
    planWeights,
    roundRobinCursor: typeof input.roundRobinCursor === 'string' && seen.has(input.roundRobinCursor)
      ? input.roundRobinCursor
      : null,
    accounts,
  };
}

export async function readRegistry(): Promise<CodexAccountsRegistry> {
  try {
    const content = await readFile(path.join(codexAccountsRoot(), REGISTRY_FILE), 'utf8');
    return sanitizeRegistry(JSON.parse(content));
  } catch {
    return emptyRegistry();
  }
}

export async function writeRegistry(registry: CodexAccountsRegistry): Promise<void> {
  const root = codexAccountsRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, REGISTRY_FILE);
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(sanitizeRegistry(registry), null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Links every shareable entry of the default home into an account's home.
 * Idempotent and additive: entries Codex created later in the default home
 * (a new database version after an upgrade, say) get linked on the next
 * call, and anything already in the account home is left alone.
 */
export async function syncAccountHome(codexHome: string): Promise<void> {
  const shared = defaultCodexHome();
  if (path.resolve(codexHome) === path.resolve(shared)) {
    return;
  }
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  let entries: string[];
  try {
    entries = await readdir(shared);
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((name) => !isPrivateCodexHomeEntry(name))
    .map(async (name) => {
      const link = path.join(codexHome, name);
      if (await exists(link)) {
        return;
      }
      try {
        await symlink(path.join(shared, name), link);
      } catch (error) {
        // A concurrent sync created it first; nothing to do.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }));
}

export function newAccountId(): string {
  return `acct-${randomBytes(3).toString('hex')}`;
}

/**
 * Deletes an extra account's home. `rm` removes the symlinks themselves, not
 * what they point at, so the shared default home is untouched; the path is
 * checked to sit inside the accounts root before anything is removed.
 */
export async function removeAccountHome(codexHome: string): Promise<void> {
  const root = path.resolve(codexAccountsRoot());
  const target = path.resolve(codexHome);
  if (path.dirname(target) !== root || target === path.resolve(defaultCodexHome())) {
    throw new Error(`Refusing to remove ${target}: it is not an account home under ${root}.`);
  }
  await rm(target, { recursive: true, force: true });
}

export async function hasAuthFile(codexHome: string): Promise<boolean> {
  return exists(path.join(codexHome, 'auth.json'));
}
