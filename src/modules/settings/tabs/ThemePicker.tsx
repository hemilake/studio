import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '@/shared/context/ThemeContext';
import { cn } from '@/shared/utils';

/**
 * Fork. Rendered by AppearanceSettingsTab: one card per theme in
 * src/shared/theme/registry.tsx. Picking one stores it for this user on every
 * device; the instance default is what users who never picked one get.
 */
export default function ThemePicker() {
  const { t } = useTranslation('settings');
  const { theme, themes, instanceThemeId, userThemeId, setThemeId } = useTheme();

  return (
    <div className="space-y-3 p-4">
      <div role="radiogroup" aria-label={t('appearanceSettings.theme.label')} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {themes.map((option) => {
          const isSelected = option.id === theme.id;
          const { Mark } = option;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => setThemeId(option.id)}
              className={cn(
                'flex flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors',
                isSelected ? 'border-foreground ring-1 ring-foreground' : 'border-border hover:bg-muted/40',
              )}
            >
              <span className="flex h-8 overflow-hidden rounded-md border border-border" aria-hidden>
                {option.swatches.map((color) => (
                  <span key={color} className="flex-1" style={{ backgroundColor: color }} />
                ))}
              </span>
              <span className="flex items-center gap-2">
                <Mark className="h-4 w-4 flex-shrink-0 text-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{option.label}</span>
                {isSelected && <Check className="h-4 w-4 flex-shrink-0 text-foreground" />}
              </span>
              <span className="text-xs text-muted-foreground">
                {option.brandName}
                {option.id === instanceThemeId && ` · ${t('appearanceSettings.theme.instanceDefault')}`}
              </span>
            </button>
          );
        })}
      </div>
      {userThemeId && userThemeId !== instanceThemeId && (
        <button
          type="button"
          onClick={() => setThemeId(null)}
          className="text-xs text-hemi-copper-text hover:underline"
        >
          {t('appearanceSettings.theme.useInstanceDefault')}
        </button>
      )}
    </div>
  );
}
