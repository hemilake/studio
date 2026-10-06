import type { TFunction } from 'i18next';

import type { TaskKanbanColumn, TaskMasterTask } from '@/shared/types';

const KANBAN_COLUMN_CONFIG = [
  {
    id: 'pending',
    titleKey: 'kanban.pending',
    status: 'pending',
    color: 'bg-gray-50 dark:bg-gray-900/50 border-gray-200 dark:border-gray-700',
    headerColor: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  },
  {
    id: 'in-progress',
    titleKey: 'kanban.inProgress',
    status: 'in-progress',
    color: 'bg-muted border-border',
    headerColor: 'bg-muted text-foreground',
  },
  {
    id: 'done',
    titleKey: 'kanban.done',
    status: 'done',
    color: 'bg-hemi-ok-tint border-hemi-ok/40',
    headerColor: 'bg-hemi-ok-tint text-hemi-ok',
  },
  {
    id: 'blocked',
    titleKey: 'kanban.blocked',
    status: 'blocked',
    color: 'bg-destructive/10 border-destructive/40',
    headerColor: 'bg-destructive/10 text-destructive',
  },
  {
    id: 'deferred',
    titleKey: 'kanban.deferred',
    status: 'deferred',
    color: 'bg-hemi-copper-tint border-hemi-copper/40',
    headerColor: 'bg-hemi-copper-tint text-hemi-copper-text',
  },
  {
    id: 'cancelled',
    titleKey: 'kanban.cancelled',
    status: 'cancelled',
    color: 'bg-gray-50 dark:bg-gray-900/50 border-gray-200 dark:border-gray-700',
    headerColor: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  },
] as const;

const CORE_WORKFLOW_STATUSES = new Set(['pending', 'in-progress', 'done']);

export function buildKanbanColumns(tasks: TaskMasterTask[], t: TFunction<'tasks'>): TaskKanbanColumn[] {
  const tasksByStatus = tasks.reduce<Record<string, TaskMasterTask[]>>((accumulator, task) => {
    const status = task.status ?? 'pending';
    if (!accumulator[status]) {
      accumulator[status] = [];
    }
    accumulator[status].push(task);
    return accumulator;
  }, {});

  return KANBAN_COLUMN_CONFIG.filter((column) => {
    const hasTasks = (tasksByStatus[column.status] ?? []).length > 0;
    return hasTasks || CORE_WORKFLOW_STATUSES.has(column.status);
  }).map((column) => ({
    id: column.id,
    title: t(column.titleKey),
    status: column.status,
    color: column.color,
    headerColor: column.headerColor,
    tasks: tasksByStatus[column.status] ?? [],
  }));
}
