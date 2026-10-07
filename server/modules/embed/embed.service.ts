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
     * Console-only mode: the instance's single account, created now when there
     * is none, with a password nobody knows (password login is off anyway).
     */
    createConsoleOwner(): EmbedUser;
    updateLastLogin(userId: number): void;
  };
  generateToken(user: EmbedUser): string;
  now(): number;
};

/** What a console must put in `aud`; anything else is refused. */
export const EMBED_ASSERTION_AUDIENCE = 'hemilake-studio';
/** Longest life an assertion may have, in seconds, whatever its own `exp` says. */
export const EMBED_ASSERTION_MAX_AGE_S = 120;

const ASSERTION_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

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
 * once; its `jti` is remembered until it would have expired anyway. In
 * console-only mode nobody can sign up, so the first valid assertion creates
 * that user.
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

    exchange(assertionInput: unknown) {
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
      if (typeof claims.jti !== 'string' || !claims.jti || typeof claims.exp !== 'number') {
        throw refused('The assertion was not accepted', 'EMBED_ASSERTION_INVALID');
      }
      forgetExpired(nowSeconds);
      if (spentAssertions.has(claims.jti)) {
        throw refused('The assertion was already used', 'EMBED_ASSERTION_REPLAYED');
      }
      spentAssertions.set(claims.jti, Math.min(claims.exp, nowSeconds + EMBED_ASSERTION_MAX_AGE_S));

      let user = dependencies.users.getFirstUser();
      if (!user && config.only) {
        // Console-only: sign-up is off, so the console's owner gets the account.
        user = dependencies.users.createConsoleOwner();
      }
      if (!user) {
        // A fresh instance has no account yet: the client falls back to setup.
        throw refused('Studio has no account yet', 'EMBED_NO_USER', 409);
      }

      dependencies.users.updateLastLogin(Number(user.id));
      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: dependencies.generateToken(user),
      };
    },
  };
}
