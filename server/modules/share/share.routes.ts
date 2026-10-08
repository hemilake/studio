import { createHash } from 'node:crypto';

import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createShareService } from './share.service.js';

type ShareService = ReturnType<typeof createShareService>;
type AuthenticatedRequest = Request & { user?: { id?: number | string; userId?: number | string } };

const PUBLIC_NOT_FOUND_BODY = { error: 'Share not found' } as const;
const DEFAULT_RATE_LIMIT_MAX = 120;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

function readUserId(request: Request): number {
  const rawUser = (request as AuthenticatedRequest).user;
  const candidate = rawUser?.id ?? rawUser?.userId;
  const userId = Number(candidate);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AppError('Authenticated user is required.', {
      code: 'USER_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required.`, {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return value.trim();
}

function parsePatchPayload(payload: unknown): {
  title?: string | null;
  hiddenIds?: string[];
  expiresAt?: string | null;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const updates: {
    title?: string | null;
    hiddenIds?: string[];
    expiresAt?: string | null;
  } = {};

  if ('title' in body) {
    if (body.title === null) {
      updates.title = null;
    } else if (typeof body.title === 'string') {
      const trimmed = body.title.trim();
      if (trimmed.length > 500) {
        throw new AppError('title must be 500 characters or fewer.', {
          code: 'INVALID_TITLE',
          statusCode: 400,
        });
      }
      updates.title = trimmed || null;
    } else {
      throw new AppError('title must be a string or null.', {
        code: 'INVALID_TITLE',
        statusCode: 400,
      });
    }
  }

  if ('hiddenIds' in body) {
    if (!Array.isArray(body.hiddenIds) || !body.hiddenIds.every((item) => typeof item === 'string')) {
      throw new AppError('hiddenIds must be an array of strings.', {
        code: 'INVALID_HIDDEN_IDS',
        statusCode: 400,
      });
    }
    updates.hiddenIds = Array.from(
      new Set(body.hiddenIds.map((item) => item.trim()).filter(Boolean)),
    );
  }

  if ('expiresAt' in body) {
    if (body.expiresAt === null || body.expiresAt === '') {
      updates.expiresAt = null;
    } else if (typeof body.expiresAt === 'string') {
      const parsed = new Date(body.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new AppError('expiresAt must be a valid ISO timestamp or null.', {
          code: 'INVALID_EXPIRES_AT',
          statusCode: 400,
        });
      }
      updates.expiresAt = parsed.toISOString();
    } else {
      throw new AppError('expiresAt must be a valid ISO timestamp or null.', {
        code: 'INVALID_EXPIRES_AT',
        statusCode: 400,
      });
    }
  }

  return updates;
}

function setPublicShareHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function ifNoneMatchMatches(headerValue: string | string[] | undefined, etag: string): boolean {
  if (!headerValue) {
    return false;
  }
  const raw = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
  return raw
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || candidate === etag || candidate === `W/${etag}`);
}

/**
 * Creates an in-memory per-IP rate limiter for the public share endpoint.
 *
 * Consumed by `createPublicShareRouter` and tested in `share.routes.test.ts`.
 */
export function createPublicShareRateLimiter(options: {
  maxRequests?: number;
  windowMs?: number;
  now?: () => number;
} = {}): RequestHandler {
  const maxRequests = options.maxRequests ?? DEFAULT_RATE_LIMIT_MAX;
  const windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const currentMs = now();
    if (buckets.size > 1000) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= currentMs) {
          buckets.delete(key);
        }
      }
    }

    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const existing = buckets.get(clientIp);

    if (!existing || existing.resetAt <= currentMs) {
      buckets.set(clientIp, { count: 1, resetAt: currentMs + windowMs });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - currentMs) / 1000));
      setPublicShareHeaders(res);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    next();
  };
}

/**
 * Creates the authenticated owner Share router mounted at `/api/shares`.
 *
 * Consumed by `share.module.ts` and `share.routes.test.ts`.
 */
export function createShareRouter(service: ShareService): express.Router {
  const router = express.Router();

  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = readUserId(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sessionId = readRequiredString(body.sessionId, 'sessionId');
      const provider = typeof body.provider === 'string' && body.provider.trim()
        ? body.provider.trim()
        : undefined;

      const share = service.createOrGetShare(userId, { sessionId, provider });
      res.setHeader('Cache-Control', 'no-store');
      res.json(share);
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = readUserId(req);
      const sessionId = readRequiredString(req.query.sessionId, 'sessionId');
      const share = service.getActiveShareBySession(userId, sessionId);
      res.setHeader('Cache-Control', 'no-store');
      res.json(share);
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = readUserId(req);
      const id = readRequiredString(req.params.id, 'id');
      const updates = parsePatchPayload(req.body);
      const share = service.updateShare(userId, id, updates);
      res.setHeader('Cache-Control', 'no-store');
      res.json(share);
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = readUserId(req);
      const id = readRequiredString(req.params.id, 'id');
      const result = service.revokeShare(userId, id);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, ...result });
    }),
  );

  router.get(
    '/:id/preview',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = readUserId(req);
      const id = readRequiredString(req.params.id, 'id');
      const preview = await service.getSharePreview(userId, id);
      res.setHeader('Cache-Control', 'no-store');
      res.json(preview);
    }),
  );

  return router;
}

/**
 * Creates the unauthenticated public Share router mounted at `/api/public/shares`.
 *
 * Consumed by `share.module.ts` and `share.routes.test.ts`.
 */
export function createPublicShareRouter(
  service: ShareService,
  options: {
    maxRequestsPerMinute?: number;
    windowMs?: number;
    now?: () => number;
  } = {},
): express.Router {
  const router = express.Router();
  const rateLimiter = createPublicShareRateLimiter({
    maxRequests: options.maxRequestsPerMinute,
    windowMs: options.windowMs,
    now: options.now,
  });

  router.use(rateLimiter);

  router.get('/:token', async (req: Request, res: Response, next: NextFunction) => {
    setPublicShareHeaders(res);
    const token = typeof req.params.token === 'string' ? req.params.token : '';

    try {
      const payload = await service.getPublicShare(token);
      const serialized = JSON.stringify(payload);
      const etag = `"${createHash('sha256').update(serialized).digest('base64url')}"`;

      res.setHeader('ETag', etag);

      if (ifNoneMatchMatches(req.headers['if-none-match'], etag)) {
        res.status(304).end();
        return;
      }

      res.status(200).type('application/json').send(serialized);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 404) {
        res.status(404).json(PUBLIC_NOT_FOUND_BODY);
        return;
      }
      next(error);
    }
  });

  return router;
}
