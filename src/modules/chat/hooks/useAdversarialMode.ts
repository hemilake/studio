import { useCallback, useEffect, useState } from 'react';

import { subscribeToUserPreferences } from '@/shared/userSettings';
import { readAdversarySelection, writeAdversarySelection } from '@/modules/chat/utils/adversarialMode';

/**
 * Fork. Owned by ChatInterface. The on/off state lives in memory and lasts one
 * message: sending a turn turns it off, and a reload always starts with it off.
 * The selection is a user preference, so it follows the user to other devices.
 */
export function useAdversarialMode() {
  const [enabled, setEnabled] = useState(false);
  const [selection, setSelection] = useState<string[]>(readAdversarySelection);

  // Picks up the server copy once preferences hydrate, and edits from another tab.
  useEffect(() => subscribeToUserPreferences(() => {
    const next = readAdversarySelection();
    setSelection((current) => (current.join(',') === next.join(',') ? current : next));
  }), []);

  const toggle = useCallback(() => setEnabled((current) => !current), []);
  const enable = useCallback(() => setEnabled(true), []);
  const disable = useCallback(() => setEnabled(false), []);
  const changeSelection = useCallback((ids: string[]) => {
    writeAdversarySelection(ids);
    setSelection(readAdversarySelection());
  }, []);

  return { enabled, selection, toggle, enable, disable, changeSelection };
}
