# Patches carried by this fork

One entry per customization, newest first. Keep the file list accurate: it is the conflict checklist for upstream merges.

## Brand the UI as Hemisphere

- **Since:** 2026-09-11, on top of upstream v1.37.3.
- **Branch:** `main` only. Fork identity, never for upstream.
- **Why:** this fork is becoming the UI of Hemisphere, Pablo's personal AI workspace, and will keep gaining features of its own. What the user sees should say so. The repository, the npm package, the `cloudcli` CLI, server log lines and the on-disk directories keep upstream's name so merges stay cheap and nothing on the machines has to move.
- **What:** the BRANDING section of `src/shared/constants.ts` holds the name and the repo links (`BRAND_NAME`, `UPSTREAM_NAME`, `UPSTREAM_REPO_URL`, `FORK_REPO_URL`); `BrandMark` is the new glyph (a circle with the upper half filled). The sidebar header, the auth screens, the About tab and the page title use them. The sidebar footer reads "Hemisphere · CloudCLI v1.37.3" and links upstream, which is the version reference for syncs. The About tab keeps the version badge, the tagline, the licence line and three links (this fork, upstream, plugin docs); upstream's star button, Discord link, hosted CTA and paid-feature cards are gone. The GitHub star badge under the sidebar logo is removed. User-facing strings that named CloudCLI are renamed in every locale (app title, login description and footer, loading text, MCP "managed by" hint); the login footer now says "Built on CloudCLI". Strings that describe upstream's own things (their plugin catalogue, "CloudCLI Pro", the voice proxy comments) are left alone. Logo, favicon and PWA icons are regenerated from one template by `scripts/fork/generate-brand-icons.mjs` (needs `sharp`, already a dependency).
- **Files:**
  - `src/shared/ui/BrandMark.tsx`, `scripts/fork/generate-brand-icons.mjs` (new), `src/shared/constants.ts` (brand constants)
  - `src/shared/ui/index.ts` (exports `BrandMark`), `src/shared/utils.ts` (default page title), `src/modules/chat/utils/pageTitleNotification.ts` (title fallback)
  - `src/modules/sidebar/SidebarHeader.tsx` (glyph, no `GitHubStarBadge`), `src/modules/sidebar/SidebarFooter.tsx` (version line)
  - `src/modules/auth/AuthLoadingScreen.tsx`, `src/modules/auth/AuthScreenLayout.tsx`
  - `src/modules/settings/tabs/AboutTab.tsx` (rewritten), `src/modules/mcp/McpServers.tsx` (hint default)
  - `index.html`, `public/manifest.json`, `public/logo.svg`, `public/logo-*.png`, `public/favicon.svg`, `public/favicon.png`, `public/icons/icon-*.{svg,png}`
  - `src/modules/i18n/locales/*/{sidebar,auth,common}.json` and `settings.json` where the MCP hint exists; `en`/`es` also get the new login footer and About tagline
  - `src/shared/tests/pageTitle.test.ts` (expects the new title)
- **Verified:** vitest (full client suite), typecheck, lint, build, and screenshots of the login screen, the sidebar and the About tab in the Beatriz instance; `<title>` and `manifest.json` served as Hemisphere.
- **Upstream merge notes:** `GitHubStarBadge.tsx` and `useGitHubStars.ts` are kept but unreferenced. Expect conflicts in `AboutTab.tsx` (rewritten) and in the locale files whenever upstream edits the same strings; re-run the icon script if upstream changes `public/` assets.

## "Chat" shortcut: one click to a fixed chat workspace

