<div align="center">
  <img src="public/logo.svg" alt="Hemilake Studio" width="64" height="64">
  <h1>Hemilake Studio</h1>
  <p>A web workspace for coding agents: Claude Code, Codex, Cursor CLI, OpenCode and Antigravity, on desktop and on your phone.</p>
</div>

Hemilake Studio runs on your own machine and gives each agent CLI a chat interface you can reach from any browser. Your projects, sessions, files and terminal stay where they are; Studio is the window onto them.

Hemilake Studio is a modified version of **CloudCLI UI (https://github.com/siteboon/claudecodeui)**. It is not CloudCLI UI and is not endorsed by Siteboon AI B.V.

<p align="center">
  <img src="docs/screenshots/chat-light.png" alt="A Claude Code session in Hemilake Studio: Claude finds why a test fails, fixes the code and runs the suite" width="100%">
</p>

<table>
  <tr>
    <td width="40%"><img src="docs/screenshots/chat-dark.png" alt="The same session in dark mode"></td>
    <td width="40%"><img src="docs/screenshots/settings-themes.png" alt="Settings › Appearance with the Hemilake, Orange and Classic blue themes"></td>
    <td width="20%"><img src="docs/screenshots/mobile.png" alt="The session on a phone"></td>
  </tr>
  <tr>
    <td align="center">Dark mode</td>
    <td align="center">Themes</td>
    <td align="center">On a phone</td>
  </tr>
</table>

## What you get

- Chat with Claude Code, Codex, Cursor CLI, OpenCode and Antigravity, with full session history.
- A shell, a file tree with an editor, and a Git panel for each project.
- A layout that works on a phone, installable as a web app.
- Themes: Hemilake (default), Orange and Classic blue. Each user picks one in Settings › Appearance; each instance sets its default.
- One-click reasoning effort and model choice in the composer.
- Adversarial mode: Claude asks Antigravity or Codex for a second opinion before it answers.
- A fixed "Chat" workspace one click away, and scheduled `claude -p` runs kept apart from your own conversations.

The full list of changes against CloudCLI UI is in [docs/fork/CHANGES.md](docs/fork/CHANGES.md).

## Run it

You need Node.js 22 and at least one agent CLI installed and signed in (for example `claude`).

```bash
git clone https://github.com/hemilake/studio.git
cd studio
npm ci
npm run build
SERVER_PORT=3001 node dist-server/server/modules/cli/cli.js
```

Open http://localhost:3001 and create the single user account on first visit.

Settings come from the environment:

| Variable | What it does |
|---|---|
| `SERVER_PORT` | Port to listen on (default 3001). |
| `CLOUDCLI_THEME` | Default theme for the instance: `hemilake`, `orange` or `classic`. Also names and icons the installable web app. |
| `CLAUDE_CLI_PATH` | Path to the `claude` binary when it is not on `PATH`. |
| `CLOUDCLI_EMBED_ORIGINS` | Hemilake console origins allowed to frame Studio (embed mode, see `docs/fork/embed.md`). |
| `CLOUDCLI_EMBED_SECRET` / `CLOUDCLI_EMBED_SECRET_FILE` | Key the console signs its sign-in assertions with, 32 characters or more. |

To expose Studio beyond your machine, put it behind HTTPS (a reverse proxy or a tunnel). The agents run with your user's permissions.

Hemilake installs Studio for its owners from a self-contained archive per platform, with its own Node: see `docs/fork/hemilake-bundle.md`. `CODEX_CLI_PATH` points Studio at an installed Codex when the Codex package is not in `node_modules`, as in that archive.

## Staying in sync with CloudCLI UI

Studio follows upstream releases. How the branches and merges work is in [docs/fork/README.md](docs/fork/README.md).

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [LICENSE](LICENSE), including the additional terms under Section 7, and [NOTICE](NOTICE).

If you run a modified version of Studio as a network service, you must offer its source code to the people who use it. This repository is the source of Hemilake Studio.

Based on CloudCLI UI (https://github.com/siteboon/claudecodeui), copyright 2025-2026 Siteboon AI B.V. and contributors. "CloudCLI" and "Siteboon" are names of Siteboon AI B.V. and are used here only to describe where this work comes from.
