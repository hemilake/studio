import type { ProviderModelOption } from '@/shared/types';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

/**
 * Fork. Efforts that change what a turn does, not just how hard it thinks, stay
 * in the model menu only: `ultracode` (Claude) also switches on workflow
 * orchestration.
 */
const MENU_ONLY_EFFORTS = new Set(['ultracode']);

const SHORT_LABELS: Record<string, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
};

/** Compact label for one effort level on the picker. */
export const shortEffortLabel = (value: string): string => SHORT_LABELS[value] ?? value;

/** The effort values the picker offers, in catalog order. Shared by ComposerEffortPicker and ComposerModelMenu, which drops its own effort suffix for these. */
export function getQuickEffortValues(effortOptions: EffortOption[]): string[] {
  return effortOptions.map((option) => option.value).filter((value) => !MENU_ONLY_EFFORTS.has(value));
}
