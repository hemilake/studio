import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { storeAuthToken } from '@/shared/authToken';
import {
  isEmbedExchangeAvailable,
  postToConsole,
  requestConsoleAssertion,
  startEmbedBridge,
} from '@/shared/embedBridge';
import AuthLoadingScreen from '@/modules/auth/AuthLoadingScreen';
import LoginForm from '@/modules/auth/LoginForm';

// Long enough for a console that is still loading its own page, short enough
// that a console without the exchange does not leave a blank frame for long.
const ASSERTION_TIMEOUT_MS = 8_000;

/**
 * Rendered by ProtectedRoute when Studio runs inside a Hemilake console and has
 * no session: it trades the console's signed assertion for a Studio token. The
 * stored token wakes AuthContext, which loads the user and lets the app through.
 * Any failure falls back to Studio's own login form.
 */
export default function EmbeddedSignIn() {
  // Whether the exchange is still being tried or has given way to the login form.
  const [phase, setPhase] = useState<'exchanging' | 'login'>('exchanging');

  useEffect(() => {
    let cancelled = false;

    const giveUp = (code: string) => {
      postToConsole({ v: 1, type: 'auth.failed', code });
      if (!cancelled) {
        setPhase('login');
      }
    };

    void (async () => {
      await startEmbedBridge();
      if (!isEmbedExchangeAvailable()) {
        giveUp('exchange_unavailable');
        return;
      }

      const assertion = await requestConsoleAssertion(ASSERTION_TIMEOUT_MS);
      if (cancelled) {
        return;
      }
      if (!assertion) {
        giveUp('no_assertion');
        return;
      }

      try {
        const response = await api.embed.exchange(assertion);
        const payload = (await response.json().catch(() => null)) as
          | { token?: unknown; error?: { code?: unknown } }
          | null;
        if (response.ok && storeAuthToken(payload?.token)) {
          return;
        }
        const code = typeof payload?.error?.code === 'string' ? payload.error.code : `http_${response.status}`;
        giveUp(code);
      } catch {
        giveUp('network_error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return phase === 'login' ? <LoginForm /> : <AuthLoadingScreen />;
}
