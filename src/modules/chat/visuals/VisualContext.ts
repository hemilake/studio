import { createContext, useContext } from 'react';

/**
 * Fork (inline visuals): true inside the half of a streaming reply that is
 * still being written. A visual there may be incomplete, so it shows a
 * placeholder and mounts its frame once its block settles or the reply ends.
 */
export const VisualPendingContext = createContext(false);

export type VisualActions = {
  /** Puts text in the composer; `send` submits it as if the owner pressed Enter. */
  fillComposer: (text: string, send: boolean) => void;
  /** The chat's permission mode: in bypass a widget's sendPrompt only prefills. */
  permissionMode: string | null;
};

/** Provided by ChatInterface; null where markdown renders outside a chat (previews, tests). */
export const VisualActionsContext = createContext<VisualActions | null>(null);

export const useVisualActions = (): VisualActions | null => useContext(VisualActionsContext);
export const useVisualPending = (): boolean => useContext(VisualPendingContext);
