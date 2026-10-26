/**
 * Codex session → account mapping for multi-account Codex.
 *
 * The selector reads it to keep a session on the account it already uses,
 * and writes it whenever a turn lands on a different one.
 */

import { getConnection } from '@/modules/database/connection.js';

export const codexSessionAccountsDb = {
  getAccountId(sessionId: string): string | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT account_id FROM codex_session_accounts WHERE session_id = ?')
      .get(sessionId) as { account_id: string } | undefined;
    return row?.account_id ?? null;
  },

  setAccountId(sessionId: string, accountId: string): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO codex_session_accounts (session_id, account_id, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO UPDATE SET account_id = excluded.account_id, updated_at = CURRENT_TIMESTAMP`
    ).run(sessionId, accountId);
  },

  /** Drops every mapping to a removed account; returns how many there were. */
  clearAccount(accountId: string): number {
    const db = getConnection();
    return db.prepare('DELETE FROM codex_session_accounts WHERE account_id = ?').run(accountId).changes;
  },

  /** Sessions per account, for the settings page. */
  countByAccount(): Record<string, number> {
    const db = getConnection();
    const rows = db
      .prepare('SELECT account_id, COUNT(*) AS total FROM codex_session_accounts GROUP BY account_id')
      .all() as { account_id: string; total: number }[];
    return Object.fromEntries(rows.map((row) => [row.account_id, row.total]));
  },
};
