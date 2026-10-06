import { memo, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Swords } from 'lucide-react';

import { cn } from '@/shared/utils';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';
import { ADVERSARY_OPTIONS, adversaryLabel } from '@/modules/chat/utils/adversarialMode';

type ComposerAdversarialToggleProps = {
  enabled: boolean;
  /** Adversaries the next turn consults when enabled; never empty. */
  selection: string[];
  onToggle: () => void;
  onChangeSelection: (ids: string[]) => void;
};

/**
 * Fork. Rendered by chat's ChatComposer before the permission menu when Claude
 * is the provider. The swords icon turns adversarial mode on and off with one
 * click; the chevron opens the list of adversaries, which is remembered.
 */
function ComposerAdversarialToggle({ enabled, selection, onToggle, onChangeSelection }: ComposerAdversarialToggleProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 18 * 16);

  const names = selection.map(adversaryLabel).join(' + ');
  const heading = t('composer.adversaries', { defaultValue: 'Adversaries' });
  const toggleLabel = enabled
    ? t('composer.adversarialOn', { names, defaultValue: 'Adversarial mode on: {{names}}' })
    : t('composer.adversarialOff', { names, defaultValue: 'Adversarial mode: ask {{names}} too' });

  const toggleAdversary = (id: string) => {
    const next = selection.includes(id)
      ? selection.filter((current) => current !== id)
      : [...selection, id];
    // At least one adversary always stays selected; turning the mode off is the toggle's job.
    if (next.length === 0) {
      return;
    }
    onChangeSelection(next);
  };

  const segmentTone = enabled
    ? 'border-destructive/40 bg-destructive/10 text-destructive'
    : 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted';

  return (
    <>
      <div className="flex h-8 shrink-0 items-stretch">
        <button
          type="button"
          onClick={onToggle}
          className={cn('relative flex w-8 items-center justify-center rounded-l-lg border transition-colors', segmentTone)}
          aria-pressed={enabled}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          <Swords className="h-4 w-4" />
          {enabled && selection.length > 1 && (
            <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-[9px] font-bold text-white">
              {selection.length}
            </span>
          )}
        </button>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            updateAnchor();
            setIsOpen((current) => !current);
          }}
          className={cn('flex w-4 items-center justify-center rounded-r-lg border border-l-0 transition-colors', segmentTone)}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-label={heading}
          title={heading}
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={heading}>
          <ComposerMenuHeading>
            {t('composer.adversariesHeading', { defaultValue: 'Who should Claude ask for a second opinion?' })}
          </ComposerMenuHeading>
          {ADVERSARY_OPTIONS.map((option) => {
            const isSelected = selection.includes(option.id);
            return (
              <ComposerMenuItem
                key={option.id}
                role="menuitem"
                label={option.label}
                description={option.model}
                isSelected={isSelected}
                trailing={isSelected ? <Check className="h-3.5 w-3.5 text-foreground" /> : <span />}
                onSelect={() => toggleAdversary(option.id)}
              />
            );
          })}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/** Memoized for the same reason as ComposerPermissionMenu: the composer re-renders on every keystroke. */
export default memo(ComposerAdversarialToggle);
