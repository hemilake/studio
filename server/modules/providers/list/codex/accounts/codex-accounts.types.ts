/**
 * Shared shapes of the Codex multi-account feature.
 *
 * Each account is a separate CODEX_HOME holding its own `auth.json`; every
 * other file of the home is a symlink into the default `~/.codex`, so
 * sessions, config, skills and thread state stay one set whichever account
 * runs a turn. The registry file describing them (`accounts.json`) is also
 * read by the Codex Usage plugin, so its shape is a contract: add fields,
 * never rename them.
 */

/** How a new session picks its account. */
export type CodexAccountMode = 'round_robin' | 'backup';

export type CodexAccountRecord = {
  id: string;
  label: string;
  /** Absolute CODEX_HOME of this account. */
  codexHome: string;
  /** Disabled accounts are never picked, but keep their login. */
  enabled: boolean;
  createdAt: string;
};

export type CodexAccountsRegistry = {
  version: 1;
  mode: CodexAccountMode;
  /** The account backup mode always tries first. */
  primaryAccountId: string;
  /**
   * Headroom an account needs, in percent of a Plus-sized window, before it
   * takes a turn of medium effort. Higher efforts multiply it.
   */
  minHeadroomPercent: number;
  /** Per-plan capacity relative to Plus; overrides the built-in table. */
  planWeights: Record<string, number>;
  /** Last account round robin handed a new session to. */
  roundRobinCursor: string | null;
  /** Priority order: backup mode falls through it, round robin rotates it. */
  accounts: CodexAccountRecord[];
};

export type CodexUsageWindow = {
  usedPercent: number;
  windowDurationMins: number;
  /** Epoch ms, or null when Codex did not say. */
  resetsAt: number | null;
};

/** Last known plan state of one account. */
export type CodexAccountUsage = {
  /** Epoch ms of the read; 0 when the account was never read. */
  fetchedAt: number;
  signedIn: boolean;
  email: string | null;
  planType: string | null;
  windows: CodexUsageWindow[];
  /** Codex's `rateLimitReachedType`, set while a limit is hit. */
  reachedType: string | null;
  error: string | null;
  /**
   * Set when a turn failed on this account's usage limit, before a read has
   * caught up with it. Epoch ms until which the account is treated as empty.
   */
  exhaustedUntil: number | null;
};

export type CodexAccountSelectionReason =
  | 'single'
  | 'sticky'
  | 'primary'
  | 'backup'
  | 'round_robin'
  | 'fallback';

export type CodexAccountSelection = {
  accountId: string;
  reason: CodexAccountSelectionReason;
  /** The session's previous account when the selection moved it. */
  switchedFrom: string | null;
};
