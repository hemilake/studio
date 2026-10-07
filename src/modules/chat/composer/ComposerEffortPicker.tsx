import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProviderModelOption } from '@/shared/types';
import { cn } from '@/shared/utils';
import { getQuickEffortValues, shortEffortLabel } from '@/modules/chat/utils/composerEffort';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

type ComposerEffortPickerProps = {
  effort: string;
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
};

/**
 * Fork. Rendered by chat's ChatComposer next to the model menu so the reasoning
 * effort is one click away on wide screens. Phones have no room for it; there
 * the model menu shows the level and lists every value.
 */
function ComposerEffortPicker({ effort, effortOptions, onSelectEffort }: ComposerEffortPickerProps) {
  const { t } = useTranslation('chat');
  const values = getQuickEffortValues(effortOptions);
  if (values.length === 0) {
    return null;
  }

  const heading = t('composer.reasoning', { defaultValue: 'Reasoning' });

  return (
    <div
      role="radiogroup"
      aria-label={heading}
      className="hidden h-8 shrink-0 items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5 sm:flex"
    >
      {values.map((value) => {
        const isSelected = value === effort;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => {
              if (!isSelected) onSelectEffort(value);
            }}
            title={`${heading}: ${value}`}
            className={cn(
              'h-full rounded-md px-2 text-xs font-medium transition-colors',
              isSelected
                ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {shortEffortLabel(value)}
          </button>
        );
      })}
    </div>
  );
}

/** Memoized for the same reason as ComposerModelMenu: the composer re-renders on every keystroke. */
export default memo(ComposerEffortPicker);
