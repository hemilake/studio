import { useTranslation } from 'react-i18next';

import type { LLMProvider } from '@/shared/types';
import { LLMProviderLogo } from '@/shared/ui';

type AssistantHeaderProps = {
  kind: 'assistant' | 'tool' | 'error';
  provider: LLMProvider | string;
  /** Short local time of the first block of the turn; omitted when unknown. */
  time?: string;
};

/**
 * The provider's name over the first block of an assistant turn, with the time
 * it started. Rendered by MessageComponent and, when a turn opens with tool
 * calls, by ActivitySegment through ChatMessagesPane.
 */
export default function AssistantHeader({ kind, provider, time }: AssistantHeaderProps) {
  const { t } = useTranslation('chat');
  const name = kind === 'error'
    ? t('messageTypes.error')
    : kind === 'tool'
      ? t('messageTypes.tool')
      : provider === 'cursor'
        ? t('messageTypes.cursor')
        : provider === 'codex'
          ? t('messageTypes.codex')
          : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
            : provider === 'antigravity'
              ? t('messageTypes.antigravity', { defaultValue: 'Antigravity' })
              : t('messageTypes.claude');

  return (
    <div className="mb-2 flex items-center gap-2">
      {kind === 'error' ? (
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-destructive text-xs text-white">!</div>
      ) : kind === 'tool' ? (
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-gray-600 text-xs text-white dark:bg-gray-700">🔧</div>
      ) : (
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md p-0.5 text-foreground">
          <LLMProviderLogo provider={provider} className="h-full w-full" />
        </div>
      )}
      <span className="text-[13.5px] font-medium text-foreground">{name}</span>
      {time && <span className="font-mono text-[11px] text-muted-foreground/70">{time}</span>}
    </div>
  );
}
