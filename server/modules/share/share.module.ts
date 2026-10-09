import { sessionSharesDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';

import { createPublicShareRouter, createShareRouter } from './share.routes.js';
import { createShareService } from './share.service.js';
import { createCloudShareSyncService, createConsoleShareClient } from './share.sync.js';

const sessionsAdapter = {
  getById: (sessionId: string) =>
    sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId) ?? undefined,
  fetchHistory: (sessionId: string) => sessionsService.fetchHistory(sessionId, { limit: null, offset: 0 }),
  isRunning: (sessionId: string) =>
    sessionsService.listRunningSessions().some((run) => run.sessionId === sessionId),
};

const consoleClient = createConsoleShareClient({
  now: () => Date.now(),
});

const cloudSyncService = createCloudShareSyncService({
  shares: {
    getById: (id) => sessionSharesDb.getById(id),
    listActiveCloudShares: (nowIso) => sessionSharesDb.listActiveCloudShares(nowIso),
    listPendingCloudDeletes: () => sessionSharesDb.listPendingCloudDeletes(),
    update: (id, updates) => sessionSharesDb.update(id, updates),
  },
  sessions: sessionsAdapter,
  consoleClient,
  now: () => Date.now(),
});

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
  sessions: sessionsAdapter,
  cloudSync: cloudSyncService,
  now: () => Date.now(),
});

/** Starts the 5-second background sync loop for active cloud shares and pending deletes. */
export function initializeCloudShareSync(): void {
  cloudSyncService.start();
}

/** Stops the background sync loop for active cloud shares on server shutdown. */
export function closeCloudShareSync(): void {
  cloudSyncService.stop();
}

/** Owner share router assembled for the server entrypoint (`authenticateToken` protected). */
export const shareRoutes = createShareRouter(shareService);

/** Public read-only share router assembled for the server entrypoint (no authentication). */
export const publicShareRoutes = createPublicShareRouter(shareService);
