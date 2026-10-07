# The Hemilake bundle: Studio without a Node of your own

hemi installs Studio on an owner's machine from one archive per platform. The
archive carries everything Studio needs to run: the official Node, the server,
the UI and the native modules built for that Node. The machine needs no Node, no
npm and no compiler, and the owner's own Node, if there is one, is never touched.

## Building

```bash
npm ci && npm run build
node scripts/fork/build-hemilake-bundle.mjs --version 1.37.3-hemilake.1
# release/hemilake-bundle/hemilake-studio-1.37.3-hemilake.1-<platform>-<arch>.tar.xz (+ .sha256)
```

The script builds for the machine it runs on and refuses to run under a Node
other than `scripts/fork/hemilake-node-version`, because the native modules are
built for the running Node and must match the one the archive carries.

The workflow `.github/workflows/hemilake-bundle.yml` builds `darwin-arm64`
(macos-14), `linux-x64` (ubuntu-22.04, so glibc 2.35 and newer) and
`linux-arm64` (ubuntu-22.04-arm). A push of a tag `v<version>-hemilake.<n>`
publishes a release with the three archives, their `.sha256` files and
`SHA256SUMS`; the release is the source offer for that version (AGPL). A manual
run builds the archives as artifacts only. Each job smoke-tests its archive with
a `PATH` that has no Node.

## What is in an archive

```
hemilake-studio-<version>-<platform>-<arch>/
  bin/hemilake-studio      launcher: the bundled Node runs the bundled server
  node/bin/node            official Node from nodejs.org, checked against its SHASUMS256.txt
  node/LICENSE
  app/dist-server/server/index.js              the server, bundled into one file by esbuild
  app/dist-server/server/browser-use-mcp.js    the browser-use MCP server Studio starts by path
  app/dist/                the UI
  app/public/
  app/node_modules/        only what the server loads at run time (below)
  app/package.json         name, version, "type": "module"
  app/LICENSE, app/NOTICE  CloudCLI UI's AGPL-3.0 with its section 7 terms
  BUNDLE.json              version, commit, source URL, Node version, platform, runtime packages
  SOURCE.txt               where the source of this version is
```

The `dist-server/server/` layout is kept because the server finds its root by
walking up to a directory named `server`.

`app/node_modules` holds `node-pty`, `better-sqlite3`, `bcrypt`, `jsonwebtoken`,
`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk` and `@vscode/ripgrep`, at
the versions of `package-lock.json`, without their optional dependencies. The
build fails if an upstream merge makes the server load a package that is in
neither the runtime list nor the list of optional packages it can do without.

Sizes for 1.37.3 on linux-arm64: 36 MB compressed, 197 MB unpacked, most of it
Node. A plain `npm ci --omit=dev` would weigh more than 1.5 GB, mostly because
the Claude agent SDK and Codex ship their CLI binaries per platform (~230 MB and
~280 MB).

## Agent CLIs

The bundle carries no agent CLI. Studio runs the owner's own:

- **Claude Code**: `claude` on the service's `PATH`, or `CLAUDE_CLI_PATH`. hemi gives Studio its own pinned copy and its own `CLAUDE_CONFIG_DIR` (HEM-777); Studio reads Claude Code's sessions, settings and sign-in from there. Claude Code signs in with the owner's own Claude account or API key (ADR-047 in the Hemilake repository).
- **Codex**: `CODEX_CLI_PATH`; the launcher fills it with `command -v codex`
  when it is unset. Without a Codex, Codex conversations fail with a clear error
  and branching a Codex conversation answers 501.
- **Gemini, Antigravity, Cursor, OpenCode**: their CLIs on `PATH`, as in any
  install.

## Running it as hemi does

```bash
HOME=<owner's home> \
PATH=<owner's PATH, with the agent CLIs> \
HOST=127.0.0.1 SERVER_PORT=8197 \
CLOUDCLI_EMBED_ORIGINS=<the console's origins> \
CLOUDCLI_EMBED_SECRET_FILE=<$HEMI_SECRETS/studio-embed-secret> \
CLOUDCLI_EMBED_ONLY=1 \
  <bundle>/bin/hemilake-studio
```

The launcher defaults `HOST` to `127.0.0.1`, `SERVER_PORT` to `8197` and
`CLOUDCLI_THEME` to `hemilake`. `CLOUDCLI_EMBED_ONLY=1` makes the console the
only way to sign in (`docs/fork/embed.md`); hemi sets it, because it publishes
Studio next to the console. Studio keeps its data where it always does
(`~/.cloudcli`, or `DATABASE_PATH`), so an update replaces the archive and keeps
the data, and an owner who already ran Studio from source keeps their account,
projects and settings.

On macOS the files arrive through hemi's download, not a browser, so they carry
no quarantine attribute and Gatekeeper does not stop them: the same path as
hemi's cloudflared. Node's binary is signed by the Node project; the native
modules are ad-hoc signed by the linker, which is what Apple Silicon requires.

## Verified

On think (linux-arm64), from the extracted archive with `PATH=/usr/bin:/bin`:
the embed end-to-end run against a fake console on another origin (20 checks,
see `docs/fork/embed.md`), register and login, a terminal over `/shell`, and a
real Claude Code conversation through the owner's `claude` (reply received, the
provider session id reported).
