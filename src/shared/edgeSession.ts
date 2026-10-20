/**
 * Fork (edge session): recovers from an expired login at the proxy in front of
 * Studio (Cloudflare Access on cloudcli.almansa.dev).
 *
 * When the proxy's cookie expires it answers every request with a redirect to
 * its login page. A page navigation would follow it and sign in again on its
 * own (auto-redirect to Google), but the app only makes fetches and websocket
 * upgrades after the first load: fetches fail on the cross-origin redirect and
 * the websocket keeps reconnecting, so the app looks broken until a reload.
 *
 * The check asks `/health` with `redirect: 'manual'`. Studio answers it without
 * a token, so an opaque redirect can only come from the proxy; then the page
 * reloads and the browser goes through the login. Without a proxy (localhost,
 * 127.0.0.1) the answer is a plain 200 and nothing happens.
 */

const PROBE_URL = '/health';
const MIN_PROBE_INTERVAL_MS = 15_000;
// A reload that lands back on an expired session (the sign-in needs the user,
// or the proxy keeps redirecting) must not turn into a reload loop.
const MIN_RELOAD_INTERVAL_MS = 60_000;
const LAST_RELOAD_STORAGE_KEY = 'studio-edge-session-reload-at';

let inFlight: Promise<boolean> | null = null;
let lastProbeAt = 0;

type EdgeSessionDeps = {
  fetch: typeof fetch;
  now: () => number;
  reload: () => void;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  framed: boolean;
};

const browserDeps = (): EdgeSessionDeps => ({
  fetch: (...args) => window.fetch(...args),
  now: () => Date.now(),
  reload: () => window.location.reload(),
  storage: (() => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  })(),
  framed: window.parent !== window,
});

/** True when the proxy in front of Studio is redirecting to its login page. */
export async function isEdgeSessionExpired(deps: Pick<EdgeSessionDeps, 'fetch'>): Promise<boolean> {
  try {
    const response = await deps.fetch(PROBE_URL, {
      redirect: 'manual',
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return response.type === 'opaqueredirect';
  } catch {
    // Offline or the server is down: not a login problem, the reconnect
    // logic already handles it.
    return false;
  }
}

/**
 * Checks the proxy session and reloads the page when it expired. Cheap to call
 * from any failure path: concurrent calls share one probe and calls within
 * MIN_PROBE_INTERVAL_MS of the last one are skipped. Resolves to whether it
 * reloaded.
 */
export function checkEdgeSession(deps: EdgeSessionDeps = browserDeps()): Promise<boolean> {
  // Inside a Hemilake console the login page cannot render in the frame
  // (Google refuses to be framed), so a reload would only blank it.
  if (deps.framed) {
    return Promise.resolve(false);
  }
  if (inFlight) {
    return inFlight;
  }
  const now = deps.now();
  if (now - lastProbeAt < MIN_PROBE_INTERVAL_MS) {
    return Promise.resolve(false);
  }
  lastProbeAt = now;

  inFlight = isEdgeSessionExpired(deps)
    .then((expired) => {
      if (!expired) {
        return false;
      }
      const lastReload = Number(deps.storage?.getItem(LAST_RELOAD_STORAGE_KEY) ?? 0);
      if (deps.now() - lastReload < MIN_RELOAD_INTERVAL_MS) {
        console.warn('Edge session still expired after a reload; not reloading again');
        return false;
      }
      deps.storage?.setItem(LAST_RELOAD_STORAGE_KEY, String(deps.now()));
      deps.reload();
      return true;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Checks the session when the tab comes back to the foreground or the network
 * returns: the usual moment to find it expired is opening the app the next
 * morning, before any request has failed.
 */
export function startEdgeSessionWatch(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void checkEdgeSession();
    }
  });
  window.addEventListener('online', () => {
    void checkEdgeSession();
  });
}

/** Test hook: forget the throttle and any probe in flight. */
export function resetEdgeSessionStateForTests(): void {
  inFlight = null;
  lastProbeAt = 0;
}
