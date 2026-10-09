import { AppError } from '@/shared/utils.js';

import type { EmbedConfig } from './embed.config.js';

type EmbedUser = {
  id: number | bigint;
  username: string;
};

/** The claims a console assertion must carry once its signature checks out. */
type AssertionClaims = {
  jti?: unknown;
  exp?: unknown;
  sub?: unknown;
  // Optional: the console owner's name and e-mail, for Studio's git identity.
  name?: unknown;
  email?: unknown;
};

/** The owner's name and e-mail as the console's assertion states them, checked. */
export type ConsoleIdentity = {
  name: string;
  email: string;
};

type EmbedDependencies = {
  readConfig(): EmbedConfig;
  /**
   * Verifies an HS256 assertion with the shared secret, its audience, one of
   * the allowed issuers and its age, and returns its claims; throws otherwise.
   */
  verifyAssertion(assertion: string, secret: string, issuers: string[]): AssertionClaims;
  users: {
    getFirstUser(): EmbedUser | undefined;
    /**
     * The instance's single account, created now when there is none, with a
     * password nobody knows: whoever holds a valid assertion is the console's
     * owner, and in console-only mode password login is off anyway.
     */
    createConsoleOwner(): EmbedUser;
    updateLastLogin(userId: number): void;
    /**
     * Gives the account the console's name and e-mail as its git identity where
     * it has none yet. Never replaces one the owner already has. Never rejects:
     * a failure only means the onboarding asks for it.
     */
    seedGitIdentity(userId: number, identity: ConsoleIdentity): Promise<void>;
  };
  generateToken(user: EmbedUser): string;
  now(): number;
};

/** What a console must put in `aud`; anything else is refused. */
export const EMBED_ASSERTION_AUDIENCE = 'hemilake-studio';
/** Longest life an assertion may have, in seconds, whatever its own `exp` says. */
export const EMBED_ASSERTION_MAX_AGE_S = 120;

const ASSERTION_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** A console's jti is a UUID; anything much longer is not one of its assertions. */
const MAX_JTI_LENGTH = 128;
const MAX_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Control characters would let a value spill into another git config line.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** The identity an assertion carries, when both values are there and look right; null otherwise. */
export function readConsoleIdentity(claims: AssertionClaims): ConsoleIdentity | null {
  const name = typeof claims.name === 'string' ? claims.name.trim() : '';
  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  if (!name || name.length > MAX_NAME_LENGTH || CONTROL_CHARACTERS.test(name) || name.startsWith('-')) {
    return null;
  }
  if (email.length > MAX_EMAIL_LENGTH || CONTROL_CHARACTERS.test(email) || email.startsWith('-') || !EMAIL_SHAPE.test(email)) {
    return null;
  }
  return { name, email };
}

function refused(message: string, code: string, statusCode = 401): AppError {
  return new AppError(message, { code, statusCode });
}

/**
 * Creates the embed application service: the public configuration a framed
 * client needs before it is signed in, and the exchange of a console-signed
 * assertion for this instance's own session token.
 *
 * Studio stays single-user behind a console, as in platform mode: a valid
 * assertion signs in the instance's first active user. Each assertion is good
 * once; its `jti` is remembered until it would have expired anyway. When there
 * is no user yet, the first valid assertion creates it, so a framed Studio
 * never asks for a username and password: the console already signed its
 * owner in. Whether password sign-up and login stay open next to it is
 * CLOUDCLI_EMBED_ONLY's to say.
 */
export function createEmbedService(dependencies: EmbedDependencies) {
  const spentAssertions = new Map<string, number>();

  const forgetExpired = (nowSeconds: number) => {
    for (const [jti, expiresAt] of spentAssertions) {
      if (expiresAt <= nowSeconds) {
        spentAssertions.delete(jti);
      }
    }
  };

  return {
    getPublicConfig() {
      const config = dependencies.readConfig();
      return {
        origins: config.origins,
        exchange: config.origins.length > 0 && config.secret !== null,
        only: config.only,
      };
    },

    async exchange(assertionInput: unknown) {
      const config = dependencies.readConfig();
      if (config.origins.length === 0 || config.secret === null) {
        throw refused('Embedded sign-in is not configured on this instance', 'EMBED_EXCHANGE_DISABLED', 404);
      }

      const assertion = typeof assertionInput === 'string' ? assertionInput.trim() : '';
      if (!ASSERTION_SHAPE.test(assertion)) {
        throw refused('A signed assertion is required', 'EMBED_ASSERTION_REQUIRED', 400);
      }

      let claims: AssertionClaims;
      try {
        claims = dependencies.verifyAssertion(assertion, config.secret, config.origins);
      } catch {
        throw refused('The assertion was not accepted', 'EMBED_ASSERTION_INVALID');
      }

      const nowSeconds = Math.floor(dependencies.now() / 1000);
      if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > MAX_JTI_LENGTH || typeof claims.exp !== 'number') {
        throw refused('The assertion was not accepted', 'EMBED_ASSERTION_INVALID');
      }
      forgetExpired(nowSeconds);
      if (spentAssertions.has(claims.jti)) {
        throw refused('The assertion was already used', 'EMBED_ASSERTION_REPLAYED');
      }
      spentAssertions.set(claims.jti, Math.min(claims.exp, nowSeconds + EMBED_ASSERTION_MAX_AGE_S));

      // A fresh instance has no account yet: the console's owner gets it. Nothing
      // is awaited before this line, so two first exchanges cannot both create one.
      const user = dependencies.users.getFirstUser() ?? dependencies.users.createConsoleOwner();

      dependencies.users.updateLastLogin(Number(user.id));
      const identity = readConsoleIdentity(claims);
      if (identity) {
        // Before answering, so the onboarding that follows finds it.
        await dependencies.users.seedGitIdentity(Number(user.id), identity);
      }
      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: dependencies.generateToken(user),
      };
    },
  };
}
