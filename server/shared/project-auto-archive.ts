import os from 'node:os';
import path from 'node:path';

/**
 * Project paths that Studio should file as archived the moment it discovers
 * them, so automated runs (CI agents, scripted `claude -p`, scratch work in
 * /tmp) never flood the sidebar.
 *
 * `CLOUDCLI_AUTO_ARCHIVE_PROJECT_PATHS` holds comma- or newline-separated
 * globs. `~` expands to the home directory, `*` matches inside one path
 * segment, `**` matches across segments, and a trailing `/**` also matches the
 * directory itself. Unset or empty means nothing is auto-archived.
 *
 * Only sessions Studio indexes from disk are affected: their project is
 * created archived and later activity does not reactivate it. Opening a
 * matching folder from the UI, or starting a chat there, still makes it an
 * active project.
 */
export const AUTO_ARCHIVE_PROJECT_PATHS_ENV = 'CLOUDCLI_AUTO_ARCHIVE_PROJECT_PATHS';

function expandHome(pattern: string, homeDirectory: string): string {
  if (pattern === '~') {
    return homeDirectory;
  }
  if (pattern.startsWith('~/')) {
    return path.posix.join(homeDirectory, pattern.slice(2));
  }
  return pattern;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(glob: string): RegExp {
  let source = '';
  let rest = glob.replace(/\/+$/, '');
  let matchSelf = false;

  if (rest.endsWith('/**')) {
    rest = rest.slice(0, -3);
    matchSelf = true;
  }

  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index];
    if (char === '*') {
      if (rest[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }

  if (matchSelf) {
    source += '(?:/.*)?';
  }

  return new RegExp(`^${source}$`);
}

export function parseAutoArchivePatterns(
  rawValue: string | undefined,
  homeDirectory: string = os.homedir(),
): RegExp[] {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => globToRegExp(expandHome(entry, homeDirectory)));
}

let cachedRawValue: string | undefined;
let cachedPatterns: RegExp[] = [];

// Sessions are indexed by the thousand, so the parsed globs are kept until the
// variable changes.
export function getAutoArchivePatterns(env: NodeJS.ProcessEnv = process.env): RegExp[] {
  const rawValue = env[AUTO_ARCHIVE_PROJECT_PATHS_ENV];
  if (rawValue !== cachedRawValue) {
    cachedRawValue = rawValue;
    cachedPatterns = parseAutoArchivePatterns(rawValue);
  }
  return cachedPatterns;
}

export function isAutoArchivedProjectPath(
  projectPath: string | null | undefined,
  patterns: RegExp[] = getAutoArchivePatterns(),
): boolean {
  if (!projectPath || patterns.length === 0) {
    return false;
  }

  const candidate = projectPath.replace(/\/+$/, '') || '/';
  return patterns.some((pattern) => pattern.test(candidate));
}
