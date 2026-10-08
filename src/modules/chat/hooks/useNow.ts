import { useEffect, useState } from 'react';

/** "0.7s", "38s", "2m 03s": a step, a segment or a turn. Empty when unknown. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  const seconds = ms / 1000;
  if (seconds < 9.95) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}

/** The current time, refreshed every second while `active`, for an elapsed time. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
