import { memo } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle,
  ChevronUp,
  Circle,
  Clock,
  Minus,
  Pause,
  X,
} from 'lucide-react';

import { cn } from '@/shared/utils';
import { Tooltip } from '@/shared/ui';
import type { TaskMasterTask } from '@/shared/types';

type TaskCardProps = {
  task: TaskMasterTask;
  onClick?: (() => void) | null;
  showParent?: boolean;
  className?: string;
};

type TaskStatusStyle = {
  icon: typeof Circle;
  statusText: string;
  iconColor: string;
  textColor: string;
};

function getStatusStyle(status?: string): TaskStatusStyle {
  if (status === 'done') {
    return {
      icon: CheckCircle,
      statusText: 'Done',
      iconColor: 'text-hemi-ok',
      textColor: 'text-hemi-ok',
    };
  }

  if (status === 'in-progress') {
    return {
      icon: Clock,
      statusText: 'In Progress',
      iconColor: 'text-hemi-copper-text',
      textColor: 'text-foreground',
    };
  }

  if (status === 'review') {
    return {
      icon: AlertCircle,
      statusText: 'Review',
      iconColor: 'text-hemi-copper-text',
      textColor: 'text-hemi-copper-text',
    };
  }

  if (status === 'deferred') {
    return {
      icon: Pause,
      statusText: 'Deferred',
      iconColor: 'text-gray-500 dark:text-gray-400',
      textColor: 'text-gray-700 dark:text-gray-300',
    };
  }

  if (status === 'cancelled') {
    return {
      icon: X,
      statusText: 'Cancelled',
      iconColor: 'text-destructive',
      textColor: 'text-destructive',
    };
  }

  return {
    icon: Circle,
    statusText: 'Pending',
    iconColor: 'text-gray-500 dark:text-gray-400',
    textColor: 'text-gray-900 dark:text-gray-100',
  };
}

function renderPriorityIcon(priority?: string) {
  if (priority === 'high') {
    return (
      <Tooltip content="High priority">
        <div className="flex h-4 w-4 items-center justify-center rounded bg-destructive/10">
          <ChevronUp className="h-2.5 w-2.5 text-destructive" />
        </div>
      </Tooltip>
    );
  }

  if (priority === 'medium') {
    return (
      <Tooltip content="Medium priority">
        <div className="flex h-4 w-4 items-center justify-center rounded bg-hemi-copper-tint">
          <Minus className="h-2.5 w-2.5 text-hemi-copper-text" />
        </div>
      </Tooltip>
    );
  }

  if (priority === 'low') {
    return (
      <Tooltip content="Low priority">
        <div className="flex h-4 w-4 items-center justify-center rounded bg-muted">
          <Circle className="h-1.5 w-1.5 fill-current text-hemi-copper-text" />
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip content="No priority set">
      <div className="flex h-4 w-4 items-center justify-center rounded bg-gray-100 dark:bg-gray-800">
        <Circle className="h-1.5 w-1.5 text-gray-400 dark:text-gray-500" />
      </div>
    </Tooltip>
  );
}

function getSubtaskProgress(task: TaskMasterTask): { completed: number; total: number; percentage: number } {
  const subtasks = task.subtasks ?? [];
  const total = subtasks.length;
  const completed = subtasks.filter((subtask) => subtask.status === 'done').length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { completed, total, percentage };
}

/** Rendered by TaskBoardContent for one task tile, showing its status, priority and subtask progress. */
function TaskCard({ task, onClick = null, showParent = false, className = '' }: TaskCardProps) {
  const statusStyle = getStatusStyle(task.status);
  const progress = getSubtaskProgress(task);

  return (
    <div
      className={cn(
        'bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3',
        'hover:shadow-md hover:border-border transition-all duration-200',
        onClick ? 'cursor-pointer hover:-translate-y-0.5' : 'cursor-default',
        className,
      )}
      onClick={onClick ?? undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <Tooltip content={`Task ID: ${task.id}`}>
              <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                {task.id}
              </span>
            </Tooltip>
          </div>

          <h3 className="line-clamp-2 text-sm font-medium leading-tight text-gray-900 dark:text-white">
            {task.title}
          </h3>

          {showParent && task.parentId && (
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Task {task.parentId}</span>
          )}
        </div>

        <div className="flex-shrink-0">{renderPriorityIcon(task.priority)}</div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center">
          {Array.isArray(task.dependencies) && task.dependencies.length > 0 && (
            <Tooltip content={`Depends on: ${task.dependencies.map((dependency) => `Task ${dependency}`).join(', ')}`}>
              <div className="flex items-center gap-1 text-xs text-hemi-copper-text">
                <ArrowRight className="h-3 w-3" />
                <span>Depends on: {task.dependencies.join(', ')}</span>
              </div>
            </Tooltip>
          )}
        </div>

        <Tooltip content={`Status: ${statusStyle.statusText}`}>
          <div className="flex items-center gap-1">
            <div className={cn('w-2 h-2 rounded-full', statusStyle.iconColor.replace('text-', 'bg-'))} />
            <span className={cn('text-xs font-medium', statusStyle.textColor)}>{statusStyle.statusText}</span>
          </div>
        </Tooltip>
      </div>

      {progress.total > 0 && (
        <div className="ml-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-gray-400">Progress:</span>
            <div className="h-1.5 flex-1 rounded-full bg-gray-200 dark:bg-gray-700" title={`${progress.completed} of ${progress.total} subtasks completed`}>
              <div
                className={cn('h-full rounded-full transition-all duration-300', task.status === 'done' ? 'bg-hemi-ok' : 'bg-primary')}
                style={{ width: `${progress.percentage}%` }}
              />
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {progress.completed}/{progress.total}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(TaskCard);
