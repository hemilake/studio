# Patches carried by this fork

One entry per customization, newest first. Keep the file list accurate: it is the conflict checklist for upstream merges.

## Adversarial mode in the composer

- **Since:** 2026-10-06, on top of upstream v1.37.3.
- **Branch:** `main` only. The commands assume this machine's `agy` and `codex` CLIs and accounts.
- **Why:** Pablo often asks Opus for something and tells it to weigh what Antigravity (Gemini), Codex (GPT) or both say. Typing that every time is slow; a button makes it one click.
- **What:** a swords icon before the permission menu, shown only when Claude is the provider. One click turns adversarial mode on with the saved selection (Antigravity by default); the chevron next to it opens the list of adversaries, and at least one stays selected. The selection is the `adversaries` user preference; the on/off state lives in memory, so a reload starts with the mode off. While it is on, every turn sends `options.adversaries`. `dispatchRun` (shared by `chat.send`, `chat.edit-send` and queued dispatch) appends an `<adversarial_review>` block to Claude's prompt: write a self-contained brief in a scratch directory, run each adversary in the background read-only (`agy --mode plan`, `codex exec -s read-only`), wait for the `<id>.done` file each command writes with its exit code, check their claims, and end with an "Adversarial review" section. The `.done` markers are there because the first live test waited with `pgrep -f "agy -p"`, which matched its own wait loop and hung until the Bash timeout. The block sits before the `<files_input>` tag. Claude's history adapter strips it like the files tag and puts the list on the message, so the user bubble shows the typed text plus a chip with the adversaries. Models and commands live in `server/shared/adversarial-review.ts`; the ids must match `src/modules/chat/utils/adversarialMode.ts`.
- **Files:**
  - `server/shared/adversarial-review.ts`, `server/shared/tests/adversarial-review.test.ts` (new), `.oxlintrc.json` (registers it as a shared util)
  - `server/modules/websocket/services/chat-websocket.service.ts` (appends the block for Claude), `server/modules/providers/list/claude/claude-sessions.provider.ts` (strips it), `server/shared/types.ts` (`adversaries` on `NormalizedMessage`)
  - `src/modules/chat/composer/ComposerAdversarialToggle.tsx`, `src/modules/chat/hooks/useAdversarialMode.ts`, `src/modules/chat/utils/adversarialMode.ts`, `src/modules/chat/tests/composerAdversarialToggle.test.tsx` (new)
  - `src/modules/chat/ChatInterface.tsx`, `src/modules/chat/composer/ChatComposer.tsx`, `src/modules/chat/hooks/useChatComposerState.ts` (sends the option, echo carries the chip), `src/modules/chat/hooks/useChatSessionState.ts`, `src/modules/chat/hooks/useChatMessages.ts`, `src/modules/chat/transcript/MessageComponent.tsx` (chip)
  - `src/shared/types.ts`, `src/shared/userSettings.ts` (`adversaries` preference), `src/modules/i18n/locales/{en,es}/chat.json`
- **Verified:** node tests (new suite; the 4 `claude-cli-path` failures exist on the previous HEAD too), vitest (chat and shared suites), typecheck, lint, build, headless Chromium against the Beatriz instance at 1400 and 390 px (toggle on, Codex added from the menu, count badge), and a real `claude -p` turn (Opus, both adversaries, 102 s, $0.27) in a scratch project: it wrote the brief, ran both CLIs in parallel, waited on the markers and ended with the review section.
- **Known limit:** on think, Codex's `read-only` sandbox cannot run any command. Ubuntu's `kernel.apparmor_restrict_unprivileged_userns=1` stops bubblewrap from creating a user namespace (`bwrap: loopback: Failed RTM_NEWADDR`), so Codex answers without reading files and says so. Antigravity is unaffected. Fixing it needs an AppArmor profile that grants `userns` to `/usr/bin/bwrap`.

## Automatic runs in their own recents tab

- **Since:** 2026-10-06, on top of upstream v1.37.3.
- **Branch:** `main` only for now. The server half (`origin` on `/sessions/recent`, default `all`) could go upstream.
- **Why:** scheduled `claude -p` jobs on this machine (PR reviewer, per-issue agents, arch ticks, the unattended mail run) show up in the Conversations list as sessions in `repo`, `hemisphere` or `think`. On 2026-10-06 they were 1,019 of 1,384 rows and pushed the chats Pablo started out of view.
- **What:** `getRecentSessionsPage` takes an `origin`. A session counts as external when `session_id = provider_session_id`, which is how the disk synchronizer keys sessions it did not start; app chats and forks get their own `session_id` from the session gateway (or still have a NULL provider id). The route reads `?origin=all|app|external` and rejects anything else with a 400. In the sidebar the list header becomes two tabs, "Recent conversations" (`app`, the default) and "Automatic" (`external`); switching clears the rows and refetches page zero. The header stays visible in the loading, empty and error states so there is always a way back. A session started outside the app stays under Automatic even if it is later continued from the UI. The Projects and Running views are unchanged.
- **Files:**
  - `server/modules/database/repositories/sessions.db.ts` (`RecentSessionsOrigin`, origin clause), `server/modules/database/index.ts` (type export)
  - `server/modules/providers/services/sessions.service.ts`, `server/modules/providers/provider.routes.ts` (`origin` query parameter)
  - `src/shared/types.ts` (`RecentConversationsOrigin`), `src/shared/api.ts` (`origin` on `recentConversations`)
  - `src/modules/sidebar/hooks/useSidebarController.ts`, `src/modules/sidebar/Sidebar.tsx`, `src/modules/sidebar/SidebarContent.tsx`, `src/modules/sidebar/SidebarRecentConversations.tsx`
  - `src/modules/i18n/locales/en/sidebar.json`
  - `server/modules/database/tests/sessions.db.integration.test.ts`, `src/modules/sidebar/tests/recentConversationRowActions.test.tsx`
