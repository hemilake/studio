import { ExternalLink, FileText, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type TaskHelpModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onCreatePrd: () => void;
};

type HelpStep = {
  index: number;
  title: string;
  description: string;
  accent: string;
};

/** Rendered by TaskBoard to walk through the PRD-to-tasks workflow. */
export default function TaskHelpModal({ isOpen, onClose, onCreatePrd }: TaskHelpModalProps) {
  const { t } = useTranslation('tasks');

  if (!isOpen) {
    return null;
  }

  const steps: HelpStep[] = [
    {
      index: 1,
      title: t('gettingStarted.steps.createPRD.title'),
      description: t('gettingStarted.steps.createPRD.description'),
      accent: 'border-border bg-muted',
    },
    {
      index: 2,
      title: t('gettingStarted.steps.generateTasks.title'),
      description: t('gettingStarted.steps.generateTasks.description'),
      accent: 'border-hemi-ok/40 bg-hemi-ok-tint',
    },
    {
      index: 3,
      title: t('gettingStarted.steps.analyzeTasks.title'),
      description: t('gettingStarted.steps.analyzeTasks.description'),
      accent: 'border-hemi-copper/40 bg-hemi-copper-tint',
    },
    {
      index: 4,
      title: t('gettingStarted.steps.startBuilding.title'),
      description: t('gettingStarted.steps.startBuilding.description'),
      accent: 'border-border bg-muted',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-200 p-6 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              <FileText className="h-5 w-5 text-hemi-copper-text" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{t('helpGuide.title')}</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400">{t('helpGuide.subtitle')}</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[calc(90vh-120px)] space-y-4 overflow-y-auto p-6">
          {steps.map((step) => (
            <div key={step.index} className={`rounded-lg border p-4 ${step.accent}`}>
              <div className="flex gap-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                  {step.index}
                </div>
                <div>
                  <h4 className="mb-2 font-medium text-gray-900 dark:text-white">{step.title}</h4>
                  <p className="text-sm text-gray-700 dark:text-gray-300">{step.description}</p>

                  {step.index === 1 && (
                    <button
                      onClick={() => {
                        onCreatePrd();
                        onClose();
                      }}
                      className="mt-3 inline-flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5 text-sm text-hemi-copper-text"
                    >
                      <FileText className="h-4 w-4" />
                      {t('buttons.addPRD')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}

          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
            <h4 className="mb-2 font-medium text-gray-900 dark:text-white">{t('helpGuide.proTips.title')}</h4>
            <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
              <li>{t('helpGuide.proTips.search')}</li>
              <li>{t('helpGuide.proTips.views')}</li>
              <li>{t('helpGuide.proTips.filters')}</li>
              <li>{t('helpGuide.proTips.details')}</li>
            </ul>
          </div>

          <div className="rounded-lg border border-border bg-muted p-4">
            <h4 className="mb-2 font-medium text-foreground">{t('helpGuide.learnMore.title')}</h4>
            <p className="mb-3 text-sm text-foreground">{t('helpGuide.learnMore.description')}</p>
            <a
              href="https://github.com/eyaltoledano/claude-task-master"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('helpGuide.learnMore.githubButton')}
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
