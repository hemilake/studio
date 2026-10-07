import type { ReactNode } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { getEmbedMode } from '@/shared/embedBridge';
import { useAuth } from '@/modules/auth/context/AuthContext';
import { Onboarding } from '@/modules/onboarding';
import AuthLoadingScreen from '@/modules/auth/AuthLoadingScreen';
import ConsoleOnlySignIn from '@/modules/auth/ConsoleOnlySignIn';
import EmbeddedSignIn from '@/modules/auth/EmbeddedSignIn';
import LoginForm from '@/modules/auth/LoginForm';
import SetupForm from '@/modules/auth/SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

/** Used by App to gate the routed application behind setup, login and onboarding. */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, consoleOnly, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  if (consoleOnly && !user) {
    // Fork (Hemilake): this Studio signs in through its console only, never by a form.
    return getEmbedMode() ? <EmbeddedSignIn consoleOnly /> : <ConsoleOnlySignIn />;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    // Fork (embed mode): inside a Hemilake console the console signs Studio in.
    return getEmbedMode() ? <EmbeddedSignIn /> : <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