- **Verified:** node tests (sessions db and service), vitest (sidebar), typecheck, lint, build.

## One-click reasoning effort in the composer

- **Since:** 2026-09-27, on top of upstream v1.37.3.
- **Branch:** `main` only for now. Self-contained enough to propose upstream later.
- **Why:** changing the effort took two clicks through the model menu, and Pablo switches it often. The level should be visible and one click away.
- **What:** `ComposerEffortPicker` sits next to the model menu. On `sm` and wider it is a segmented control with every effort the current model accepts (Low, Med, High, XHigh, Max); on phones it is one chip that steps to the next level on each tap and wraps from Max to Low. `ultracode` stays in the model menu only, because it also turns on workflow orchestration. The model menu keeps its full Reasoning list, model default included, and stops appending "· effort" to its trigger when the picker already shows that level. Selection goes through the existing `onSelectEffort`, so the chat workspace override and session persistence behave as before.
- **Files:**
  - `src/modules/chat/composer/ComposerEffortPicker.tsx`, `src/modules/chat/utils/composerEffort.ts`, `src/modules/chat/tests/composerEffortPicker.test.tsx` (new)
  - `src/modules/chat/composer/ChatComposer.tsx` (renders the picker after the model menu)
  - `src/modules/chat/composer/ComposerModelMenu.tsx` (no effort suffix for picker levels)
- **Verified:** vitest (new suite and chatProviderModels), typecheck, lint, build, and headless Chromium against Pablo's instance at 1400 and 390 px wide: the fresh chat showed Opus (1M context) with High selected, one click on Max selected it, and a tap on the phone chip moved High to XHigh. No session was created.

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
- **What:** a "Chat" button under the sidebar header (desktop and mobile), an icon in the collapsed rail, an "Open chat" command in the palette and the `Ctrl/Cmd+Shift+O` shortcut. All of them run the same action: resolve the chat workspace path, make sure a project exists there (creating the folder and the project with display name "Chat" on first use, or looking it up again on a 409), refresh the list if it was new, and start a new session in it through the existing `handleNewSession`. The workspace path is the `chatWorkspacePath` user preference, editable in Settings > Appearance > Chat. When empty it defaults to `<workspace root>/chat`, where the root comes from the browse-filesystem endpoint (the server home unless `WORKSPACES_ROOT` is set), so each instance gets its own folder. The chat project stays visible in the project list like any other. New sessions in that workspace start with the chat model and effort: Opus at `medium` by default (`chatWorkspaceModel` and `chatWorkspaceEffort` preferences, same settings block; the local instances resolve `opus` to `claude-opus-5-5` through `ANTHROPIC_DEFAULT_OPUS_MODEL`). A manual pick of either in a fresh chat stays local to that chat instead of overwriting the per-provider defaults. Once the first turn is sent the server records both on the session, so nothing else changes. Until 2026-09-23 the default was Sonnet with the model's own effort.
- **Files:**
  - `src/modules/chat-workspace/` (new module: `chatWorkspace.ts` path resolution, project lookup/creation and the three preferences, `useOpenChat.ts` action hook and keyboard shortcut, `useChatWorkspaceModel.ts` composer default model and effort, `ChatShortcut.tsx` sidebar and rail buttons, `index.ts`, `tests/`)
  - `src/modules/chat/hooks/useChatProviderState.ts` (uses `selectedProject`; `currentProviderModel`, `currentProviderEffort`, the provider map and the model and effort setters honour the chat defaults while no session exists)
  - `src/modules/settings/tabs/ChatWorkspaceSettings.tsx` (new: the settings rows for folder, model and effort)
  - `src/modules/settings/tabs/AppearanceSettingsTab.tsx` (renders the row)
  - `src/modules/sidebar/Sidebar.tsx` (wires the hook, registers the palette op and the shortcut)
  - `src/modules/sidebar/SidebarContent.tsx`, `src/modules/sidebar/SidebarCollapsed.tsx` (render the buttons, three new props each)
  - `src/modules/command-palette/context/PaletteOpsContext.tsx` (new `openChat` op), `src/modules/command-palette/CommandPalette.tsx` (new action item)
  - `src/shared/userSettings.ts` (new `chatWorkspacePath`, `chatWorkspaceModel` and `chatWorkspaceEffort` preference keys)
  - `src/modules/i18n/locales/{en,es}/{sidebar,common,settings}.json` (new strings; other locales fall back to English)
- **Verified:** vitest (chat-workspace, sidebar and command-palette suites), typecheck, lint, build, and end to end in the Beatriz instance with Playwright: first click created `/home/pmoncadaisla/beatriz/chat` and the "Chat" project, opened a new session in it; second click reused the project (one DB row); the palette shows "Open chat". Model: the composer and the welcome card show Sonnet in a fresh chat, the first turn was answered by `claude-sonnet-5` and the session row was recorded with `model = sonnet`; other projects still show the per-provider default. Opus/medium change of 2026-09-23: vitest (chat-workspace and chatProviderModels suites), typecheck, lint, build; the Beatriz instance restarted on the new bundle and Pablo's instance serves it from `dist/` without a restart. Not exercised end to end in a browser.

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
