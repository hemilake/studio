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
import ConsoleOnlySignIn from '@/modules/auth/ConsoleOnlySignIn';
import LoginForm from '@/modules/auth/LoginForm';
import SetupForm from '@/modules/auth/SetupForm';

// Long enough for a console that is still loading its own page, short enough
// that a console without the exchange does not leave a blank frame for long.
const ASSERTION_TIMEOUT_MS = 8_000;

type EmbeddedSignInProps = {
  // The server signs in through its console only (CLOUDCLI_EMBED_ONLY).
  consoleOnly?: boolean;
  // The instance has no account yet.
  needsSetup?: boolean;
};

/**
 * Rendered by ProtectedRoute when Studio runs inside a Hemilake console and has
 * no session: it trades the console's signed assertion for a Studio token, and
 * the exchange creates the account when there is none. The stored token wakes
 * AuthContext, which loads the user and lets the app through.
 *
 * Inside the frame there is never a username and password while the console can
 * sign Studio in: a failure shows what went wrong and a way to try again. Only
 * when this Studio does not take the console's sign-in at all (no secret set)
 * and is not console-only does it fall back to its own setup or login form.
 */
export default function EmbeddedSignIn({ consoleOnly = false, needsSetup = false }: EmbeddedSignInProps) {
  // Whether the exchange is being tried, failed, or this Studio only has its own forms.
  const [phase, setPhase] = useState<'exchanging' | 'failed' | 'forms'>('exchanging');
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const giveUp = (code: string) => {
      postToConsole({ v: 1, type: 'auth.failed', code });
      if (!cancelled) {
        setFailure(code);
        setPhase('failed');
      }
    };

    void (async () => {
      await startEmbedBridge();
      if (!isEmbedExchangeAvailable()) {
        if (consoleOnly) {
          giveUp('exchange_unavailable');
          return;
        }
        // The console cannot sign this Studio in: its own forms are the only way.
        postToConsole({ v: 1, type: 'auth.failed', code: 'exchange_unavailable' });
        if (!cancelled) {
          setPhase('forms');
        }
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
  }, [attempt, consoleOnly]);

  if (phase === 'exchanging') {
    return <AuthLoadingScreen />;
  }
  if (phase === 'forms') {
    return needsSetup ? <SetupForm /> : <LoginForm />;
  }
  const retry = () => {
    setPhase('exchanging');
    setAttempt((previous) => previous + 1);
  };
  return <ConsoleOnlySignIn code={failure} onRetry={retry} />;
}
