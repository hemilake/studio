import { memo, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Bot,
  ClipboardList,
  Hand,
  ShieldQuestion,
  Smile,
  type LucideIcon,
} from 'lucide-react';

import type { PermissionMode } from '@/shared/types';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';

type ModeAppearance = {
  icon: LucideIcon;
  trigger: string;
  item: string;
};

/**
 * Presentation only. Which modes exist for a provider comes from the backend
 * capability matrix, so an unknown mode still renders through UNKNOWN_MODE.
 */
const MODE_APPEARANCE: Record<PermissionMode, ModeAppearance> = {
  default: {
    icon: Hand,
    trigger: 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted',
    item: 'text-foreground',
  },
  auto: {
    icon: Bot,
    trigger:
      'border-border bg-muted text-hemi-copper-text',
    item: 'text-hemi-copper-text',
  },
  acceptEdits: {
    icon: Smile,
    trigger:
      'border-hemi-ok/40 bg-hemi-ok-tint text-hemi-ok',
    item: 'text-hemi-ok',
  },
  bypassPermissions: {
    icon: AlertTriangle,
    trigger:
      'border-hemi-copper/40 bg-hemi-copper-tint text-hemi-copper-text',
    item: 'text-hemi-copper-text',
  },
  plan: {
    icon: ClipboardList,
    trigger: 'border-primary/20 bg-primary/5 text-primary hover:bg-primary/10',
    item: 'text-primary',
  },
};

const UNKNOWN_MODE: ModeAppearance = {
  icon: ShieldQuestion,
  trigger: 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted',
  item: 'text-foreground',
};

const getAppearance = (mode: PermissionMode | string): ModeAppearance =>
  MODE_APPEARANCE[mode as PermissionMode] ?? UNKNOWN_MODE;

type ComposerPermissionMenuProps = {
  permissionMode: PermissionMode;
  /** Modes the active provider supports, in the order the backend reports them. */
  permissionModes: PermissionMode[];
  onSelectPermissionMode: (mode: PermissionMode) => void;
  providerLabel: string;
};

/**
 * Rendered by chat's ChatComposer as the popover for choosing the permission
 * mode the active provider runs the next turn under.
 */
function ComposerPermissionMenu({
  permissionMode,
  permissionModes,
  onSelectPermissionMode,
  providerLabel,
}: ComposerPermissionMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 22 * 16);

  if (permissionModes.length === 0) {
    return null;
  }

  const activeAppearance = getAppearance(permissionMode);
  const ActiveIcon = activeAppearance.icon;
  const heading = t('composer.permissionHeading', {
    provider: providerLabel,
    defaultValue: 'How should {{provider}} actions be approved?',
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors ${activeAppearance.trigger}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={heading}
        title={t('input.clickToChangeMode')}
      >
        <ActiveIcon className="h-4 w-4" />
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={heading}>
          <ComposerMenuHeading>{heading}</ComposerMenuHeading>
          {permissionModes.map((mode) => {
            const appearance = getAppearance(mode);
            const ModeIcon = appearance.icon;
            return (
              <ComposerMenuItem
                key={mode}
                icon={<ModeIcon className="h-4 w-4" />}
                label={t(`codex.modes.${mode}`, { defaultValue: mode })}
                description={t(`codex.descriptions.${mode}`, { defaultValue: '' }) || undefined}
                isSelected={mode === permissionMode}
                onSelect={() => {
                  onSelectPermissionMode(mode);
                  setIsOpen(false);
                }}
                className={appearance.item}
              />
            );
          })}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of this menu's props change while typing. */
export default memo(ComposerPermissionMenu);
