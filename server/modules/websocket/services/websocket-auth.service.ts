import type { VerifyClientCallbackSync } from 'ws';

import { authenticateE2EWebSocketUpgrade } from '@/modules/e2e/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketAuthDependencies = {
  isPlatform: boolean;
  authenticateWebSocket: (token: string | null) => {
    id?: string | number;
    userId?: string | number;
    username?: string;
    [key: string]: unknown;
  } | null;
};

/**
 * Authenticates websocket upgrade requests before the `connection` handler runs.
 */
export function verifyWebSocketClient(
  info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0],
  dependencies: WebSocketAuthDependencies
): boolean {
  const request = info.req as AuthenticatedWebSocketRequest;
  const upgradeUrl = new URL(request.url ?? '/', 'http://localhost');
  const loggedUrl = new URL(upgradeUrl);
  if (loggedUrl.searchParams.has('token')) {
    loggedUrl.searchParams.set('token', 'REDACTED');
  }
  if (loggedUrl.searchParams.has('e2e_auth')) {
    loggedUrl.searchParams.set('e2e_auth', 'REDACTED');
  }

  console.log('WebSocket connection attempt to:', `${loggedUrl.pathname}${loggedUrl.search}`);

  const e2eKid = upgradeUrl.searchParams.get('e2e');
  let decryptedToken: string | null = null;
  if (e2eKid) {
    const e2eAuth = authenticateE2EWebSocketUpgrade(
      e2eKid,
      upgradeUrl.searchParams.get('e2e_auth'),
    );
    if (!e2eAuth) {
      console.log('[WARN] E2E WebSocket upgrade authentication failed');
      return false;
    }
    request.e2eSession = e2eAuth.session;
    request.e2eTargetPath = e2eAuth.path;
    decryptedToken = e2eAuth.token;
  }

  // Platform mode: use the first DB user and skip token checks.
  if (dependencies.isPlatform) {
    const user = dependencies.authenticateWebSocket(null);
    if (!user) {
      console.log('[WARN] Platform mode: No user found in database');
      return false;
    }

    request.user = user;
    console.log('[OK] Platform mode WebSocket authenticated for user:', user.username);
    return true;
  }

  // OSS mode: read JWT from E2E envelope first, then query string, then Authorization header.
  const token =
    decryptedToken ??
    upgradeUrl.searchParams.get('token') ??
    request.headers.authorization?.split(' ')[1] ??
    null;

  const user = dependencies.authenticateWebSocket(token);
  if (!user) {
    console.log('[WARN] WebSocket authentication failed');
    return false;
  }

  request.user = user;
  console.log('[OK] WebSocket authenticated for user:', user.username);
  return true;
}
