/**
 * Last known plan usage of each Codex account.
 *
 * Read through the official `codex app-server` (`account/read` plus
 * `account/rateLimits/read`) with the account's CODEX_HOME, never by opening
 * its tokens. Reads are cached and coalesced: the selector asks before every
 * turn, but only stale entries trigger a read, and a slow read never holds a
 * turn up for long.
 */

import { codexAppServer, type CodexAccountSnapshot } from '@/modules/providers/list/codex/codex-app-server.client.js';

import { hasAuthFile } from './codex-accounts.registry.js';
import type { CodexAccountRecord, CodexAccountUsage, CodexUsageWindow } from './codex-accounts.types.js';

/** Fallback when a failed turn names no reset time. */
const EXHAUSTED_FALLBACK_MS = 15 * 60_000;
/** A read must postdate an exhaustion mark by this much to clear it. */
const EXHAUSTION_CONFIRM_MS = 60_000;

type Record_ = Record<string, unknown>;

function record(value: unknown): Record_ | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record_ : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readWindow(value: unknown): CodexUsageWindow | null {
  const raw = record(value);
  const usedPercent = finite(raw?.usedPercent);
  if (!raw || usedPercent === null) {
    return null;
  }
  const resetsAt = finite(raw.resetsAt);
  return {
    usedPercent: Math.min(Math.max(usedPercent, 0), 100),
    windowDurationMins: finite(raw.windowDurationMins) ?? 0,
    resetsAt: resetsAt === null ? null : resetsAt * 1000,
  };
}

/** Turns the two app-server payloads into the account's usage entry. */
export function normalizeAccountSnapshot(snapshot: CodexAccountSnapshot, now: number): CodexAccountUsage {
  const account = record(record(snapshot.account)?.account);
  const limitsResult = record(snapshot.rateLimits) ?? {};
  const byId = record(limitsResult.rateLimitsByLimitId);
  const limits = (byId ? Object.values(byId) : [limitsResult.rateLimits])
    .map(record)
    .filter((limit): limit is Record_ => limit !== null);

  const windows = limits.flatMap((limit) => [readWindow(limit.primary), readWindow(limit.secondary)])
    .filter((window): window is CodexUsageWindow => window !== null);
  const reachedType = limits.map((limit) => text(limit.rateLimitReachedType)).find(Boolean) ?? null;
  const planType = text(account?.planType) ?? limits.map((limit) => text(limit.planType)).find(Boolean) ?? null;

  return {
    fetchedAt: now,
    signedIn: account !== null,
    email: text(account?.email),
    planType,
    windows,
    reachedType,
    error: null,
    exhaustedUntil: null,
  };
}

export const NEVER_READ: CodexAccountUsage = {
  fetchedAt: 0,
  signedIn: true,
  email: null,
  planType: null,
  windows: [],
  reachedType: null,
  error: null,
  exhaustedUntil: null,
};

type Reader = (account: CodexAccountRecord) => Promise<CodexAccountSnapshot>;

export class CodexAccountUsageTracker {
  private readonly entries = new Map<string, CodexAccountUsage>();
  private readonly inflight = new Map<string, Promise<CodexAccountUsage>>();
  private readonly exhaustionMarkedAt = new Map<string, number>();

  constructor(
    private readonly reader: Reader = (account) => codexAppServer.readAccount({ codexHome: account.codexHome }),
    private readonly authFileExists: (codexHome: string) => Promise<boolean> = hasAuthFile,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): ReadonlyMap<string, CodexAccountUsage> {
    return this.entries;
  }

  get(accountId: string): CodexAccountUsage | undefined {
    return this.entries.get(accountId);
  }

  forget(accountId: string): void {
    this.entries.delete(accountId);
    this.exhaustionMarkedAt.delete(accountId);
  }

  /** Reads one account now, sharing a read already in flight. */
  refresh(account: CodexAccountRecord): Promise<CodexAccountUsage> {
    const running = this.inflight.get(account.id);
    if (running) {
      return running;
    }
    const read = this.read(account).finally(() => this.inflight.delete(account.id));
    this.inflight.set(account.id, read);
    return read;
  }

  /**
   * Refreshes every account older than `maxAgeMs`, waiting at most
   * `timeoutMs`. Reads that take longer keep running and land in the cache
   * for the next turn.
   */
  async ensureFresh(accounts: CodexAccountRecord[], maxAgeMs: number, timeoutMs: number): Promise<void> {
    const now = this.now();
    const stale = accounts.filter((account) => {
      const entry = this.entries.get(account.id);
      return !entry || now - entry.fetchedAt > maxAgeMs;
    });
    if (stale.length === 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(stale.map((account) => this.refresh(account))),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
  }

  /**
   * Records that a turn just failed on the account's limit. Until a read
   * newer than this confirms room again, the selector treats the account as
   * empty, since the cached numbers evidently lagged behind.
   */
  markExhausted(accountId: string): void {
    const now = this.now();
    const entry = this.entries.get(accountId) ?? { ...NEVER_READ };
    const resets = entry.windows
      .map((window) => window.resetsAt)
      .filter((value): value is number => value !== null && value > now);
    const until = resets.length > 0 ? Math.min(...resets) : now + EXHAUSTED_FALLBACK_MS;
    this.exhaustionMarkedAt.set(accountId, now);
    this.entries.set(accountId, { ...entry, exhaustedUntil: until });
  }

  private async read(account: CodexAccountRecord): Promise<CodexAccountUsage> {
    const previous = this.entries.get(account.id);
    let next: CodexAccountUsage;
    if (!(await this.authFileExists(account.codexHome))) {
      next = { ...NEVER_READ, fetchedAt: this.now(), signedIn: false, error: 'Not signed in' };
    } else {
      try {
        next = normalizeAccountSnapshot(await this.reader(account), this.now());
      } catch (error) {
        // Keep the last numbers: an app-server hiccup says nothing about the
        // plan, and dropping them would make the account look unread.
        next = {
          ...(previous ?? NEVER_READ),
          fetchedAt: this.now(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const markedAt = this.exhaustionMarkedAt.get(account.id);
    if (markedAt !== undefined && previous?.exhaustedUntil) {
      const confirmsRoom = next.error === null
        && next.fetchedAt - markedAt >= EXHAUSTION_CONFIRM_MS
        && next.reachedType === null
        && next.windows.every((window) => window.usedPercent < 100);
      if (confirmsRoom || previous.exhaustedUntil <= this.now()) {
        this.exhaustionMarkedAt.delete(account.id);
      } else {
        next = { ...next, exhaustedUntil: previous.exhaustedUntil };
      }
    }

    this.entries.set(account.id, next);
    return next;
  }
}
