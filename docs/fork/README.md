# About this fork

`hemilake/studio` (Hemilake Studio) is built on [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) (CloudCLI) and runs the instances on Pablo's machine with patches upstream does not have. It started on 2026-10-07 from the history of the GitHub fork `pmoncadaisla/cloudcli`, which stays as the route for upstream pull requests. The list of patches is in [CHANGES.md](CHANGES.md); how the instances are deployed is in `local-instances.md` (untracked, machine-specific).

## Branch model

| Branch | Tracks | Purpose |
|---|---|---|
| `main` | `origin/main` | Upstream `main` plus this fork's patches. The instances run from here. |
| `feat/*` | cut from `upstream/main` | One patch each, clean enough to open as an upstream PR. Merged into `main` right away, deleted once upstream merges it. |

Remotes: `origin` = hemilake/studio (where `main` lives), `upstream` = siteboon/claudecodeui (read-only), `cloudcli-fork` = pmoncadaisla/cloudcli. GitHub only opens pull requests to upstream from a repository in its fork network, so `feat/*` branches meant for upstream are pushed to `cloudcli-fork`.

## Running from source

The instances do not use the npm package. They start the compiled server from this checkout:

```bash
npm ci
npm run build          # writes dist/ and dist-server/
node dist-server/server/modules/cli/cli.js   # same entry point as the `cloudcli` bin
```

Configuration comes from the environment (`SERVER_PORT`, `HOME`, `CLAUDE_CLI_PATH`, `ANTHROPIC_*`), exactly as the npm package does. There is no `.env` in this checkout.

## Bringing in upstream changes

Upstream releases often. Sync whenever a release fixes something we care about, and at least before starting a new patch so the `feat/*` branch is cut from a fresh `upstream/main`.

```bash
git fetch upstream
git checkout main
git merge upstream/main          # resolve conflicts, usually only in files listed in CHANGES.md
npm ci                           # dependencies may have changed
npm run typecheck && npm run lint
npm run test:client -- src/modules/chat/tests/markdownImage.test.tsx   # plus any test listed in CHANGES.md
npm run build
git push origin main
```

Then restart the instances (see `local-instances.md`). Merge, do not rebase, so `main` keeps a linear record of which upstream version each patch was merged against.

If a patch has been merged upstream, drop it here: the merge will usually take care of it, but check `CHANGES.md` and delete the entry and the `feat/*` branch.

## Contributing a patch upstream

```bash
git fetch upstream
git checkout -b feat/short-name upstream/main
# ... commit ...
git push -u cloudcli-fork feat/short-name
gh pr create --repo siteboon/claudecodeui --base main --head pmoncadaisla:feat/short-name
git checkout main && git merge feat/short-name && git push origin main
```

Upstream's `CONTRIBUTING.md` asks for an issue first for new features; bug fixes can go straight to a PR. Follow `AGENTS.md` and the skills under `.agents/skills/` for code layout.
