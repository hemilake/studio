<div align="center">
  <img src="public/logo.svg" alt="Hemilake Studio" width="64" height="64">
  <h1>Hemilake Studio</h1>
  <p>A web workspace for coding agents: Claude Code, Codex, Cursor CLI, OpenCode and Antigravity, on desktop and on your phone.</p>
</div>

Hemilake Studio runs on your own machine and gives each agent CLI a chat interface you can reach from any browser. Your projects, sessions, files and terminal stay where they are; Studio is the window onto them.

Hemilake Studio is a modified version of **CloudCLI UI (https://github.com/siteboon/claudecodeui)**. It is not CloudCLI UI and is not endorsed by Siteboon AI B.V.

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

To expose Studio beyond your machine, put it behind HTTPS (a reverse proxy or a tunnel). The agents run with your user's permissions.

## Staying in sync with CloudCLI UI

Studio follows upstream releases. How the branches and merges work is in [docs/fork/README.md](docs/fork/README.md).

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [LICENSE](LICENSE), including the additional terms under Section 7, and [NOTICE](NOTICE).

If you run a modified version of Studio as a network service, you must offer its source code to the people who use it. This repository is the source of Hemilake Studio.

Based on CloudCLI UI (https://github.com/siteboon/claudecodeui), copyright 2025-2026 Siteboon AI B.V. and contributors. "CloudCLI" and "Siteboon" are names of Siteboon AI B.V. and are used here only to describe where this work comes from.
