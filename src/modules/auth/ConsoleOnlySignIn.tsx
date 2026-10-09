import { useTranslation } from 'react-i18next';

import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';

type ConsoleOnlySignInProps = {
  // What the console's sign-in answered when it failed inside the frame.
  code?: string;
  // Inside the frame: asks the console for a new assertion.
  onRetry?: () => void;
};

/**
 * Fork (Hemilake): shown when Studio has no session and no form to offer.
 * Opened outside the console, a console-only Studio (CLOUDCLI_EMBED_ONLY) sends
 * the owner to the console. Inside the console, the console's sign-in failed:
 * it says why and offers to try again, never a username and password.
 */
export default function ConsoleOnlySignIn({ code, onRetry }: ConsoleOnlySignInProps) {
  const { t } = useTranslation('auth');
  if (code) {
    return (
      <AuthScreenLayout
        title={t('consoleOnly.failedTitle')}
        description={t('consoleOnly.failedDescription')}
        footerText={t('consoleOnly.footerText')}
      >
        <p className="text-center text-sm text-foreground">{t('consoleOnly.failed', { code })}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-all duration-200 hover:brightness-110 active:scale-[0.99]"
          >
            {t('consoleOnly.retry')}
          </button>
        )}
      </AuthScreenLayout>
    );
  }
  return (
    <AuthScreenLayout
      title={t('consoleOnly.title')}
      description={t('consoleOnly.description')}
      footerText={t('consoleOnly.footerText')}
    >
      <p className="text-center text-sm text-foreground">{t('consoleOnly.steps')}</p>
    </AuthScreenLayout>
  );
}
