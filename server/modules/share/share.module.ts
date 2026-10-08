import { sessionSharesDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';

import { createPublicShareRouter, createShareRouter } from './share.routes.js';
import { createShareService } from './share.service.js';

const shareService = createShareService({
  shares: {
    create: (input) => sessionSharesDb.create(input),
    getById: (id) => sessionSharesDb.getById(id),
    getByToken: (token) => sessionSharesDb.getByToken(token),
    getActiveBySession: (userId, sessionId, nowIso) =>
      sessionSharesDb.getActiveBySession(userId, sessionId, nowIso),
    update: (id, updates) => sessionSharesDb.update(id, updates),
    revoke: (id, nowIso) => sessionSharesDb.revoke(id, nowIso),
  },
  sessions: {
    getById: (sessionId) =>
      sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId) ?? undefined,
    fetchHistory: (sessionId) => sessionsService.fetchHistory(sessionId, { limit: null, offset: 0 }),
    isRunning: (sessionId) =>
      sessionsService.listRunningSessions().some((run) => run.sessionId === sessionId),
  },
  now: () => Date.now(),
});

/** Owner share router assembled for the server entrypoint (`authenticateToken` protected). */
export const shareRoutes = createShareRouter(shareService);

/** Public read-only share router assembled for the server entrypoint (no authentication). */
export const publicShareRoutes = createPublicShareRouter(shareService);
