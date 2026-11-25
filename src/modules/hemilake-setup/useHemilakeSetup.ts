import { useCallback, useEffect, useState } from 'react';

import { api, type HemilakeClaudeConnectionInput } from '@/shared/api';
import { getEmbedMode } from '@/shared/embedBridge';

export type HemilakeSetupStatus = {
  claude: { installed: boolean; installCommand: string };
  connection: { mode: 'account' | 'api-key' | 'gateway' | null; baseUrl: string | null };
  lake: { url: string | null; state: 'connected' | 'needs-sign-in' | 'failed' | 'unknown' | null; loginCommand: string; plugin: boolean };
};

const errorOf = async (response: Response, fallback: string) => {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === 'string' ? payload.error : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Fork (Hemilake): the standalone setup's state. Inside the console (embed mode) hemi owns all of it, so the hook
 * reports `available: false` and never calls the server.
 */
export function useHemilakeSetup() {
  const available = !getEmbedMode();
  const [status, setStatus] = useState<HemilakeSetupStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!available) return null;
    setLoading(true);
    try {
      const response = await api.hemilakeSetup.status();
      if (!response.ok) return null;
      const next = (await response.json()) as HemilakeSetupStatus;
      setStatus(next);
      return next;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, [available]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveConnection = useCallback(async (input: HemilakeClaudeConnectionInput) => {
    const response = await api.hemilakeSetup.saveClaudeConnection(input);
    if (!response.ok) throw new Error(await errorOf(response, 'Could not save the connection.'));
    await refresh();
  }, [refresh]);

  const connectLake = useCallback(async (address: string) => {
    const response = await api.hemilakeSetup.connectLake(address);
    if (!response.ok) throw new Error(await errorOf(response, 'Could not connect your Hemilake.'));
    const result = (await response.json()) as { replaced?: string[] };
    await refresh();
    return { replaced: result.replaced ?? [] };
  }, [refresh]);

  return { available, status, loading, refresh, saveConnection, connectLake };
}
