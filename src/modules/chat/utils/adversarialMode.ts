import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * Fork. Adversarial mode: the composer asks Claude to get an independent
 * opinion from other agents before it answers. The ids must match the server
 * catalog in `server/shared/adversarial-review.ts`, which owns the commands.
 */
export type AdversaryOption = {
  id: string;
  label: string;
  /** The model behind it, shown as the menu row's description. */
  model: string;
};

export const ADVERSARY_OPTIONS: AdversaryOption[] = [
  { id: 'antigravity', label: 'Antigravity', model: 'Gemini 3.8 Flash (high)' },
  { id: 'codex', label: 'Codex', model: 'GPT-6 Astra (high)' },
];

/** What one click on the toggle turns on until the user picks otherwise. */
export const DEFAULT_ADVERSARIES = ['antigravity'];

const KNOWN_IDS = ADVERSARY_OPTIONS.map((option) => option.id);

/** Known ids in catalog order; anything else is dropped. */
export function normalizeAdversarySelection(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return KNOWN_IDS.filter((id) => value.includes(id));
}

/** The saved selection, or the default when nothing valid is saved. */
export function readAdversarySelection(): string[] {
  const stored = normalizeAdversarySelection(readUserPreference<unknown>('adversaries', null));
  return stored.length > 0 ? stored : DEFAULT_ADVERSARIES;
}

export function writeAdversarySelection(ids: string[]): void {
  const normalized = normalizeAdversarySelection(ids);
  const isDefault = normalized.length === DEFAULT_ADVERSARIES.length
    && normalized.every((id, index) => id === DEFAULT_ADVERSARIES[index]);
  writeUserPreference('adversaries', normalized.length > 0 && !isDefault ? normalized : null);
}

export const adversaryLabel = (id: string): string =>
  ADVERSARY_OPTIONS.find((option) => option.id === id)?.label ?? id;
