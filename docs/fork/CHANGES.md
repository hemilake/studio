# Patches carried by this fork

One entry per customization, newest first. Keep the file list accurate: it is the conflict checklist for upstream merges.

## Claude Code's files under CLAUDE_CONFIG_DIR

- **Since:** 2026-10-07, on top of upstream v1.37.3.
- **Branch:** `feat/claude-config-dir`, merged into `main`. Could go upstream: it is a plain bug for anyone who sets `CLAUDE_CONFIG_DIR`.
- **Why:** hemi runs Studio's own Claude Code with a `CLAUDE_CONFIG_DIR` of its own, so Studio's sessions never touch the owner's `~/.claude` (HEM-777, ADR-047). Studio passed its environment to every session already, but read Claude Code's files from `~/.claude` and `~/.claude.json` directly: with the directory elsewhere it listed no conversations, could not reload them and reported Claude as signed out.
- **What:**
  - `getClaudeConfigDirectory()` and `getClaudeGlobalConfigPath()` in `server/shared/utils.ts`: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`; `.claude.json` inside `CLAUDE_CONFIG_DIR` when set, else in the home (checked against Claude Code: `claude mcp add --scope user` writes `$CLAUDE_CONFIG_DIR/.claude.json`).
  - Every reader goes through them: the sessions watcher, the session synchronizer (`projects/`, `history.jsonl`), token usage, skills, MCP settings (provider and runtime), user commands, TaskMaster's detection, the CLI's status line, and the Claude sign-in check (`settings.json`, `.credentials.json`).
  - The sign-in check counts an `apiKeyHelper` in `settings.json` as signed in ("API key helper"): that is how hemi gives Claude Code the owner's own API key without putting it in the environment.
  - Project-level `.claude/` folders inside workspaces and the agent API's `~/.claude/external-projects` are unchanged.
- **Files:** `server/shared/utils.ts`, `server/shared/tests/claude-config-dir.test.ts` (new), `server/modules/providers/list/claude/{claude-auth,claude-mcp,claude-session-synchronizer,claude-skills}.provider.ts`, `server/modules/providers/list/claude/claude-runtime.provider.js`, `server/modules/providers/services/{sessions-watcher,provider-token-usage}.service.ts`, `server/modules/commands/commands.routes.ts`, `server/modules/taskmaster/taskmaster.service.ts`, `server/modules/cli/cli.service.ts`, `server/modules/providers/tests/claude-auth.test.ts`, `docs/fork/hemilake-bundle.md`.
- **Verified:** typecheck, lint, the Claude auth and config tests (13), the server suite (the Antigravity auth test fails on `main` too), and a throwaway Studio on think with `CLAUDE_CONFIG_DIR` set and the key given only through an `apiKeyHelper` script: Claude shows as signed in, a real reply arrives, the transcript lands in `$CLAUDE_CONFIG_DIR/projects/`, the conversation shows in Recent and reloads from disk, no `~/.claude` or `~/.claude.json` appears in the home, and the server's environment holds no key.

## Hemilake bundle: Studio without a Node of your own

- **Since:** 2026-10-07, on top of upstream v1.37.3.
- **Branch:** `feat/hemilake-bundle`, merged into `main`. Fork identity, never for upstream.
- **Why:** Hemilake installs Studio on its owners' machines (HEM-754), and they should not need Node, npm or a compiler. Upstream's `server:bundle` builds for its Electron app; the Hemilake bundle carries the official Node instead and leaves the agent CLIs to the owner.
- **What:** documented in `docs/fork/hemilake-bundle.md`.
  - `scripts/fork/build-hemilake-bundle.mjs`: the server bundled by esbuild into one file (plus the browser-use MCP server, which Studio starts by path), the UI, only the runtime packages (natives, createRequire'd, the agent SDKs) installed for the pinned Node without optional dependencies, other platforms' prebuilds and native sources pruned, node-pty's spawn-helper made executable, the official Node checked against nodejs.org's sums, a launcher, `BUNDLE.json`, `SOURCE.txt`, `.tar.xz` + `.sha256`. It fails when the bundled server loads a package that is in neither the runtime list nor the optional list.
  - `scripts/fork/hemilake-node-version` (22.23.2) pins the Node for the build and the archive.
  - `.github/workflows/hemilake-bundle.yml`: darwin-arm64, linux-x64, linux-arm64; a smoke test with no Node on `PATH`; a `v*-hemilake.*` tag publishes a release with `SHA256SUMS`.
  - Codex: `CODEX_CLI_PATH` names an installed Codex for the SDK (`codexPathOverride`) and for `codex app-server` when the Codex package is absent (the archive leaves out its ~280 MB of binaries).
  - Embed mode: the open conversation's provider id is asked for again when its run ends, so the `session` message after a new conversation's first reply carries it.
  - `discord-release.yml` only runs in the upstream repository.
- **Files:** `scripts/fork/build-hemilake-bundle.mjs`, `scripts/fork/hemilake-node-version`, `.github/workflows/hemilake-bundle.yml`, `docs/fork/hemilake-bundle.md` (new); `.github/workflows/discord-release.yml`, `server/modules/providers/list/codex/{codex-runtime.provider,codex-app-server.client}.ts`, `src/modules/project-workspace/controllers/EmbedEffects.tsx`, `docs/fork/embed.md`, `README.md`.
- **Verified:** on think (linux-arm64), from the extracted archive with `PATH=/usr/bin:/bin`: the embed end-to-end run against a fake console (20 checks), register and login, a terminal over `/shell` (no system Node in the shell), and a real Claude Code conversation through the owner's `claude` (reply received; the `session` message after it carries the provider session id).
- **Not done:** an Intel Mac archive (no runner chosen yet); Windows. A Codex conversation through `CODEX_CLI_PATH` was not run (only typecheck and the Codex suites).

## Embed mode for the Hemilake console

- **Since:** 2026-10-07, on top of upstream v1.37.3.
- **Branch:** `feat/embed-mode`, merged into `main`. Fork identity, never for upstream.
- **Why:** the Hemilake console shows Studio as one of its sections (`?embed=full`) and as a quick panel over any page (`?embed=compact`), without either app importing the other's code. Studio is served from its own origin; the root-relative `/api`, `/ws`, `/shell` and `/sw.js` rule out a path prefix on the console's origin.
- **What:** the whole contract is in `docs/fork/embed.md`.
  - Server: module `server/modules/embed`. `CLOUDCLI_EMBED_ORIGINS` and `CLOUDCLI_EMBED_SECRET(_FILE)`, `frame-ancestors 'self' <origins>` on every response (there was no framing policy before), the public `GET /api/embed/config` and `POST /api/embed/exchange`, which trades a console-signed HS256 assertion (audience `hemilake-studio`, issuer one of the origins, at most 120 s, `jti` used once) for the first user's normal token. The auth barrel now exports `generateToken`.
  - Client: `src/shared/embedBridge.ts` detects the mode (framed only, kept in sessionStorage), checks every incoming message (parent window, allowed origin, field by field), posts only to the console's origin and passes ⌘J/Ctrl+J up. `src/modules/auth/EmbeddedSignIn.tsx` runs the exchange and falls back to the login form. `src/modules/project-workspace/controllers/EmbedEffects.tsx` reports route, session (with the provider's session id, which keys the lake's saga), counts, finished and blocked runs, and serves `navigate`, `new` (prefill only, never sends), `focus` and `recent.request`. The contract's types are the `EMBED CONTRACT` group in `src/shared/types.ts`.
  - Chrome: embedded, the sidebar header drops the brand mark and wordmark; compact drops the sidebar and its menu button. The settings link and the footer line naming CloudCLI UI stay (licence, Section 7). The theme is Hemilake's with the console's light or dark, and is never stored; Settings › Appearance explains it instead of offering pickers.
- **Files:**
  - `server/modules/embed/*` (new, with tests), `server/modules/auth/index.ts`, `server/index.ts`
  - `src/shared/embedBridge.ts`, `src/shared/tests/embedBridge.test.ts`, `src/modules/auth/EmbeddedSignIn.tsx`, `src/modules/project-workspace/controllers/EmbedEffects.tsx` (new)
  - `src/main.tsx`, `src/shared/api.ts`, `src/shared/types.ts`, `src/shared/context/ThemeContext.tsx`, `src/modules/auth/ProtectedRoute.tsx`, `src/modules/project-workspace/{ProjectWorkspaceShell,ProjectSidebarRegion,MobileMenuButton}.tsx`, `src/modules/sidebar/SidebarHeader.tsx`, `src/modules/settings/tabs/AppearanceSettingsTab.tsx`, `src/modules/i18n/locales/{en,es}/settings.json`
  - `.oxlintrc.json` (`src/shared/embedBridge.ts` listed as a shared file), `README.md`, `docs/fork/embed.md`
- **Verified:** typecheck, lint, vitest (71 files, 473 tests), the server suite (the 7 failures there predate this change and depend on the shell's environment or fail on `main` too), and an end-to-end run in headless Chromium: a throwaway instance (own HOME and database, loopback) framed by a fake console on another origin that signs assertions server-side. 20 checks: ready, exchange sign-in, route, session, counts, hidden brand, theme, prefill without send, abandoned prefill replaced and typed text kept, unknown project refused, recent, navigate filter, ⌘J, compact at 560 px without sidebar, and a non-configured origin refused by `frame-ancestors`. A real send produced `session.created` with the request id, `counts` 1→0 and `notify done`.
- **Not done:** `providerSessionId` was only seen null in the end-to-end run (no agent CLI in the throwaway instance); with a real Claude Code run it is filled once the CLI names its session. The console side lives in the Hemilake repository.

## README, NOTICE and licence notices for Hemilake Studio

- **Since:** 2026-10-07, on top of upstream v1.37.3.
- **Branch:** `main` only. Fork identity, never for upstream.
- **Why:** the repository moved to `hemilake/studio` and is public. Its README should describe Hemilake Studio, short, while keeping what CloudCLI UI's licence requires: the attribution "CloudCLI UI (https://github.com/siteboon/claudecodeui)" in a prominent place, a clear mark that this is a modified version, and no use of "CloudCLI" or "Siteboon" to promote it (LICENSE, Section 7).
- **What:** `README.md` rewritten: what Studio is, what it adds, how to run it from source, the environment variables, and a licence section with the attribution and AGPL's source-offer duty. The upstream translations in `docs/README.*.md` are deleted (they described CloudCLI UI). `NOTICE` keeps upstream's text and adds a Hemilake Studio block: modified version, changed since 2026-09-08, not endorsed by Siteboon, changes listed in this file. The About tab's licence line names CloudCLI UI as the original (en, es).
- **Files:** `README.md`, `NOTICE`, `docs/README.{de,ja,ko,ru,tr,zh-CN,zh-TW}.md` (deleted), `src/modules/i18n/locales/{en,es}/settings.json`
- **Screenshots:** `docs/screenshots/*.png`, taken from a throwaway instance (its own `HOME` and `DATABASE_PATH`) with a demo project, `pocket-ledger`, and a real two-turn Claude Code session. Retake them the same way rather than from a working instance: they are public.
- **Merge note:** upstream edits to the deleted translations will show up as modify/delete conflicts; keep them deleted.

## Themes (Hemilake, Orange, Classic blue)

- **Since:** 2026-10-07, on top of upstream v1.37.3.
- **Branch:** `feat/theme-system`, merged into `main`. Builds on the Hemilake theme entry below. Fork identity, never for upstream.
- **Why:** besides Hemilake, instances for Orange people should look like Orange (white, black, orange, Helvetica Neue, square corners, the Orange logo), and users who preferred the old blue look get it back. Classic blue keeps the Hemilake Studio name and mark: CloudCLI UI's licence (Section 7) forbids presenting a modified version under its name or logo.
- **What:**
  - A theme is a palette plus a brand. `src/shared/theme/registry.tsx` lists them (id, label, product name, footer name, mark, wordmark, favicon, browser colour, optional web font); `src/shared/theme/themes.css` holds the Orange and classic values for `:root[data-theme=…]` and `.dark[data-theme=…]`. Hemilake's values stay the defaults in `src/index.css`.
  - Fonts, grays and corner radii are CSS variables now: `--font-sans`, `--font-mono`, `--gray-50…950` (RGB channels, so `bg-gray-500/10` keeps working) and every `rounded-*` step scaled from `--radius`, so a radius of 0 squares the whole UI while `rounded-full` stays round. The terminal reads `--terminal-*` and follows theme switches; the code editor toolbar uses the tokens.
  - `ThemeProvider` resolves the theme (the user's `colorTheme` preference, else the instance default), sets `data-theme` on `<html>`, swaps favicon, apple-touch icon, theme colour and web font, and keeps the brand current for code outside React (`getBrandName()` in `constants.ts`) and for translations: every locale says `{{brand}}`, an i18next default variable.
  - `BrandMark`, `BrandWordmark` and `useBrandName()` render the active theme's brand; `size="large"` gives Orange its full logo on the auth screens. Orange's logos are its own files, used as delivered.
  - The server reads the instance default from `CLOUDCLI_THEME` (`hemilake`, `orange`, `classic`; anything else is Hemilake), exposes it at the public `GET /api/appearance` for the login screen, and serves `/manifest.json` named and iconed after it. The client caches it in localStorage for the first paint.
  - Settings › Appearance has a theme picker; "Use the instance default" clears the user's pick.
- **Files:**
  - `src/shared/theme/registry.tsx`, `src/shared/theme/themes.css`, `src/shared/ui/ThemedBrand.tsx`, `src/modules/settings/tabs/ThemePicker.tsx`, `server/shared/themes.ts`, `server/shared/tests/themes.test.ts` (new)
  - `public/themes/orange/*` (Orange's logo files plus generated PNGs), `scripts/fork/generate-brand-icons.mjs`
  - `src/shared/context/ThemeContext.tsx`, `src/shared/tests/themeContext.test.tsx`, `src/shared/ui/BrandMark.tsx` (Hemilake's mark renamed), `src/shared/ui/index.ts`, `src/shared/constants.ts`, `src/shared/utils.ts`, `src/shared/userSettings.ts` (`colorTheme`)
  - `tailwind.config.js`, `src/index.css`, `src/main.tsx`, `.oxlintrc.json`, `server/index.ts`
  - `src/modules/settings/tabs/AppearanceSettingsTab.tsx`, `src/modules/sidebar/{SidebarHeader,SidebarFooter}.tsx`, `src/modules/auth/{AuthLoadingScreen,AuthScreenLayout}.tsx`, `src/modules/settings/tabs/AboutTab.tsx`, `src/modules/mcp/McpServers.tsx`, `src/modules/chat/utils/pageTitleNotification.ts`, `src/modules/shell/hooks/useShellTerminal.ts`, `src/modules/code-editor/utils/editorStyles.ts`
  - `src/modules/i18n/config.ts`, `src/modules/i18n/locales/*/{sidebar,auth,common,settings}.json`
- **Verified:** typecheck, lint, vitest (70 files, 465 tests), the new server test, client build, and headless Chromium against Pablo's instance with the theme injected into the preferences response (nothing written): chat in all three themes, Orange light and dark at 1440 and 390 px, the Appearance picker, and the login screen with Orange as instance default.
- **Not done:** Orange asks for no capitals and no shadows; section headings in Settings stay uppercase and arbitrary `shadow-[…]` classes (the login card) keep their shadow. Helvetica Neue is not served: it falls back to Helvetica or Arial. The code editor's syntax theme and the ANSI colours of the terminal are the same in every theme.

## Composer toolbar on one line on phones

- **Since:** 2026-10-07, on top of upstream v1.37.3.
- **Branch:** `feat/compact-mobile-composer`, merged into `main`. Builds on the effort picker and adversarial mode entries below.
- **Why:** with the effort chip and the adversarial toggle, the composer toolbar wrapped to two lines on a phone.
- **What:** below the `sm` breakpoint only. The effort chip is gone; the model menu trigger names the level instead ("Opus · High", the model's parenthetical dropped) and the menu still lists every effort. The adversarial toggle is hidden and the model menu gets an "Adversaries" section: one row turns the mode on and off, the rows below pick the adversaries (at least one stays selected, the rule now shared as `toggleAdversaryInSelection`). While the mode is on, the trigger turns red and shows the swords and the level in place of the model name. The token pill shows only the count, the schedule button appears only once there is text to schedule, the footer padding drops to `px-2`, and the footer no longer wraps: the model trigger truncates when space runs out. Wide screens are unchanged.
- **Files:**
  - `src/modules/chat/composer/ChatComposer.tsx`, `ComposerModelMenu.tsx`, `ComposerEffortPicker.tsx`, `ComposerAdversarialToggle.tsx`, `ScheduleMessagePopover.tsx`, `TokenUsageSummary.tsx`
  - `src/modules/chat/utils/adversarialMode.ts` (`AdversarialModeControls`, `toggleAdversaryInSelection`)
  - `src/modules/chat/tests/composerEffortPicker.test.tsx` (chip test removed), `src/modules/chat/tests/composerModelMenuAdversarial.test.tsx` (new)
- **Verified:** vitest (chat suites), typecheck, lint, and headless Chromium at 360, 375, 390, 430 and 1440 px: one line at every phone width, with and without adversarial mode, with and without text typed.

## Hemilake theme (Hemilake Studio)

- **Since:** 2026-10-06, on top of upstream v1.37.3.
- **Branch:** `feat/hemilake-theme`, merged into `main`. Fork identity, never for upstream.
- **Why:** the UI takes the Hemilake identity and a new name, Hemilake Studio. The design hand-off (paper and ink, copper for state, IBM Plex) asked for a theme change only: same layout, components and behaviour.
- **What:**
  - Tokens: the shadcn variables in `src/index.css` take the Hemilake values for `:root` and `.dark`, plus five new ones (`--hemi-copper`, `--hemi-copper-text`, `--hemi-copper-tint`, `--hemi-ok`, `--hemi-ok-tint`) exposed as the Tailwind `hemi` colour group. Primary is ink (paper on dark), ring and state are copper, success is olive, errors are brick. Nav glass, blur and tab glow are off. Form controls and the touch hover overrides read the tokens instead of hard-coded blue. Tailwind's `gray` resolves to the warm `stone` scale.
  - Fonts: IBM Plex Sans for UI and chat prose (15px, line-height 1.65), IBM Plex Mono for code. Encode Sans, Merriweather and every `font-serif` are gone.
  - Brand: `BRAND_NAME` is "Hemilake Studio". `BrandMark` draws the Hemilake symbol (copper half disc, open arc in the text colour) and `BrandWordmark` renders "hemilake studio". The sidebar header, auth screens and About tab use them; the footer reads "hemilake studio · CloudCLI v<version>". Logo, favicon, PWA and Electron icons come from `scripts/fork/generate-brand-icons.mjs` (paper tile for logo and favicon, ink tile for app icons) and `electron/scripts/generate-macos-icon.js`.
  - Palette: palette classes across `src/` were remapped by role with `scripts/fork/remap-palette.py`: blue and other accents become ink actions, copper state or muted surfaces; green becomes `hemi-ok`; amber, yellow and orange become copper; red becomes `destructive`. File-type icon colours and third-party agent logos keep their own colours. Rerun the script after an upstream merge that brings new palette classes and review the diff.
  - Component rules: sidebar on `card` with the selected row on `background` at weight 500; segmented controls are `card` on `muted` with a hairline ring; running spinner, unread dot, activity badge, queued message box and the "Analyzing" dot are copper; tool rows have a stone left rail, a copper `$`, and mono repeat chips; the Agents connection card is a plain card ("Connection", "Signed in with an auth token", olive "Connected" chip); API keys show an olive "Active" chip and empty states sit in a dashed box with what happens without one. The Settings modal is white with a paper nav; the terminal surface is ink with a copper selection (ANSI colours unchanged).
- **Files:**
  - `src/index.css`, `tailwind.config.js`, `index.html`, `public/manifest.json`
  - `src/shared/constants.ts`, `src/shared/ui/BrandMark.tsx`, `src/shared/ui/index.ts`, `src/shared/tests/pageTitle.test.ts`
  - `src/modules/sidebar/{SidebarHeader,SidebarFooter,SidebarContent,SidebarRecentConversations,SidebarSessionItem,SidebarProjectItem}.tsx`, `src/modules/sidebar/tests/recentConversationRowActions.test.tsx`
  - `src/modules/auth/{AuthLoadingScreen,AuthScreenLayout}.tsx`, `src/modules/settings/{Settings,SettingsSidebar}.tsx`, `src/modules/settings/tabs/AboutTab.tsx`, `src/modules/settings/tabs/agents-settings/sections/{AgentSelectorSection,content/AccountContent}.tsx`, `src/modules/settings/tabs/api-settings/sections/{ApiKeysSection,GithubCredentialsSection}.tsx`
  - `src/modules/chat/composer/{QueuedMessageCard,ActivityIndicator}.tsx`, `src/modules/chat/tools/{BashCommandDisplay,CollapsibleDisplay}.tsx`, `src/modules/chat/tools/configs/toolConfigs.ts`, `src/modules/chat/transcript/{MessageComponent,ToolGroupContainer}.tsx`, `src/modules/shell/hooks/useShellTerminal.ts`
  - About 100 more files under `src/modules` touched only by the palette remap (class names, no logic)
  - `src/modules/i18n/locales/*/{sidebar,auth,common,settings}.json`
  - `public/logo*.{svg,png}`, `public/favicon.{svg,png}`, `public/icons/icon-*.{svg,png}`, `electron/assets/logo-*`
  - `scripts/fork/generate-brand-icons.mjs`, `scripts/fork/remap-palette.py` (new), `electron/scripts/generate-macos-icon.js`
- **Verified:** typecheck, lint (no new warnings), vitest (69 files, 462 tests, `themeContext` included), client build, and headless Chromium against the dev server proxied to Pablo's instance (writes blocked) at 1440 and 390 px, light and dark: chat, Settings › Agents and API & Tokens.
- **Not done:** most `shadow-sm` outside the touched components stays (the rule keeps shadows only on the Settings modal and menus). The code editor keeps its own `#1e1e1e` dark surface.

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
