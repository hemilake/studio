import { useCallback, useEffect, useState } from 'react';

import { subscribeToUserPreferences } from '@/shared/userSettings';
import { readAdversarySelection, writeAdversarySelection } from '@/modules/chat/utils/adversarialMode';

/**
 * Fork. Owned by ChatInterface. The on/off state lives in memory, so a reload
 * always starts with the mode off; the selection is a user preference, so it
 * follows the user to other devices.
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
  const changeSelection = useCallback((ids: string[]) => {
    writeAdversarySelection(ids);
    setSelection(readAdversarySelection());
  }, []);

  return { enabled, selection, toggle, changeSelection };
}
