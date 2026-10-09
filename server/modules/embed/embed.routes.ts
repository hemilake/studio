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

  router.post('/exchange', async (req, res, next) => {
    try {
      const body = req.body as { assertion?: unknown } | undefined;
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.exchange(body?.assertion));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * What Studio's own frames may load or navigate to (fork, inline visuals): its
 * origin and blob: (the PDF preview). A visual's sandboxed frame inherits no
 * cookies or storage, but without this it could still navigate itself to
 * another site and carry data in the URL; the embedder's frame-src blocks that.
 * srcdoc frames are not fetched, so they are unaffected. docs/fork/visuals.md.
 */
export const FRAME_SRC = "frame-src 'self' blob:";

/**
 * Creates the middleware that tells browsers who may frame Studio: itself and
 * the configured console origins, nobody else. Before the fork added embed mode
 * Studio sent no framing policy at all, so any site could frame it. The same
 * header carries FRAME_SRC.
 */
export function createFrameAncestorsMiddleware(readOrigins: () => string[]): RequestHandler {
  return (_req, res, next) => {
    const sources = ["'self'", ...readOrigins()].join(' ');
    res.setHeader('Content-Security-Policy', `frame-ancestors ${sources}; ${FRAME_SRC}`);
    next();
  };
}

type CorsOriginCallback = (error: Error | null, allow?: boolean) => void;

/**
 * Creates the `origin` option of the CORS middleware (fork): Studio's own pages
 * are same-origin and need no CORS, so only the consoles allowed to frame it may
 * read its answers from another origin. Before, any site could, and a fresh
 * Studio's sign-up answered with its token to whatever page called it.
 */
export function createCorsOriginCheck(readOrigins: () => string[]) {
  return (origin: string | undefined, callback: CorsOriginCallback) => {
    callback(null, Boolean(origin) && readOrigins().includes(origin as string));
  };
}
