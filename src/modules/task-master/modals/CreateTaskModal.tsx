import { Sparkles, X } from 'lucide-react';

type CreateTaskModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

/** Rendered by TaskBoard to explain how tasks are created through chat and the TaskMaster CLI. */
export default function CreateTaskModal({ isOpen, onClose }: CreateTaskModalProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 p-6 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
              <Sparkles className="h-4 w-4 text-hemi-copper-text" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Create AI-Generated Task</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-6 p-6">
          <div className="rounded-lg border border-border bg-muted p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted">
                <Sparkles className="h-4 w-4 text-hemi-copper-text" />
              </div>
              <div>
                <h4 className="mb-2 font-semibold text-foreground">Pro tip: ask Claude Code directly</h4>
                <p className="mb-3 text-sm text-foreground">
                  Ask for a task in chat with context and requirements. TaskMaster can generate implementation-ready tasks.
                </p>
                <div className="rounded border border-border bg-white p-3 dark:bg-gray-800">
                  <p className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">Example:</p>
                  <p className="font-mono text-sm text-gray-900 dark:text-white">
                    Please add a task for profile image uploads and include best-practice research.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-4 text-center dark:border-gray-700">
            <a
              href="https://github.com/eyaltoledano/claude-task-master/blob/main/docs/examples.md"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-sm font-medium text-hemi-copper-text underline"
            >
              View TaskMaster documentation
            </a>
          </div>

          <button
            onClick={onClose}
            className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
