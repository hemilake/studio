# CloudCLI fork (pmoncadaisla/cloudcli)

This is Pablo's customized fork of [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) (CloudCLI UI). It runs the CloudCLI instances on his machine and carries a small set of patches on top of upstream.

The UI is branded **Hemisphere** (see the BRANDING section of `src/shared/constants.ts`): that is the product name users see, and the fork is where Hemisphere features get built. The repository, the npm package, the `cloudcli` CLI and the server keep upstream's name. Use `BRAND_NAME` instead of hard-coding either name in user-facing text.

Read `AGENTS.md` first: upstream's architecture rules for `server/` and `src/` still apply here. Then read `docs/fork/README.md` for the branch model and the upstream sync procedure.

## Branches and remotes

- `upstream` is siteboon/claudecodeui. Never push there.
- `origin` is github.com/pmoncadaisla/cloudcli.
- `main` is upstream `main` plus this fork's patches. It is what the local instances run.
- Changes that could benefit everyone start on a `feat/*` branch cut from `upstream/main`, get a PR upstream, and are merged into `main` locally without waiting for the PR.

## Working in this repo

- Every customization gets an entry in `docs/fork/CHANGES.md`: what, why, files touched, upstream PR if any. Update it in the same commit.
- Keep patches small and self-contained so the next upstream merge stays cheap. Prefer new files over editing upstream ones.
- Anything that lands in git is written in English, including docs and commit messages. Conversation with Pablo is in Spanish.
- Machine-specific details (systemd units, ports, home directories of the two instances) live in `docs/fork/local-instances.md`. That file is untracked on purpose (`.git/info/exclude`); do not commit it or copy its contents into tracked files.
- Before saying a change works, run the relevant checks and the affected instance:

```bash
npm run test:client -- <path-to-test>   # vitest, jsdom
npm run typecheck                        # client + server tsc
npm run lint                             # oxlint
npm run build                            # dist/ (client) + dist-server/ (server)
```

The instances load `dist/` and `dist-server/` from this directory, so a change is not live until `npm run build` has run and the service has been restarted. Restart procedure and caveats are in `docs/fork/local-instances.md`.
