import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, Swords } from 'lucide-react';

import type { ProviderModelOption } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';
import { getQuickEffortValues, shortEffortLabel } from '@/modules/chat/utils/composerEffort';
import {
  ADVERSARY_OPTIONS,
  adversaryLabel,
  toggleAdversaryInSelection,
  type AdversarialModeControls,
} from '@/modules/chat/utils/adversarialMode';
import { cn } from '@/shared/utils';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

type ComposerModelMenuProps = {
  effort: string;
  /** Effort values the active provider/model actually accepts; empty hides the section. */
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
  model: string;
  /** Model catalog for the active provider; empty hides the section. */
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
  /** Fork: on phones adversarial mode lives in this menu instead of its own toggle. */
  adversarialMode?: AdversarialModeControls;
};

/**
 * Rendered by chat's ChatComposer as the popover for choosing the active
 * provider's model and reasoning effort for the next turn.
 */
function ComposerModelMenu({
  effort,
  effortOptions,
  onSelectEffort,
  model,
  modelOptions,
  onSelectModel,
  modelsLoading,
  adversarialMode,
}: ComposerModelMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [isModelSectionOpen, setIsModelSectionOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  // The model list starts collapsed every time the menu opens, the way Codex
  // shows reasoning first and keeps the longer model list one click away.
  useEffect(() => {
    if (!isOpen) {
      setIsModelSectionOpen(false);
    }
  }, [isOpen]);

  const defaultEffortLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const resolvedEffortOptions = useMemo<EffortOption[]>(
    () => (effortOptions.length > 0 ? [{ value: DEFAULT_EFFORT_VALUE }, ...effortOptions] : []),
    [effortOptions],
  );
  const effortLabel = effort === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : effort;
  // Fork: ComposerEffortPicker already shows these next to the trigger.
  const isEffortShownByPicker = useMemo(
    () => getQuickEffortValues(effortOptions).includes(effort),
    [effort, effortOptions],
  );

  const selectedModelOption = useMemo(
    () => modelOptions.find((option) => option.value === model) ?? null,
    [model, modelOptions],
  );
  const modelLabel = selectedModelOption?.label || model;

  const hasEffortSection = resolvedEffortOptions.length > 0;
  const hasModelSection = modelOptions.length > 0 || modelsLoading;
  if (!hasEffortSection && !hasModelSection) {
    return null;
  }

  const triggerLabel = hasModelSection ? modelLabel : effortLabel;
  // Phones drop the parenthetical ("Opus (1M context)" reads "Opus") to fit the toolbar.
  const phoneTriggerLabel = hasModelSection ? modelLabel.replace(/\s*\(.*\)\s*$/, '') || modelLabel : effortLabel;
  // Phones have no effort picker, so the trigger names the level itself.
  const showPhoneEffort = hasModelSection && hasEffortSection && effort !== DEFAULT_EFFORT_VALUE;
  const isAdversarialOn = Boolean(adversarialMode?.enabled);
  const adversaryNames = adversarialMode?.selection.map(adversaryLabel).join(' + ') ?? '';
  const ariaLabel = t('composer.modelMenu', {
    defaultValue: 'Select model and reasoning effort',
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className={cn(
          'flex h-8 min-w-0 max-w-32 shrink items-center gap-1 overflow-hidden rounded-lg border px-2 text-xs font-medium text-foreground transition-colors sm:max-w-56 sm:shrink-0',
          isAdversarialOn
            ? 'border-destructive/40 bg-destructive/10 hover:bg-destructive/15 sm:border-border/60 sm:bg-muted/40 sm:hover:bg-muted'
            : 'border-border/60 bg-muted/40 hover:bg-muted',
        )}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        {isAdversarialOn && <Swords className="h-3.5 w-3.5 shrink-0 text-destructive sm:hidden" aria-hidden />}
        {/* With adversarial mode on, phones trade the model name for the swords; the menu still names the model. */}
        {!(isAdversarialOn && showPhoneEffort) && <span className="truncate sm:hidden">{phoneTriggerLabel}</span>}
        <span className="hidden truncate sm:inline">{triggerLabel}</span>
        {showPhoneEffort && (
          <span className="shrink-0 text-muted-foreground sm:hidden">
            {isAdversarialOn ? shortEffortLabel(effort) : `· ${shortEffortLabel(effort)}`}
          </span>
        )}
        {hasModelSection && hasEffortSection && effort !== DEFAULT_EFFORT_VALUE && !isEffortShownByPicker && (
          <span className="hidden shrink-0 capitalize text-muted-foreground sm:inline">· {effortLabel}</span>
        )}
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          {hasEffortSection && (
            <>
              <ComposerMenuHeading>
                {t('composer.reasoning', { defaultValue: 'Reasoning' })}
              </ComposerMenuHeading>
              {resolvedEffortOptions.map((option) => (
                <ComposerMenuItem
                  key={option.value}
                  label={option.value === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : option.value}
                  description={option.description}
                  isSelected={option.value === effort}
                  onSelect={() => {
                    onSelectEffort(option.value);
                    setIsOpen(false);
                  }}
                  className="capitalize"
                />
              ))}
            </>
          )}

          {adversarialMode && (
            // Fork: phones only; wider screens have ComposerAdversarialToggle.
            <div className="sm:hidden">
              {hasEffortSection && <ComposerMenuSeparator />}
              <ComposerMenuHeading>
                {t('composer.adversaries', { defaultValue: 'Adversaries' })}
              </ComposerMenuHeading>
              <ComposerMenuItem
                role="menuitem"
                icon={<Swords className={cn('h-3.5 w-3.5', isAdversarialOn ? 'text-destructive' : 'text-muted-foreground')} />}
                label={isAdversarialOn
                  ? t('composer.adversarialOn', { names: adversaryNames, defaultValue: 'Adversarial mode on: {{names}}' })
                  : t('composer.adversarialOff', { names: adversaryNames, defaultValue: 'Adversarial mode: ask {{names}} too' })}
                isSelected={isAdversarialOn}
                trailing={isAdversarialOn ? <Check className="h-3.5 w-3.5 text-foreground" /> : <span />}
                onSelect={adversarialMode.onToggle}
              />
              {ADVERSARY_OPTIONS.map((option) => {
                const isPicked = adversarialMode.selection.includes(option.id);
                return (
                  <ComposerMenuItem
                    key={option.id}
                    role="menuitem"
                    label={option.label}
                    description={option.model}
                    isSelected={isPicked}
                    trailing={isPicked ? <Check className="h-3.5 w-3.5 text-foreground" /> : <span />}
                    onSelect={() => {
                      const next = toggleAdversaryInSelection(adversarialMode.selection, option.id);
                      if (next) {
                        adversarialMode.onChangeSelection(next);
                      }
                    }}
                    className="pl-8"
                  />
                );
              })}
            </div>
          )}

          {hasModelSection && (
            <>
              {(hasEffortSection || adversarialMode) && <ComposerMenuSeparator />}
              <ComposerMenuItem
                role="menuitem"
                label={modelLabel}
                isSelected={false}
                onSelect={() => setIsModelSectionOpen((current) => !current)}
                trailing={
                  isModelSectionOpen
                    ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                }
                className="text-muted-foreground"
              />

              {isModelSectionOpen && (
                <>
                  <ComposerMenuHeading>
                    {t('composer.model', { defaultValue: 'Model' })}
                  </ComposerMenuHeading>
                  {modelOptions.length === 0 && modelsLoading && (
                    <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                      {t('composer.loadingModels', { defaultValue: 'Loading models…' })}
                    </p>
                  )}
                  {modelOptions.map((option) => (
                    <ComposerMenuItem
                      key={option.value}
                      label={option.label || option.value}
                      isSelected={option.value === model}
                      onSelect={() => {
                        onSelectModel(option.value);
                        setIsOpen(false);
                      }}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of this menu's props change while typing. */
export default memo(ComposerModelMenu);
