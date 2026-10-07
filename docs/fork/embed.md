# Embed mode: Studio inside the Hemilake console

The Hemilake console can show Studio as one of its sections, or as a quick panel
over any page. The console never imports Studio's code and Studio never imports
the console's. They meet in three places: the iframe URL, a sign-in exchange,
and the postMessage contract below. Without embed mode Studio works as before.

## Setting it up

Studio runs on its own origin: a second hostname of the same tunnel, or another
port. Studio's API (`/api`), WebSockets (`/ws`, `/shell`, `/plugin-ws`) and
service worker (`/sw.js`) all live at the root, so it cannot be served under a
path prefix of the console's origin. Its origin should be same-site with the
console (for example `lake.example.com` and `studio.lake.example.com`) so the
framed app keeps first-party storage.

| Variable | What it does |
|---|---|
| `CLOUDCLI_EMBED_ORIGINS` | Comma-separated console origins, e.g. `https://lake.example.com`. They are the only ones that may frame Studio (`Content-Security-Policy: frame-ancestors 'self' <origins>`) and the only ones whose messages Studio reads. Without it nobody else can frame Studio. |
| `CLOUDCLI_EMBED_SECRET` or `CLOUDCLI_EMBED_SECRET_FILE` | The key, 32 characters or more, that the console signs sign-in assertions with. The file is read on every exchange, so it can be rotated without a restart. Without it the framed app shows its own login form. |

Set `HOST=127.0.0.1` when the tunnel runs on the same machine, so Studio is not
reachable on the network without going through it.

An owner without Node gets Studio as a self-contained archive that hemi installs:
`docs/fork/hemilake-bundle.md`.

## Frame URL

`https://<studio origin>/?embed=full` or `/?embed=compact`, or a session path
such as `/session/<id>?embed=full`. Studio keeps the mode for the tab in
sessionStorage because in-app navigation drops the query string. The mode is
only honoured when the page really is framed.

- **full**: the whole workspace. The brand mark and wordmark in the sidebar
  header are hidden because the console's rail carries the brand. Settings stay
  reachable, and so does the footer line naming CloudCLI UI: the licence
  (AGPL-3.0, Section 7) requires that attribution to stay prominent.
- **compact**: the quick panel. No sidebar and no button to open it. The console
  lists other conversations in its own Recent menu (see `recent.request`).
- **both**: Studio uses the Hemilake theme and the console's light or dark mode,
  and stores neither, so the user's own choices still apply when Studio is
  opened on its own. Settings › Appearance says so instead of offering pickers.

## Sign-in

Studio stays single-user, as it is everywhere else. Studio keeps its own session
token. It never trusts a header set by a proxy.

1. Framed and without a session, Studio posts `auth.request`.
2. The console answers `auth { assertion }`: an HS256 JWT signed with the shared
   secret, with `aud: "hemilake-studio"`, `iss` set to the console's origin (one
   of `CLOUDCLI_EMBED_ORIGINS`), a unique `jti`, `iat`, and `exp` at most 120 s
   later. The console signs it on its server; the secret never reaches a browser.
3. Studio posts it to `POST /api/embed/exchange`. A valid assertion signs in the
   instance's first user and returns Studio's own token. Each `jti` is accepted
   once.
4. If nothing arrives within 8 s, or the exchange is refused, Studio posts
   `auth.failed { code }` and shows its login form. With no account yet the code
   is `EMBED_NO_USER` and Studio shows its setup form.

`GET /api/embed/config` (public) returns `{ origins, exchange }`. The framed app
reads it before it trusts any message.

## Messages

Every message is an object with `v: 1` and a `type`. Studio only reads messages
from its parent window, from an allowed origin, and drops anything off-contract
field by field. It posts only to the console's origin. Either side ignores
types it does not know, so the two can ship in any order. The TypeScript
version of this list is the `EMBED CONTRACT` group in `src/shared/types.ts`.

### Studio → console

| Type | Payload | When |
|---|---|---|
| `studio.ready` | `version`, `embed`, `signedIn` | On load, and again with `signedIn: true` once the workspace is up. A console that hears nothing for 5 s can show its fallback. |
| `auth.request` | – | Framed without a session. |
| `auth.failed` | `code` | The exchange did not happen; Studio shows its login form. |
| `route` | `path`, `title` | The path inside Studio (`/` or `/session/<id>`) and the tab title, on every change. The console mirrors them into its address bar and title. |
| `session` | `session` or null, `projectPath` | The open conversation: `id`, `title`, `provider`, `projectId`, `projectPath` and `providerSessionId`, the CLI's own id, which the lake's hooks key the conversation's saga by (`<client>-session-<providerSessionId>`). It is null until the first reply, and the message is sent again once it exists. |
| `session.created` | `requestId`, `session` | The conversation the console started with `new` was sent and became a session. The console uses it to link the session back to the item it came from. Its `providerSessionId` is usually still null: the `session` message sent when that first run ends carries it. |
| `counts` | `running`, `attention` | Conversations producing a reply, and conversations with news the user has not looked at. |
| `notify` | `kind` (`done` or `input`), `sessionId`, `title` | A run finished, or is waiting for a permission decision. |
| `recent` | `requestId`, `items` | The answer to `recent.request`: `id`, `title`, `provider`, `projectId`, `lastActivity`, `running`. |
| `new.failed` | `requestId`, `code` | `no_project`: the console named a project Studio does not have. `workspace_failed`: the chat workspace could not be opened. |
| `shortcut` | `combo: "mod+j"` | ⌘J or Ctrl+J pressed inside the frame, where the console cannot see it. |

### Console → Studio

| Type | Payload | What Studio does |
|---|---|---|
| `auth` | `assertion` | See Sign-in. |
| `theme` | `mode` (`light` or `dark`) | Switches without storing. |
| `navigate` | `path` | Only `/` or `/session/<id>`; anything else is dropped. |
| `new` | `requestId`, `prompt`, `projectPath` or null | Opens a new conversation in that project (one Studio already has; it never creates projects for the console), or in the chat workspace when `projectPath` is null, puts `prompt` in the composer and focuses it. **It never sends.** The owner reads the text and sends it. If the composer already holds the previous prefill, unsent, it is replaced; text the owner typed is kept and the prompt goes after it. |
| `focus` | – | Focuses the composer. |
| `recent.request` | `requestId`, `limit` (1–50) | Answers `recent` with the latest conversations started in Studio. |

## Not in this version

The hand-off also had `open` (Studio → console, a person or fact clicked inside
Studio) and `lake.toggle` (console → Studio). Studio renders no lake
references yet, and the console resizes the frame itself when its lake panel
opens or closes, so neither exists in v1.

## Security notes

- Studio and the console are different origins. A script injected into one
  cannot read the other's DOM, cookies or storage.
- Text from `new` comes from the console and may quote mail or chats written by
  third parties. That is why `new` only prefills: an agent that runs shell
  commands never acts on it before the owner reads it.
- `frame-ancestors` is now sent on every response. Before embed mode Studio sent
  no framing policy, so any site could frame it.
