# Session sharing: public read-only links

The owner of a Studio instance can publish a read-only link for any chat session
so anyone with the link can read it without signing in. The public page shows
only the human's prompts and the assistant's text outputs, and keeps updating
while the session runs. The owner can hide individual prompts or outputs from
the shared view and revoke the link at any time.

Two modes are offered when creating a share:

- **Local link (`mode: 'local'`)**: served directly by this Studio instance at `/share/<token>`. Studio itself must be reachable by the reader.
- **Upload to Hemilake (`mode: 'cloud'`)**: Studio pushes the already-filtered items to the local Hemilake console (`CLOUDCLI_CONSOLE_URL`), which relays them with the install's licence to Hemilake's share server (`https://share.hemilake.com/s/<token>`, gated by the `hemilake.studio.share` feature). Studio syncs changes every 5 s while the session runs (only when the payload hash changed, plus a final push when the run ends) and immediately on title, hide, focus, or expiry changes; revoking or expiring deletes the stored payload on the share server. A cloud share has no local public route (`/api/public/shares/:token` returns `404`).

## Routes

### Owner API (`/api/shares`, `authenticateToken` required)

Only the user who created a share can read, update, preview, or revoke it. Another
authenticated user receives `403` (or `404` when querying by `sessionId`).

| Method & path | Body / query | Response |
|---|---|---|
| `GET /api/shares/config` | – | `{ cloud: { available: boolean, reason: string \| null } }` indicating whether `CLOUDCLI_CONSOLE_URL` and `CLOUDCLI_EMBED_SECRET(_FILE)` are configured for uploading shares to Hemilake. |
| `POST /api/shares` | `{ sessionId, provider?, mode?: 'local' \| 'cloud', expiresAt? }` | Creates (or returns the existing active) share for the session: `{ id, token, urlPath, url, mode, cloudId, cloudUrl, cloudExpiresAt, cloudSyncedAt, cloudError, sessionId, provider, title, hiddenIds, focusId, createdAt, updatedAt, expiresAt }`. |
| `GET /api/shares?sessionId=<id>` | `sessionId` query parameter | Active share for that session, or `404` when none is active. |
| `PATCH /api/shares/:id` | `{ title?, hiddenIds?, focusId?, expiresAt? }` | Updates the share title, hidden item IDs, focus item ID (`string` ≤ 200 chars or `null`), or expiration timestamp, pushes immediately to the console for cloud shares, and returns the updated share. |
| `DELETE /api/shares/:id` | – | Sets `revoked_at` on the share row (`404` on the public endpoint) and, for cloud shares, sends `DELETE /api/studio/shares/:cloudId` to the console (retrying in the background loop if the console is unreachable). |
| `GET /api/shares/:id/preview` | – | Returns the share metadata plus `items: [{ id, role, text, timestamp, hidden }]` and `running: boolean`, including hidden candidate items (`hidden: true`) so the owner UI can toggle them and pick an `"Open here"` focus block. |

### Public API (`/api/public/shares`, no authentication)

Mounted before `app.use('/api', validateApiKey)` in `server/index.ts` so it is
accessible without a JWT or API key.

| Method & path | Headers | Response |
|---|---|---|
| `GET /api/public/shares/:token` | Optional `If-None-Match` | `200` `{ title, provider, items: [{ id, role: 'user' \| 'assistant', text, timestamp }], focusId: string \| null, running: boolean, updatedAt }` with `ETag`, `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`; `304` when `If-None-Match` matches `ETag`; `404` `{ error: "Share not found" }` for unknown, revoked, or expired tokens; `429` when per-IP rate limit (120 requests/min) is exceeded. `focusId` is included only when it matches a visible (non-hidden, present) item; otherwise `null`. From a loopback peer (cloudflared or a local reverse proxy) the visitor is `CF-Connecting-IP`, else the first `X-Forwarded-For` entry; from any other peer those headers are ignored. |

### Public page (`/share/:token`)