- **Since:** 2026-09-11, on top of upstream v1.37.3.
- **Branch:** `main` only for now. Could be proposed upstream later; it is self-contained enough.
- **Why:** Pablo uses the UI a lot as a plain chat, the way Claude Desktop separates Chat from Code. Upstream always makes you pick a project first. This adds a shortcut that lands in the same workspace every time, so a chat is one click (or one key chord) away.
- **What:** a "Chat" button under the sidebar header (desktop and mobile), an icon in the collapsed rail, an "Open chat" command in the palette and the `Ctrl/Cmd+Shift+O` shortcut. All of them run the same action: resolve the chat workspace path, make sure a project exists there (creating the folder and the project with display name "Chat" on first use, or looking it up again on a 409), refresh the list if it was new, and start a new session in it through the existing `handleNewSession`. The workspace path is the `chatWorkspacePath` user preference, editable in Settings > Appearance > Chat. When empty it defaults to `<workspace root>/chat`, where the root comes from the browse-filesystem endpoint (the server home unless `WORKSPACES_ROOT` is set), so each instance gets its own folder. The chat project stays visible in the project list like any other. New sessions in that workspace start with the chat model, Sonnet by default (`chatWorkspaceModel` preference, same settings block); a manual pick in a fresh chat stays local to that chat instead of overwriting the per-provider default. Once the first turn is sent the server records the model on the session, so nothing else changes.
- **Files:**
  - `src/modules/chat-workspace/` (new module: `chatWorkspace.ts` path resolution, project lookup/creation and the two preferences, `useOpenChat.ts` action hook and keyboard shortcut, `useChatWorkspaceModel.ts` composer default model, `ChatShortcut.tsx` sidebar and rail buttons, `index.ts`, `tests/`)
  - `src/modules/chat/hooks/useChatProviderState.ts` (uses `selectedProject`; `currentProviderModel`, the provider map and the model setters honour the chat model while no session exists)
  - `src/modules/settings/tabs/ChatWorkspaceSettings.tsx` (new: the settings row)
  - `src/modules/settings/tabs/AppearanceSettingsTab.tsx` (renders the row)
  - `src/modules/sidebar/Sidebar.tsx` (wires the hook, registers the palette op and the shortcut)
  - `src/modules/sidebar/SidebarContent.tsx`, `src/modules/sidebar/SidebarCollapsed.tsx` (render the buttons, three new props each)
  - `src/modules/command-palette/context/PaletteOpsContext.tsx` (new `openChat` op), `src/modules/command-palette/CommandPalette.tsx` (new action item)
  - `src/shared/userSettings.ts` (new `chatWorkspacePath` and `chatWorkspaceModel` preference keys)
  - `src/modules/i18n/locales/{en,es}/{sidebar,common,settings}.json` (new strings; other locales fall back to English)
- **Verified:** vitest (chat-workspace, sidebar and command-palette suites), typecheck, lint, build, and end to end in the Beatriz instance with Playwright: first click created `/home/pmoncadaisla/beatriz/chat` and the "Chat" project, opened a new session in it; second click reused the project (one DB row); the palette shows "Open chat". Model: the composer and the welcome card show Sonnet in a fresh chat, the first turn was answered by `claude-sonnet-5` and the session row was recorded with `model = sonnet`; other projects still show the per-provider default.

## Hide the update banner and community links in the sidebar

- **Since:** 2026-09-11, on top of upstream v1.37.3.
- **Branch:** `main` only. Not proposed upstream: this is a preference of this fork, not a fix.
- **Why:** the "Update available" banner, "Report Issue" and "Join Community" entries take up space at the bottom of the sidebar and are noise here. The fork tracks upstream through git, not through the in-app updater, and issues go to upstream from the fork repo, not from the running UI.
- **What:** the JSX for those three items is removed from the expanded footer and the collapsed icon rail, on desktop and mobile. The settings button, the restart-required banner and the small version line at the bottom stay. Props such as `updateAvailable`, `releaseInfo` and `onShowVersionModal` are kept in both component types and are simply not destructured, so `Sidebar`, `SidebarContent` and `SidebarModals` are untouched. The version check hook still runs and the upgrade modal still exists; only its entry points in the sidebar are gone. The About tab in settings still shows update information.
- **Files:**
  - `src/modules/sidebar/SidebarFooter.tsx`
  - `src/modules/sidebar/SidebarCollapsed.tsx`
- **Verified:** typecheck, lint, build.

## Render workspace image paths in chat markdown

- **Since:** 2026-09-08, on top of upstream v1.37.3 (commit `5e73a49b`).
- **Branch:** `feat/chat-markdown-workspace-images`. Upstream PR: see the link in the git log of the branch, or `gh pr list --repo siteboon/claudecodeui --author pmoncadaisla`.
- **Why:** a reply containing `![cat](imagenes/cat.png)` rendered as a broken image. react-markdown emitted a bare `<img src>` that the browser resolved against the web origin, and the project files route needs the auth header anyway. This matters for the image generation skill in Beatriz's instance, whose whole output is a PNG in the project.
- **What:** an `img` override for chat markdown fetches workspace paths through `api.readFileBlob` (the authenticated file-tree route already used by attachments and the file viewer), shows the blob inline and opens it in the existing `ImageLightbox`. Web, data and blob URLs pass through; a missing file falls back to the alt text. `ChatInterface` provides the selected `projectId` through a small context so every `Markdown` call site in the transcript resolves paths against the right project.
- **Files:**
  - `src/modules/chat/transcript/MarkdownImage.tsx` (new)
  - `src/modules/chat/context/MarkdownWorkspaceContext.ts` (new)
  - `src/modules/chat/tests/markdownImage.test.tsx` (new)
  - `src/modules/chat/transcript/Markdown.tsx` (adds `img: MarkdownImage`)
  - `src/modules/chat/ChatInterface.tsx` (provider around `ChatMessagesPane`)
- **Verified:** vitest, typecheck, lint, and end to end in the Beatriz instance (image generated by the skill shown inline at 1024x1024).
