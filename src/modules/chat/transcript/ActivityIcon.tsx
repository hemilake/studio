import {
  CalendarDays,
  FileText,
  Globe,
  ListChecks,
  Mail,
  MessageCircle,
  MessagesSquare,
  Search,
  Sparkles,
  Wrench,
} from 'lucide-react';

import { cn } from '@/shared/utils';
import { HemilakeMark } from '@/shared/ui/BrandMark';
import type { StepIconKind } from '@/modules/chat/utils/activityNaming';

function SlackGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className={className} aria-hidden>
      <path d="M9 4v16M15 4v16M4 9h16M4 15h16" />
    </svg>
  );
}

/**
 * Fork (Hemilake Studio activity): the icon a tool step wears. Hemilake's own
 * tools wear the lake symbol, channels their own glyph, Bash a copper `$`.
 */
export function ActivityIcon({ kind, className }: { kind: StepIconKind; className?: string }) {
  const glyph = cn('h-3 w-3 text-muted-foreground', className);
  switch (kind) {
    case 'lake':
      return <HemilakeMark className={cn('h-3.5 w-3.5 text-foreground', className)} />;
    case 'bash':
      return <span className={cn('font-mono text-[11px] font-medium leading-none text-hemi-copper', className)} aria-hidden>$</span>;
    case 'slack':
      return <SlackGlyph className={glyph} />;
    case 'mail':
      return <Mail className={glyph} aria-hidden />;
    case 'teams':
      return <MessagesSquare className={glyph} aria-hidden />;
    case 'calendar':
      return <CalendarDays className={glyph} aria-hidden />;
    case 'chat':
      return <MessageCircle className={glyph} aria-hidden />;
    case 'docs':
    case 'file':
      return <FileText className={glyph} aria-hidden />;
    case 'search':
      return <Search className={glyph} aria-hidden />;
    case 'web':
      return <Globe className={glyph} aria-hidden />;
    case 'skill':
      return <Sparkles className={glyph} aria-hidden />;
    case 'plan':
      return <ListChecks className={glyph} aria-hidden />;
    default:
      return <Wrench className={glyph} aria-hidden />;
  }
}

/** The folded line's overlapping 20 px circles: distinct kinds in order of first use. */
export function ActivityIconStack({ kinds }: { kinds: StepIconKind[] }) {
  return (
    <span className="flex flex-shrink-0 items-center pr-[5px]" aria-hidden>
      {[...new Set(kinds)].map((kind) => (
        <span
          key={kind}
          className="hemi-activity-rise -mr-[5px] inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-border bg-card"
        >
          <ActivityIcon kind={kind} />
        </span>
      ))}
    </span>
  );
}
