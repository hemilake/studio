import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle,
  Circle,
  Eye,
  Flag,
  List,
  Play,
  Settings,
  Target,
  Terminal,
  Zap,
} from 'lucide-react';

import { cn } from '@/shared/utils';
import { useTaskMaster } from '@/modules/task-master/context/TaskMasterContext';
import TaskDetailModal from '@/modules/task-master/modals/TaskDetailModal';
import TaskMasterSetupModal from '@/modules/task-master/modals/TaskMasterSetupModal';

type NextTaskBannerProps = {
  onShowAllTasks?: (() => void) | null;
  onStartTask?: (() => void) | null;
  className?: string;
};

function PriorityIndicator({ priority }: { priority?: string }) {
  const { t } = useTranslation();
  if (priority === 'high') {
    return (
      <div className="flex h-4 w-4 items-center justify-center rounded bg-destructive/10" title={t('tasks:priorities.highTitle')}>
        <Zap className="h-2.5 w-2.5 text-destructive" />
      </div>
    );
  }

  if (priority === 'medium') {
    return (
      <div className="flex h-4 w-4 items-center justify-center rounded bg-hemi-copper-tint" title={t('tasks:priorities.mediumTitle')}>
        <Flag className="h-2.5 w-2.5 text-hemi-copper-text" />
      </div>
    );
  }

  return (
    <div className="flex h-4 w-4 items-center justify-center rounded bg-gray-100 dark:bg-gray-800" title={t('tasks:priorities.lowTitle')}>
      <Circle className="h-2.5 w-2.5 text-gray-400 dark:text-gray-500" />
    </div>
  );
}

/** Exported through the task-master barrel; the chat module's empty state renders it to surface the next task and prefill a prompt that starts it. */
export default function NextTaskBanner({ onShowAllTasks = null, onStartTask = null, className = '' }: NextTaskBannerProps) {
  const { t } = useTranslation();
  const {
    nextTask,
    tasks,
    currentProject,
    isLoadingTasks,
    projectTaskMaster,
    refreshTasks,
    setCurrentProject,
  } = useTaskMaster();

  const [showTaskDetail, setShowTaskDetail] = useState(false);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [showSetupDetails, setShowSetupDetails] = useState(false);

  if (!currentProject || isLoadingTasks) {
    return null;
  }

  const hasTasks = Array.isArray(tasks) && tasks.length > 0;
  const hasTaskMaster = Boolean(projectTaskMaster?.hasTaskmaster || currentProject.taskmaster?.hasTaskmaster);

  const handleSetupRefresh = () => {
    // setCurrentProject re-reads the project's TaskMaster details itself, so
    // the refreshProjects() that used to precede it was the same request twice.
    setCurrentProject(currentProject);
    void refreshTasks();
  };

  if (!hasTasks && !hasTaskMaster) {
    return (
      <>
        <div className={cn('bg-muted border border-border rounded-lg p-3 mb-4', className)}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <List className="h-4 w-4 text-hemi-copper-text" />
              <p className="text-sm font-medium text-gray-900 dark:text-white">{t('tasks:notConfigured.title')}</p>
            </div>

            <button
              onClick={() => setShowSetupModal(true)}
              className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Terminal className="h-3 w-3" />
              {t('tasks:banner.initialize')}
            </button>
          </div>

          <button
            onClick={() => setShowSetupDetails((current) => !current)}
            className="mt-2 flex items-center gap-1 text-xs text-hemi-copper-text hover:underline"
          >
            <Settings className="h-3 w-3" />
            {showSetupDetails ? t('tasks:banner.hideDetails') : t('tasks:banner.whatIsTaskmaster')}
          </button>

          {showSetupDetails && (
            <div className="mt-3 space-y-1 text-xs text-foreground">
              <p>{t('tasks:banner.detailAiPowered')}</p>
              <p>{t('tasks:banner.detailPrdDriven')}</p>
              <p>{t('tasks:banner.detailKanbanList')}</p>
            </div>
          )}
        </div>

        <TaskMasterSetupModal
          isOpen={showSetupModal}
          project={currentProject}
          onClose={() => setShowSetupModal(false)}
          onAfterClose={handleSetupRefresh}
        />
      </>
    );
  }

  if (nextTask) {
    return (
      <>
        <div className={cn('bg-gray-50 dark:bg-gray-900/30 border border-gray-200 dark:border-gray-700 rounded-lg p-3 mb-4', className)}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-muted">
                  <Target className="h-3 w-3 text-hemi-copper-text" />
                </div>
                <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Task {nextTask.id}</span>
                <PriorityIndicator priority={nextTask.priority} />
              </div>
              <p className="line-clamp-1 text-sm font-medium text-gray-900 dark:text-gray-100">{nextTask.title}</p>
            </div>

            <div className="flex flex-shrink-0 items-center gap-1">
              <button
                onClick={() => onStartTask?.()}
                className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Play className="h-3 w-3" />
                {t('tasks:banner.startTask')}
              </button>

              <button
                onClick={() => setShowTaskDetail(true)}
                className="rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                title={t('tasks:banner.viewTaskDetails')}
              >
                <Eye className="h-3 w-3" />
              </button>

              {onShowAllTasks && (
                <button
                  onClick={onShowAllTasks}
                  className="rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  title={t('tasks:banner.viewAllTasks')}
                >
                  <List className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        </div>

        <TaskDetailModal
          task={nextTask}
          isOpen={showTaskDetail}
          onClose={() => setShowTaskDetail(false)}
          onStatusChange={() => {
            void refreshTasks();
          }}
        />
      </>
    );
  }

  if (hasTasks) {
    const completedTasks = tasks.filter((task) => task.status === 'done').length;

    return (
      <div className={cn('bg-muted border border-border rounded-lg p-3 mb-4', className)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-hemi-copper-text" />
            <span className="text-sm font-medium text-gray-900 dark:text-white">
              {completedTasks === tasks.length ? t('tasks:banner.allComplete') : t('tasks:banner.noPending')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-600 dark:text-gray-400">
              {completedTasks}/{tasks.length}
            </span>
            {onShowAllTasks && (
              <button
                onClick={onShowAllTasks}
                className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Review
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
