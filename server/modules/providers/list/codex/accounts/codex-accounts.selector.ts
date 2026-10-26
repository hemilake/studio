/**
 * Picks the Codex account a turn runs on. Pure: everything it needs comes in
 * as arguments, so the policy is testable without Codex or a database.
 *
 * The rules, in order:
 * 1. A session keeps the account it already has while that account can take
 *    the turn, so the provider's prompt cache keeps working.
 * 2. Otherwise, backup mode walks the priority list starting at the primary;
 *    round robin takes the next account after the last one it handed out.
 * 3. "Can take the turn" means enabled, signed in, not at a limit, and with
 *    enough headroom for the turn's reasoning effort, where headroom is
 *    weighed by plan size: 10 % left on Pro is more room than 10 % on Plus.
 * 4. When nothing qualifies, the account with the most weighted headroom
 *    runs it anyway, so the user gets Codex's own limit message instead of
 *    a silent refusal.
 */

import type {
  CodexAccountRecord,
  CodexAccountSelection,
  CodexAccountsRegistry,
  CodexAccountUsage,
} from './codex-accounts.types.js';

/**
 * Codex capacity of each plan relative to Plus. Estimates from OpenAI's
 * published multipliers; unknown plans count as Plus. The registry's
 * `planWeights` overrides any entry.
 */
export const DEFAULT_PLAN_WEIGHTS: Record<string, number> = {
  free: 0.25,
  go: 0.5,
  plus: 1,
  team: 1,
  business: 1,
  enterprise: 1,
  edu: 1,
  pro: 6,
};

/** How much more headroom a turn needs as its reasoning effort grows. */
const EFFORT_HEADROOM_FACTOR: Record<string, number> = {
  minimal: 0.5,
  low: 1,
  medium: 1,
  high: 2,
  xhigh: 3,
};

export function planWeight(planType: string | null, overrides: Record<string, number> = {}): number {
  if (!planType) {
    return 1;
  }
  const key = planType.toLowerCase();
  const table = { ...DEFAULT_PLAN_WEIGHTS, ...overrides };
  if (typeof table[key] === 'number') {
    return table[key];
  }
  // Codex reports compound names such as `self_serve_business_prolite`; match
  // the most specific known plan inside them, longest name first.
  const match = Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find((name) => key.split(/[^a-z0-9]+/).includes(name));
  return match ? table[match] : 1;
}

/**
 * Percent of the tightest window still free, or null when the account has
 * never been read. Windows whose reset time has passed count as empty.
 */
export function remainingPercent(usage: CodexAccountUsage | undefined, now: number): number | null {
  if (!usage || usage.fetchedAt === 0) {
    return null;
  }
  if (usage.exhaustedUntil && usage.exhaustedUntil > now) {
    return 0;
  }
  const live = usage.windows.filter((window) => window.resetsAt === null || window.resetsAt > now);
  if (usage.reachedType && live.length > 0) {
    return 0;
  }
  if (live.length === 0) {
    return usage.windows.length > 0 ? 100 : null;
  }
  const used = Math.max(...live.map((window) => window.usedPercent));
  return Math.max(0, 100 - used);
}

type Candidate = {
  account: CodexAccountRecord;
  /** Weighted headroom; null when unknown. */
  headroom: number | null;
  eligible: boolean;
};

function evaluate(
  account: CodexAccountRecord,
  usage: CodexAccountUsage | undefined,
  registry: CodexAccountsRegistry,
  requiredHeadroom: number,
  now: number,
): Candidate {
  if (!account.enabled || usage?.signedIn === false) {
    return { account, headroom: null, eligible: false };
  }
  const remaining = remainingPercent(usage, now);
  if (remaining === null) {
    // Never read (or the read failed): worth trying rather than skipping, a
    // brand-new login has no usage yet.
    return { account, headroom: null, eligible: true };
  }
  const headroom = remaining * planWeight(usage?.planType ?? null, registry.planWeights);
  return { account, headroom, eligible: remaining > 0 && headroom >= requiredHeadroom };
}

export function requiredHeadroomFor(effort: string | null | undefined, minHeadroomPercent: number): number {
  const factor = EFFORT_HEADROOM_FACTOR[(effort || 'medium').toLowerCase()] ?? 1;
  return minHeadroomPercent * factor;
}

export function selectCodexAccount(input: {
  registry: CodexAccountsRegistry;
  usage: ReadonlyMap<string, CodexAccountUsage>;
  /** Account the session ran on last, if any. */
  currentAccountId: string | null;
  effort?: string | null;
  /** Accounts already tried for this turn. */
  exclude?: ReadonlySet<string>;
  now: number;
}): CodexAccountSelection {
  const { registry, usage, currentAccountId, now } = input;
  const exclude = input.exclude ?? new Set<string>();
  const accounts = registry.accounts;

  if (accounts.length === 1) {
    return { accountId: accounts[0].id, reason: 'single', switchedFrom: null };
  }

  const required = requiredHeadroomFor(input.effort, registry.minHeadroomPercent);
  const candidates = accounts
    .filter((account) => !exclude.has(account.id))
    .map((account) => evaluate(account, usage.get(account.id), registry, required, now));
  const byId = new Map(candidates.map((candidate) => [candidate.account.id, candidate]));
  const switchedFrom = currentAccountId && accounts.some((a) => a.id === currentAccountId)
    ? currentAccountId
    : null;
  const pick = (candidate: Candidate, reason: CodexAccountSelection['reason']): CodexAccountSelection => ({
    accountId: candidate.account.id,
    reason,
    switchedFrom: switchedFrom && switchedFrom !== candidate.account.id ? switchedFrom : null,
  });

  const current = currentAccountId ? byId.get(currentAccountId) : undefined;
  if (current?.eligible) {
    return pick(current, 'sticky');
  }

  if (registry.mode === 'backup') {
    const primary = byId.get(registry.primaryAccountId);
    if (primary?.eligible) {
      return pick(primary, 'primary');
    }
    const backup = candidates.find((candidate) => candidate.eligible);
    if (backup) {
      return pick(backup, 'backup');
    }
  } else {
    const cursorIndex = registry.roundRobinCursor
      ? candidates.findIndex((candidate) => candidate.account.id === registry.roundRobinCursor)
      : -1;
    for (let step = 1; step <= candidates.length; step += 1) {
      const candidate = candidates[(cursorIndex + step + candidates.length) % candidates.length];
      if (candidate.eligible) {
        return pick(candidate, 'round_robin');
      }
    }
  }

  const usable = candidates.filter((candidate) => candidate.account.enabled && usage.get(candidate.account.id)?.signedIn !== false);
  const best = usable
    .filter((candidate) => candidate.headroom !== null)
    .sort((a, b) => (b.headroom ?? 0) - (a.headroom ?? 0))[0]
    ?? usable[0]
    ?? candidates.find((candidate) => candidate.account.enabled)
    ?? byId.get(registry.primaryAccountId)
    ?? { account: accounts[0], headroom: null, eligible: false };
  return pick(best, 'fallback');
}
