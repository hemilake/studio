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

// jsonwebtoken ships no TypeScript declarations here, so the composition root
// narrows the one call it makes, as auth.module.ts does for bcrypt.
const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken') as JwtAdapter;

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
    updateLastLogin: (userId) => userDb.updateLastLogin(userId),
  },
  generateToken: (user) => generateToken(user),
  now: () => Date.now(),
});

/** Embed router assembled for the server entrypoint. */
export const embedRoutes = createEmbedRouter(embedService);

/** Framing policy middleware assembled for the server entrypoint. */
export const frameAncestors = createFrameAncestorsMiddleware(() => readEmbedOrigins());
