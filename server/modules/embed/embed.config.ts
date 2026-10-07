import fs from 'fs';

/**
 * Fork (embed mode): who may frame Studio and the secret a framing console signs
 * its sign-in assertions with. Both come from the environment so the console's
 * installer can write them next to the service unit:
 *
 * - CLOUDCLI_EMBED_ORIGINS: comma-separated origins allowed to frame Studio and
 *   to talk to it over postMessage, e.g. `https://lake.example.com`.
 * - CLOUDCLI_EMBED_SECRET, or CLOUDCLI_EMBED_SECRET_FILE naming a file that holds
 *   it: the shared HMAC key of the sign-in exchange, 32 characters or more. The
 *   file is read on every call, so rotating it needs no restart.
 */
export type EmbedConfig = {
  origins: string[];
  secret: string | null;
};

const MIN_SECRET_LENGTH = 32;

/** An http(s) origin in canonical form, or null for anything else (`*`, paths, other schemes). */
function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '*') {
    return null;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    // An origin with a path or query is a configuration mistake: refuse it
    // rather than silently trusting the bare host.
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function readSecret(env: NodeJS.ProcessEnv): string | null {
  let secret = env.CLOUDCLI_EMBED_SECRET?.trim() ?? '';
  const secretFile = env.CLOUDCLI_EMBED_SECRET_FILE?.trim();
  if (!secret && secretFile) {
    try {
      secret = fs.readFileSync(secretFile, 'utf8').trim();
    } catch {
      secret = '';
    }
  }
  return secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

/** The origins allowed to frame Studio; entries that do not parse as an http(s) origin are dropped. */
export function readEmbedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = (env.CLOUDCLI_EMBED_ORIGINS ?? '')
    .split(',')
    .map(normalizeOrigin)
    .filter((origin): origin is string => origin !== null);
  return [...new Set(origins)];
}

/** Reads the embed settings from the environment, the secret file included. */
export function readEmbedConfig(env: NodeJS.ProcessEnv = process.env): EmbedConfig {
  return {
    origins: readEmbedOrigins(env),
    secret: readSecret(env),
  };
}
