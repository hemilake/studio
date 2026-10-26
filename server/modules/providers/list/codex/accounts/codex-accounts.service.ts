/**
 * Multi-account Codex: the glue between the registry on disk, the usage
 * tracker, the selector and the session mapping in the database.
 *
 * With only the default account registered every call short-circuits to it,
 * without reading usage, so a user who never adds an account sees no change.
 */

import { codexSessionAccountsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import {
  DEFAULT_CODEX_ACCOUNT_ID,
  newAccountId,
  readRegistry,
  removeAccountHome,
  syncAccountHome,
  writeRegistry,
} from './codex-accounts.registry.js';
import { remainingPercent, selectCodexAccount } from './codex-accounts.selector.js';
import type {
  CodexAccountMode,
  CodexAccountRecord,
  CodexAccountSelection,
  CodexAccountsRegistry,
  CodexAccountUsage,
} from './codex-accounts.types.js';
import { CodexAccountUsageTracker } from './codex-accounts.usage.js';

/** Usage older than this is re-read before a turn picks an account. */
const TURN_USAGE_MAX_AGE_MS = 2 * 60_000;
/** Longest a turn waits for those reads. */
const TURN_USAGE_WAIT_MS = 4_000;
/** The settings page shows fresher numbers and can wait a little longer. */
const LIST_USAGE_MAX_AGE_MS = 60_000;
const LIST_USAGE_WAIT_MS = 10_000;

/** Codex's own wording when a plan limit stops a turn. */
const USAGE_LIMIT_PATTERN = /usage[ _]limit|hit your (usage )?limit|rate_limit_reached|usageLimitExceeded/i;

export function isUsageLimitMessage(message: unknown): boolean {
  return typeof message === 'string' && USAGE_LIMIT_PATTERN.test(message);
}

export type CodexAccountView = CodexAccountRecord & {
  isPrimary: boolean;
  /** Sessions currently mapped to it. */
  sessions: number;
  usage: CodexAccountUsage | null;
  /** Percent of the tightest window still free; null when unknown. */
  remainingPercent: number | null;
};

export type CodexAccountsView = Omit<CodexAccountsRegistry, 'accounts'> & {
  accounts: CodexAccountView[];
};

export type CodexTurnAccount = CodexAccountSelection & {
  account: CodexAccountRecord;
};

export type CodexAccountsSettingsInput = {
  mode?: CodexAccountMode;
  primaryAccountId?: string;
  minHeadroomPercent?: number;
  planWeights?: Record<string, number>;
  /** Full new priority order (account ids). */
  order?: string[];
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class CodexAccountsService {
  /** Serializes registry writes so concurrent turns cannot lose an update. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(readonly usage = new CodexAccountUsageTracker()) {}

  private mutate<T>(change: (registry: CodexAccountsRegistry) => Promise<T> | T): Promise<T> {
    const run = this.writeQueue.then(async () => {
      const registry = await readRegistry();
      const result = await change(registry);
      await writeRegistry(registry);
      return result;
    });
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async requireAccount(registry: CodexAccountsRegistry, accountId: string): Promise<CodexAccountRecord> {
    const account = registry.accounts.find((entry) => entry.id === accountId);
    if (!account) {
      throw new AppError(`Codex account "${accountId}" does not exist.`, {
        code: 'CODEX_ACCOUNT_NOT_FOUND',
        statusCode: 404,
      });
    }
    return account;
  }

  async list(options: { refresh?: boolean } = {}): Promise<CodexAccountsView> {
    const registry = await readRegistry();
    await this.usage.ensureFresh(
      registry.accounts,
      options.refresh ? 0 : LIST_USAGE_MAX_AGE_MS,
      LIST_USAGE_WAIT_MS,
    );
    let counts: Record<string, number> = {};
    try {
      counts = codexSessionAccountsDb.countByAccount();
    } catch {
      // The counts are decoration; a database hiccup must not hide accounts.
    }
    const now = Date.now();
    return {
      ...registry,
      accounts: registry.accounts.map((account) => {
        const usage = this.usage.get(account.id) ?? null;
        return {
          ...account,
          isPrimary: account.id === registry.primaryAccountId,
          sessions: counts[account.id] ?? 0,
          usage,
          remainingPercent: remainingPercent(usage ?? undefined, now),
        };
      }),
    };
  }

  /**
   * Registers a new account and prepares its home. The returned command runs
   * the Codex login inside that home; device auth first because Studio is
   * usually opened from another machine than the one running Codex, with the
   * browser flow as fallback for workspaces that have device codes disabled.
   */
  async create(label: string): Promise<{ account: CodexAccountRecord; loginCommand: string }> {
    const cleanLabel = label.trim().slice(0, 80);
    if (!cleanLabel) {
      throw new AppError('An account needs a name.', { code: 'CODEX_ACCOUNT_LABEL_REQUIRED', statusCode: 400 });
    }
    const account = await this.mutate(async (registry) => {
      let id = newAccountId();
      while (registry.accounts.some((entry) => entry.id === id)) {
        id = newAccountId();
      }
      const created: CodexAccountRecord = {
        id,
        label: cleanLabel,
        codexHome: '',
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      registry.accounts.push(created);
      return created;
    });
    // sanitizeRegistry derives the home from the id; read it back from there.
    const stored = await this.requireAccount(await readRegistry(), account.id);
    await syncAccountHome(stored.codexHome);
    return { account: stored, loginCommand: this.loginCommand(stored) };
  }

  loginCommand(account: CodexAccountRecord): string {
    const home = shellQuote(account.codexHome);
    return `export CODEX_HOME=${home}; codex login --device-auth || codex login`;
  }

  async getLoginCommand(accountId: string): Promise<string> {
    const account = await this.requireAccount(await readRegistry(), accountId);
    await syncAccountHome(account.codexHome);
    return this.loginCommand(account);
  }

  async update(accountId: string, input: { label?: string; enabled?: boolean }): Promise<CodexAccountRecord> {
    return this.mutate(async (registry) => {
      const account = await this.requireAccount(registry, accountId);
      if (typeof input.label === 'string' && input.label.trim()) {
        account.label = input.label.trim().slice(0, 80);
      }
      if (typeof input.enabled === 'boolean') {
        if (!input.enabled && registry.accounts.filter((entry) => entry.enabled).length <= 1 && account.enabled) {
          throw new AppError('At least one Codex account must stay enabled.', {
            code: 'CODEX_ACCOUNT_LAST_ENABLED',
            statusCode: 400,
          });
        }
        account.enabled = input.enabled;
      }
      return { ...account };
    });
  }

  async remove(accountId: string): Promise<void> {
    if (accountId === DEFAULT_CODEX_ACCOUNT_ID) {
      throw new AppError('The default Codex account cannot be removed; sign it out with Codex instead.', {
        code: 'CODEX_ACCOUNT_DEFAULT',
        statusCode: 400,
      });
    }
    const removed = await this.mutate(async (registry) => {
      const account = await this.requireAccount(registry, accountId);
      registry.accounts = registry.accounts.filter((entry) => entry.id !== accountId);
      if (registry.primaryAccountId === accountId) {
        registry.primaryAccountId = DEFAULT_CODEX_ACCOUNT_ID;
      }
      if (registry.roundRobinCursor === accountId) {
        registry.roundRobinCursor = null;
      }
      if (!registry.accounts.some((entry) => entry.enabled)) {
        registry.accounts[0].enabled = true;
      }
      return account;
    });
    await removeAccountHome(removed.codexHome);
    this.usage.forget(accountId);
    try {
      codexSessionAccountsDb.clearAccount(accountId);
    } catch {
      // Stale mappings are harmless: the selector ignores unknown accounts.
    }
  }

  async updateSettings(input: CodexAccountsSettingsInput): Promise<void> {
    await this.mutate(async (registry) => {
      if (input.mode === 'round_robin' || input.mode === 'backup') {
        registry.mode = input.mode;
      }
      if (typeof input.primaryAccountId === 'string') {
        await this.requireAccount(registry, input.primaryAccountId);
        registry.primaryAccountId = input.primaryAccountId;
      }
      if (typeof input.minHeadroomPercent === 'number' && Number.isFinite(input.minHeadroomPercent)) {
        registry.minHeadroomPercent = Math.min(Math.max(input.minHeadroomPercent, 0), 100);
      }
      if (input.planWeights && typeof input.planWeights === 'object') {
        registry.planWeights = input.planWeights;
      }
      if (Array.isArray(input.order)) {
        const position = new Map(input.order.map((id, index) => [id, index]));
        registry.accounts.sort((a, b) =>
          (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER));
      }
    });
  }

  async refresh(accountId: string): Promise<CodexAccountUsage> {
    const account = await this.requireAccount(await readRegistry(), accountId);
    return this.usage.refresh(account);
  }

  /**
   * Picks the account one turn runs on and records it for the session.
   * `exclude` lists accounts that already failed this turn on their limit.
   */
  async resolveForTurn(input: {
    sessionId: string | null;
    effort?: string | null;
    exclude?: ReadonlySet<string>;
  }): Promise<CodexTurnAccount> {
    const registry = await readRegistry();
    if (registry.accounts.length === 1) {
      return { account: registry.accounts[0], accountId: registry.accounts[0].id, reason: 'single', switchedFrom: null };
    }

    let currentAccountId: string | null = null;
    if (input.sessionId) {
      try {
        currentAccountId = codexSessionAccountsDb.getAccountId(input.sessionId);
      } catch {
        currentAccountId = null;
      }
    }

    await this.usage.ensureFresh(
      registry.accounts.filter((account) => account.enabled),
      TURN_USAGE_MAX_AGE_MS,
      TURN_USAGE_WAIT_MS,
    );
    const selection = selectCodexAccount({
      registry,
      usage: this.usage.snapshot(),
      currentAccountId,
      effort: input.effort,
      exclude: input.exclude,
      now: Date.now(),
    });
    const account = registry.accounts.find((entry) => entry.id === selection.accountId) ?? registry.accounts[0];

    if (selection.reason === 'round_robin') {
      await this.mutate((stored) => {
        stored.roundRobinCursor = account.id;
      });
    }
    if (input.sessionId && currentAccountId !== account.id) {
      try {
        codexSessionAccountsDb.setAccountId(input.sessionId, account.id);
      } catch (error) {
        console.warn('[Codex accounts] Could not record the session account:', error);
      }
    }
    await syncAccountHome(account.codexHome);
    return { ...selection, account };
  }

  /** Records the account a brand-new session got once its id is known. */
  rememberSessionAccount(sessionId: string, accountId: string): void {
    try {
      codexSessionAccountsDb.setAccountId(sessionId, accountId);
    } catch (error) {
      console.warn('[Codex accounts] Could not record the session account:', error);
    }
  }

  markExhausted(accountId: string): void {
    this.usage.markExhausted(accountId);
  }

  /** Re-reads an account shortly after a turn so the next pick sees its cost. */
  refreshSoon(account: CodexAccountRecord): void {
    const timer = setTimeout(() => {
      void this.usage.refresh(account).catch(() => undefined);
    }, 5_000);
    timer.unref?.();
  }

  /** Environment for a Codex process running as `account`. */
  environmentFor(account: CodexAccountRecord): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        environment[key] = value;
      }
    }
    environment.CODEX_HOME = account.codexHome;
    return environment;
  }
}

export const codexAccountsService = new CodexAccountsService();
