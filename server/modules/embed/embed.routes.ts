import express from 'express';
import type { RequestHandler } from 'express';

import type { createEmbedService } from './embed.service.js';

/**
 * Creates the Embed transport adapter: the public configuration and the
 * sign-in exchange. Both are public because the framed client calls them
 * before it holds a session.
 */
export function createEmbedRouter(service: ReturnType<typeof createEmbedService>): express.Router {
  const router = express.Router();

  router.get('/config', (_req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(service.getPublicConfig());
    } catch (error) {
      next(error);
    }
  });

  router.post('/exchange', (req, res, next) => {
    try {
      const body = req.body as { assertion?: unknown } | undefined;
      res.setHeader('Cache-Control', 'no-store');
      res.json(service.exchange(body?.assertion));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * Creates the middleware that tells browsers who may frame Studio: itself and
 * the configured console origins, nobody else. Before the fork added embed mode
 * Studio sent no framing policy at all, so any site could frame it.
 */
export function createFrameAncestorsMiddleware(readOrigins: () => string[]): RequestHandler {
  return (_req, res, next) => {
    const sources = ["'self'", ...readOrigins()].join(' ');
    res.setHeader('Content-Security-Policy', `frame-ancestors ${sources}`);
    next();
  };
}
