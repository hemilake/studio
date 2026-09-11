import { Loader2, MessageSquare } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '@/shared/utils';
import { OPEN_CHAT_SHORTCUT_LABEL } from '@/modules/chat-workspace/useOpenChat';

type ChatShortcutProps = {
  onOpenChat: () => void;
  isOpening: boolean;
  error: string | null;
  t: TFunction;
};

/** Rendered by SidebarContent right under the header: the one-click entry to the chat workspace. */
export function ChatShortcut({ onOpenChat, isOpening, error, t }: ChatShortcutProps) {
  const title = t('chat.openTooltip', { shortcut: OPEN_CHAT_SHORTCUT_LABEL });
  const Icon = isOpening ? Loader2 : MessageSquare;

  return (
    <div className="flex-shrink-0">
      {/* Desktop */}
      <div className="hidden px-3 py-2 md:block">
        <button
          type="button"
          onClick={onOpenChat}
          disabled={isOpening}
          title={title}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-left transition-colors',
            'hover:border-primary/40 hover:bg-primary/10 disabled:cursor-wait disabled:opacity-70',
          )}
        >
          <Icon className={cn('h-4 w-4 flex-shrink-0 text-primary', isOpening && 'animate-spin')} />
          <span className="flex-1 truncate text-sm font-medium text-foreground">
            {isOpening ? t('chat.opening') : t('chat.open')}
          </span>
          <kbd
            aria-hidden
            className="hidden items-center rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline-flex"
          >
            {OPEN_CHAT_SHORTCUT_LABEL}
          </kbd>
        </button>
        {error && <p className="mt-1 truncate px-1 text-[11px] text-destructive" title={error}>{t('chat.error')}</p>}
      </div>

      {/* Mobile */}
      <div className="px-3 pb-2 md:hidden">
        <button
          type="button"
          onClick={onOpenChat}
          disabled={isOpening}
          className="flex h-11 w-full items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3.5 transition-all active:scale-[0.98] disabled:opacity-70"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
            <Icon className={cn('h-4 w-4 text-primary', isOpening && 'animate-spin')} />
          </div>
          <span className="text-sm font-medium text-foreground">
            {isOpening ? t('chat.opening') : t('chat.open')}
          </span>
        </button>
        {error && <p className="mt-1 truncate px-1 text-xs text-destructive" title={error}>{t('chat.error')}</p>}
      </div>
      <div className="nav-divider" />
    </div>
  );
}

type ChatShortcutRailButtonProps = {
  onOpenChat: () => void;
  isOpening: boolean;
  t: TFunction;
};

/** Rendered by SidebarCollapsed as the icon-rail version of the shortcut. */
export function ChatShortcutRailButton({ onOpenChat, isOpening, t }: ChatShortcutRailButtonProps) {
  const title = t('chat.openTooltip', { shortcut: OPEN_CHAT_SHORTCUT_LABEL });
  const Icon = isOpening ? Loader2 : MessageSquare;

  return (
    <button
      type="button"
      onClick={onOpenChat}
      disabled={isOpening}
      className="group flex h-8 w-8 items-center justify-center rounded-lg bg-primary/5 transition-colors hover:bg-primary/15 disabled:cursor-wait"
      aria-label={title}
      title={title}
    >
      <Icon className={cn('h-4 w-4 text-primary', isOpening && 'animate-spin')} />
    </button>
  );
}
