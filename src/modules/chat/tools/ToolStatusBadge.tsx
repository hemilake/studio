import { cn } from '@/shared/utils';
import type { ToolStatus } from '@/shared/types';


const STATUS_CONFIG: Record<ToolStatus, { label: string; className: string }> = {
  running: {
    label: 'Running',
    className: 'bg-muted text-hemi-copper-text',
  },
  completed: {
    label: 'Completed',
    className: 'bg-hemi-ok-tint text-hemi-ok',
  },
  error: {
    label: 'Error',
    className: 'bg-destructive/10 text-destructive',
  },
  denied: {
    label: 'Denied',
    className: 'bg-hemi-copper-tint text-hemi-copper-text',
  },
};

type ToolStatusBadgeProps = {
  status: ToolStatus;
  className?: string;
};

/**
 * Used by chat's ToolRenderer, BashCommandDisplay and OneLineDisplay to label a
 * tool call's pending, running, error or denied state.
 */
export function ToolStatusBadge({ status, className }: ToolStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium',
        config.className,
        className,
      )}
    >
      {config.label}
    </span>
  );
}
