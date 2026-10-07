#!/usr/bin/env node
// Fork (Hemilake bundle): builds the self-contained Studio that hemi installs on
// an owner's machine, for the platform this runs on. No Node on the machine is
// needed: the bundle carries the official Node of scripts/fork/hemilake-node-version,
// the server bundled into one file, the UI, and only the packages the server
// still loads at runtime, built for that Node. Run `npm run build` first.
//
//   node scripts/fork/build-hemilake-bundle.mjs [--version 1.37.3-hemilake.1] [--out release/hemilake-bundle]
//
// Layout and use: docs/fork/hemilake-bundle.md.
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const nodeVersion = fs.readFileSync(path.join(root, 'scripts', 'fork', 'hemilake-node-version'), 'utf8').trim();
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const version = option('--version', `${pkg.version}-hemilake.dev+${commit.slice(0, 8)}`);
const platform = { darwin: 'darwin', linux: 'linux' }[process.platform];
const arch = { arm64: 'arm64', x64: 'x64' }[process.arch];
const outDir = path.resolve(root, option('--out', path.join('release', 'hemilake-bundle')));

// Packages the bundled server loads from node_modules at run time: native
// modules, packages required through createRequire, and the agent SDKs, which
// locate files of their own. Everything else is inside the one server file.
const RUNTIME_PACKAGES = [
  'node-pty',
  'better-sqlite3',
  'bcrypt',
  'jsonwebtoken',
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex-sdk',
  '@vscode/ripgrep',
];
// Loaded only when present, each behind a try: the bundle leaves them out.
// @openai/codex brings ~280 MB of binaries; CODEX_CLI_PATH names an installed
// Codex instead, and Claude Code is the owner's own `claude`.
const OPTIONAL_PACKAGES = [
  '@openai/codex',
  'playwright',
  '@nut-tree-fork/nut-js',
  'screenshot-desktop',
  'fsevents',
  'esprima',
  'bufferutil',
  'utf-8-validate',
];