Rendered in `src/App.tsx` outside `AuthProvider`, `ProtectedRoute`,
`WebSocketProvider`, and plugins:

- Calls only `GET /api/appearance` (for the instance default theme) and
  `GET /api/public/shares/:token` (using `If-None-Match`).
- Opens no WebSocket, registers no service worker or embed bridge, and makes no
  authenticated requests.
- Polls every 3 s while the browser tab is visible and `running` is `true`, and
  every 15 s otherwise. Stops polling on `404` and shows
  `"This link is no longer available"`.
- Opens at the top by default. When `focusId` is set (or `#<item id>` is in the URL,
  which wins over `focusId`), scrolls that item to the top of the viewport (accounting
  for the sticky header via `scroll-margin-top`) and gives it a short copper highlight
  that fades (respecting `prefers-reduced-motion`).
- Later polls never move the reader unless the reader has reached the bottom by
  themselves. A floating `"Jump to latest"` button appears at the bottom-right when not
  near the bottom and shows an unread dot when new items arrive.

## Server-side filtering (`server/modules/share/share.filter.ts`)

Filtering runs on the server before any response leaves `/api/public/shares/:token`:

1. **Source**: reuses `sessionsService.fetchHistory(sessionId, { limit: null, offset: 0 })`
   so transcripts are normalized once through the provider's existing history adapter.
2. **Kept**:
   - Human-typed user prompts (`kind === 'text'`, `role === 'user'`).
   - Assistant text replies (`kind === 'text'`, `role === 'assistant'`), with consecutive
     assistant text blocks in the same turn joined into a single item keyed by the
     first block's message `id`.
3. **Dropped**:
   - All `tool_use`, `tool_result`, `thinking`, stream, status, permission, and error events.
   - Subagent timelines and internal messages (`parentToolUseId`, `subagent`, `subagentTools`).
   - Local slash-command wrappers and outputs (`<command-name>`, `<command-message>`,
     `<command-args>`, `<local-command-stdout>`, `<local-command-stderr>`, `<local-command-caveat>`).
   - Compaction boundaries, compaction summaries (`isCompactSummary`, duplicate unflagged
     summaries, and `"Compacted."` acknowledgements).
   - Meta/synthetic messages (`isMeta`), skill body injections (`Base directory for this skill:`),
     and `<task-notification>` payloads.
4. **Stripped / replaced inside prompts**:
   - `<system-reminder>…</system-reminder>` and `<user-prompt-submit-hook>…</user-prompt-submit-hook>`
     blocks are stripped from user prompts; prompts that become empty after stripping are dropped.
   - Images and file attachments are replaced with `[image]` and `[attachment]` text
     placeholders; raw base64 data and filesystem paths are never sent.
5. **Owner hide list**:
   - Candidate items whose `id` is in `hidden_ids` are removed before returning the
     public payload.

## Security notes & reverse-proxy bypass

- **Token entropy and constant-time comparison**: each share token is 32 random
  bytes encoded as `base64url` (43 characters, 256 bits of entropy) and verified
  with `crypto.timingSafeEqual`. Unknown, revoked, and expired tokens return the
  identical `404` status and JSON body.
- **No workspace links or asset fetches**: the public markdown renderer disables
  workspace file-open links and authenticated image/file fetches, and opens external
  links in a new tab with `rel="noopener noreferrer"`.
- **Deployments behind an authentication proxy (Cloudflare Access, oauth2-proxy, etc.)**:
  if Studio is protected at the edge by an auth proxy, visitors without an edge
  session will be blocked before reaching Studio unless the proxy is configured
  with a **bypass** rule for:
  - `/share/*` (the SPA HTML entry for public share links)
  - `/api/public/shares/*` (the public JSON endpoint)
  - `/api/appearance` and `/manifest.json` (public theme metadata)
  - `/assets/*`, `/themes/*`, `/icons/*`, `/favicon.*` (the static JS/CSS/font/icon bundles required to boot the SPA)
