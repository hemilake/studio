import { useTranslation } from 'react-i18next';

import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';

type ConsoleOnlySignInProps = {
  // What the console's sign-in answered when it failed inside the frame.
  code?: string;
};

/**
 * Fork (Hemilake): shown when this Studio signs in through its console only
 * (CLOUDCLI_EMBED_ONLY) and has no session: opened outside the console, or the
 * console's assertion was refused. There is no form, because nobody may sign up
 * or sign in with a password here.
 */
export default function ConsoleOnlySignIn({ code }: ConsoleOnlySignInProps) {
  const { t } = useTranslation('auth');
  return (
    <AuthScreenLayout
      title={t('consoleOnly.title')}
      description={t('consoleOnly.description')}
      footerText={t('consoleOnly.footerText')}
    >
      <p className="text-center text-sm text-foreground">
        {code ? t('consoleOnly.failed', { code }) : t('consoleOnly.steps')}
      </p>
    </AuthScreenLayout>
  );
}
