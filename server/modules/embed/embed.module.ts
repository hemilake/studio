import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

import { generateToken } from '@/modules/auth/index.js';
import { userDb } from '@/modules/database/index.js';

import { readEmbedConfig, readEmbedOrigins } from './embed.config.js';
import { createEmbedRouter, createFrameAncestorsMiddleware } from './embed.routes.js';
import {
  createEmbedService,
  EMBED_ASSERTION_AUDIENCE,
  EMBED_ASSERTION_MAX_AGE_S,
} from './embed.service.js';

type JwtVerifyOptions = {
  algorithms: string[];
  audience: string;
  issuer: string[];
  maxAge: string;
  clockTolerance: number;
};

type JwtAdapter = {
  verify(token: string, secret: string, options: JwtVerifyOptions): string | Record<string, unknown>;
};

type BcryptAdapter = {
  hashSync(password: string, saltRounds: number): string;
};

// jsonwebtoken and bcrypt ship no TypeScript declarations here, so the
// composition root narrows the calls it makes, as auth.module.ts does.
const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken') as JwtAdapter;
const bcrypt = require('bcrypt') as BcryptAdapter;

/** The account console-only mode creates; Studio shows it as the signed-in user. */
const CONSOLE_OWNER = 'owner';

const embedService = createEmbedService({
  readConfig: () => readEmbedConfig(),
  verifyAssertion: (assertion, secret, issuers) => {
    const claims = jwt.verify(assertion, secret, {
      algorithms: ['HS256'],
      audience: EMBED_ASSERTION_AUDIENCE,
      issuer: issuers,
      maxAge: `${EMBED_ASSERTION_MAX_AGE_S}s`,
      clockTolerance: 30,
    });
    return typeof claims === 'string' ? {} : claims;
  },
  users: {
    getFirstUser: () => userDb.getFirstUser(),
    // Synchronous from the read to the insert, so two first exchanges cannot
    // both create an account.
    createConsoleOwner: () => userDb.getFirstUser()
      ?? userDb.createUser(CONSOLE_OWNER, bcrypt.hashSync(randomBytes(32).toString('base64url'), 12)),
    updateLastLogin: (userId) => userDb.updateLastLogin(userId),
  },
  generateToken: (user) => generateToken(user),
  now: () => Date.now(),
});

if (readEmbedConfig().only && !embedService.getPublicConfig().exchange) {
  // Fail closed and say so: nobody can sign in until the console's lines are set.
  console.warn('[embed] CLOUDCLI_EMBED_ONLY is set but CLOUDCLI_EMBED_ORIGINS or the embed secret is missing: nobody can sign in');
}

/** Embed router assembled for the server entrypoint. */
export const embedRoutes = createEmbedRouter(embedService);

/** Framing policy middleware assembled for the server entrypoint. */
export const frameAncestors = createFrameAncestorsMiddleware(() => readEmbedOrigins());