function fail(message) {
  console.error(`build-hemilake-bundle: ${message}`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    fail(`${command} ${commandArgs.join(' ')} exited with ${result.status}`);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

if (!platform || !arch) fail(`unsupported platform ${process.platform}-${process.arch}`);
// The native modules are built for the Node running this script; they must
// match the Node the bundle carries.
if (process.version !== `v${nodeVersion}` && !args.includes('--allow-node-mismatch')) {
  fail(`run this with Node ${nodeVersion} (this is ${process.version}): the native modules are built for the running Node`);
}
for (const required of ['dist/index.html', 'dist-server/server/index.js', 'dist-server/server/modules/browser-use/browser-use-mcp.js']) {
  if (!fs.existsSync(path.join(root, required))) fail(`${required} is missing: run npm run build first`);
}

const name = `hemilake-studio-${version}-${platform}-${arch}`;
const stage = path.join(outDir, `.stage-${name}`, name);
const app = path.join(stage, 'app');
fs.rmSync(path.dirname(stage), { recursive: true, force: true });
fs.mkdirSync(path.join(app, 'dist-server', 'server'), { recursive: true });

// 1. The server in one file, plus the browser-use MCP server, which Studio
// starts as its own process from next to the server file. The layout keeps
// dist-server/server/ because the server finds its root by walking up to a
// directory named server.
const esbuild = path.join(root, 'node_modules', '.bin', 'esbuild');
const metafile = path.join(path.dirname(stage), 'meta.json');
run(esbuild, [
  'dist-server/server/index.js',
  'dist-server/server/modules/browser-use/browser-use-mcp.js',
  '--bundle',
  '--platform=node',
  '--format=esm',
  `--target=node${nodeVersion.split('.')[0]}`,
  `--outdir=${path.join(app, 'dist-server', 'server')}`,
  '--entry-names=[name]',
  `--metafile=${metafile}`,
  '--log-level=warning',
  // CommonJS dependencies call require(); an ES module has none until this.
  "--banner:js=import{createRequire as __hlCreateRequire}from'node:module';const require=__hlCreateRequire(import.meta.url);",
  ...[...RUNTIME_PACKAGES, ...OPTIONAL_PACKAGES].map((external) => `--external:${external}`),
], { cwd: root });

// Every bare package the bundle still loads must be in one of the two lists:
// an upstream merge that adds a native or createRequire'd dependency stops here.
const bundled = fs.readFileSync(path.join(app, 'dist-server', 'server', 'index.js'), 'utf8');
const loaded = new Set();
for (const match of bundled.matchAll(/\b(?:require\d*|require_|__require|_require)(?:\.resolve)?\("([^"./][^"]*)"\)|\bimport\s*(?:[\w{}*\s,]+from\s*)?"([^"./][^"]*)"|\bimport\("([^"./][^"]*)"\)/g)) {
  const specifier = match[1] || match[2] || match[3];
  if (specifier.startsWith('node:')) continue;
  const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  loaded.add(packageName);
}
const builtins = new Set(['module', ...(await import('node:module')).builtinModules]);
const unknown = [...loaded].filter((name) => !builtins.has(name) && !RUNTIME_PACKAGES.includes(name) && !OPTIONAL_PACKAGES.includes(name));
if (unknown.length) fail(`the bundled server loads packages that are in neither list: ${unknown.join(', ')}`);

// 2. The UI and the files the server reads from the app root.
for (const entry of ['dist', 'public', 'LICENSE', 'NOTICE']) {
  fs.cpSync(path.join(root, entry), path.join(app, entry), { recursive: true });
}

// 3. The runtime packages, at the versions the lockfile pins, installed by
// this Node so prebuilt or compiled binaries match it. Optional dependencies
// are left out: they are the agent SDKs' platform binaries.
const dependencies = Object.fromEntries(RUNTIME_PACKAGES.map((name) => {
  const locked = lock.packages[`node_modules/${name}`]?.version;
  if (!locked) fail(`${name} is not in package-lock.json`);
  return [name, locked];
}));
fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify({
  name: 'hemilake-studio',
  version,
  private: true,
  type: 'module',
  license: pkg.license,
  dependencies,
}, null, 2)}\n`);
run('npm', ['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', '--no-package-lock'], {
  cwd: app,
  env: { ...process.env, npm_config_update_notifier: 'false' },
});

// Sources, tests and other platforms' prebuilt binaries are not needed to run.
const prune = [
  'node_modules/better-sqlite3/deps',
  'node_modules/better-sqlite3/src',
  'node_modules/node-pty/deps',
  'node_modules/node-pty/src',
  'node_modules/node-pty/third_party',
];
for (const prebuilds of ['node_modules/node-pty/prebuilds', 'node_modules/bcrypt/prebuilds']) {
  const dir = path.join(app, prebuilds);
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(`${platform}-${arch}`)) prune.push(path.join(prebuilds, entry));
  }
}
for (const relative of prune) fs.rmSync(path.join(app, relative), { recursive: true, force: true });

// node-pty ships its macOS spawn-helper without the execute bit, and terminals
// then fail with "posix_spawnp failed" (scripts/fix-node-pty.js does the same
// for a source install).
for (const helper of [
  `node_modules/node-pty/prebuilds/${platform}-${arch}/spawn-helper`,
  'node_modules/node-pty/build/Release/spawn-helper',
]) {
  const file = path.join(app, helper);
  if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
}

// 4. The official Node, checked against nodejs.org's published sums.
const nodeName = `node-v${nodeVersion}-${platform}-${arch}`;
const cache = path.join(os.homedir(), '.cache', 'hemilake-studio-bundle');
fs.mkdirSync(cache, { recursive: true });
const nodeArchive = path.join(cache, `${nodeName}.tar.xz`);
const sums = path.join(cache, `SHASUMS256-v${nodeVersion}.txt`);
const base = `https://nodejs.org/dist/v${nodeVersion}`;
if (!fs.existsSync(sums)) run('curl', ['-fsSL', '-o', sums, `${base}/SHASUMS256.txt`]);
if (!fs.existsSync(nodeArchive)) run('curl', ['-fsSL', '-o', nodeArchive, `${base}/${nodeName}.tar.xz`]);
const expected = fs.readFileSync(sums, 'utf8').split('\n').find((line) => line.endsWith(`  ${nodeName}.tar.xz`))?.split(/\s+/)[0];
if (!expected || expected !== sha256(nodeArchive)) {
  fs.rmSync(nodeArchive, { force: true });
  fail(`${nodeName}.tar.xz does not match nodejs.org's SHASUMS256.txt`);
}
fs.mkdirSync(path.join(stage, 'node', 'bin'), { recursive: true });
run('tar', ['-xJf', nodeArchive, '-C', path.join(stage, 'node'), '--strip-components=1', `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);

// 5. The launcher hemi runs, and what the bundle is.
fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
const launcher = path.join(stage, 'bin', 'hemilake-studio');
fs.writeFileSync(launcher, `#!/bin/sh
# Hemilake Studio from the Hemilake bundle: the bundled Node runs the bundled
# server. hemi's service sets the embed variables; these are the defaults.
set -e
here=$(cd "$(dirname "$0")/.." && pwd -P)
: "\${HOST:=127.0.0.1}"
: "\${SERVER_PORT:=8197}"
: "\${CLOUDCLI_THEME:=hemilake}"
# The bundle has no Codex of its own: use the installed one when there is one.
if [ -z "\${CODEX_CLI_PATH:-}" ] && command -v codex >/dev/null 2>&1; then
  CODEX_CLI_PATH=$(command -v codex)
fi
export HOST SERVER_PORT CLOUDCLI_THEME CODEX_CLI_PATH
exec "$here/node/bin/node" "$here/app/dist-server/server/index.js" "$@"
`, { mode: 0o755 });

fs.writeFileSync(path.join(stage, 'BUNDLE.json'), `${JSON.stringify({
  name: 'hemilake-studio',
  version,
  commit,
  source: `https://github.com/hemilake/studio/tree/${commit}`,
  license: pkg.license,
  node: nodeVersion,
  platform,
  arch,
  runtimePackages: dependencies,
}, null, 2)}\n`);
fs.writeFileSync(path.join(stage, 'SOURCE.txt'), `Hemilake Studio ${version} is a modified version of CloudCLI UI
(https://github.com/siteboon/claudecodeui), licensed under the GNU Affero General Public License v3.0
or later with the additional terms in app/LICENSE. Its complete source code is at
https://github.com/hemilake/studio/tree/${commit}
The bundled Node.js is the official build of nodejs.org, under the licence in node/LICENSE.
`);

// 6. The archive and its sum.
fs.mkdirSync(outDir, { recursive: true });
const archive = path.join(outDir, `${name}.tar.xz`);
fs.rmSync(archive, { force: true });
run('tar', ['-cJf', archive, '-C', path.dirname(stage), name], { env: { ...process.env, XZ_OPT: '-9 -T0' } });
const digest = sha256(archive);
fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
fs.rmSync(path.dirname(stage), { recursive: true, force: true });
console.log(`${path.relative(root, archive)} ${(fs.statSync(archive).size / 1024 / 1024).toFixed(1)} MB sha256 ${digest}`);
