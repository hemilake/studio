import { useTranslation } from 'react-i18next';

import { BrandMark, BrandWordmark, useBrandName } from '@/shared/ui';

const loadingDotAnimationDelays = ['0s', '0.15s', '0.3s'];

/** Rendered by the auth module's ProtectedRoute while the initial auth status check is in flight. */
export default function AuthLoadingScreen() {
  const { t } = useTranslation('auth');
  const brandName = useBrandName();
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <div className="relative text-center" role="status" aria-live="polite">
        <div className="mb-5 flex justify-center">
          <BrandMark size="large" className="h-14 w-14 text-foreground" />
        </div>

        <h1 className="mb-4 text-2xl" aria-label={brandName}>
          <BrandWordmark />
        </h1>
        <p className="sr-only">{t('misc.loadingState')}</p>
        <div aria-hidden className="flex items-center justify-center gap-2">
          {loadingDotAnimationDelays.map((delay) => (
            <div
              key={delay}
              className="h-2 w-2 animate-bounce rounded-full bg-hemi-copper"
              style={{ animationDelay: delay }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
