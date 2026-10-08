import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { SessionActivity } from '@/shared/types';

type ComposerStatusPillProps = {
  activity: SessionActivity | null;
};

/**
 * Fork (Hemilake Studio activity): the running turn's state and elapsed time,
 * as a pill in the composer's toolbar next to the token count. It replaces the
 * floating "Thinking… 2m 3s" tab that sat over the last lines of the chat; what
 * runs now is the live line in the transcript, and Stop stays the composer's
 * submit button. Phones show only the time.
 */
export default function ComposerStatusPill({ activity }: ComposerStatusPillProps) {
  const { t } = useTranslation('chat');
  const startedAt = activity?.startedAt ?? null;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (startedAt === null) return undefined;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!activity) return null;

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsed = minutes < 1 ? `${seconds}s` : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const label = t('claudeStatus.actions.working', { defaultValue: 'Working' });

  return (
    <span
      className="inline-flex h-8 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-hemi-copper-tint px-2.5 text-[12.5px] font-medium text-hemi-copper-text"
      role="status"
      data-composer-status=""
    >
      <span className="h-[7px] w-[7px] flex-shrink-0 rounded-full bg-hemi-copper" aria-hidden />
      <span className="hidden sm:inline">{label}</span>
      <span className="hidden sm:inline" aria-hidden>·</span>
      <span className="font-mono tabular-nums">{elapsed}</span>
    </span>
  );
}
