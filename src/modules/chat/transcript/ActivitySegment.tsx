import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import type { DiffLine, Project } from '@/shared/types';
import { cn } from '@/shared/utils';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';
import { DiffStatsBadge } from '@/modules/chat/tools/DiffStatsBadge';
import { getToolConfig } from '@/modules/chat/tools/configs/toolConfigs';
import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';
import { resultText, type StepIconKind } from '@/modules/chat/utils/activityNaming';
import { summarizeDiff } from '@/modules/chat/utils/messageTransforms';
import type { ActivityCall, ActivitySegment as ActivitySegmentModel, ActivityStep, LiveState } from '@/modules/chat/utils/turnSegments';
import { ActivityIcon, ActivityIconStack } from '@/modules/chat/transcript/ActivityIcon';
import { formatDuration, useNow } from '@/modules/chat/hooks/useNow';

type Helpers = {
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  selectedProject?: Project | null;
};

/** "1 step", "12 steps". */
function stepsLabel(n: number, t: TFunction): string {
  return `${n} ${n === 1 ? t('activity.step', { defaultValue: 'step' }) : t('activity.stepPlural', { defaultValue: 'steps' })}`;
}

const PREVIEW_LINES = 40;

function preview(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.length > PREVIEW_LINES
    ? `${lines.slice(0, PREVIEW_LINES).join('\n')}\n… ${lines.length - PREVIEW_LINES} more lines`
    : lines.join('\n');
}

function fullInput(call: ActivityCall): string {
  const { input } = call;
  if (typeof input === 'string') return input;
  const record = (input ?? {}) as Record<string, unknown>;
  if (typeof record.command === 'string') {
    return record.description ? `# ${String(record.description)}\n${record.command}` : record.command;
  }
  // One `key: value` line per argument: what was asked, readable.
  const text = Object.entries(record)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

/** Tools whose own renderer says more than a text preview: diffs and checklists. */
function hasRichRenderer(toolName: string): boolean {
  const config = getToolConfig(toolName).input;
  return config.contentType === 'diff' || config.contentType === 'todo-list';
}

function diffStatsOf(step: ActivityStep, createDiff: Helpers['createDiff']) {
  const config = getToolConfig(step.description.toolName).input;
  if (config.contentType !== 'diff' || !config.getContentProps) return null;
  let added = 0;
  let removed = 0;
  let counted = 0;
  for (const call of step.calls) {
    const props = config.getContentProps((call.input ?? {}) as object);
    if (typeof props?.oldContent !== 'string' || typeof props?.newContent !== 'string') continue;
    const stats = summarizeDiff(createDiff(props.oldContent, props.newContent));
    added += stats.added;
    removed += stats.removed;
    counted += 1;
  }
  return counted > 0 ? { added, removed } : null;
}

function CallDetail({ call, helpers, showViaHemilake }: { call: ActivityCall; helpers: Helpers; showViaHemilake: boolean }) {
  const { t } = useTranslation('chat');
  const { description, message } = call;
  const text = resultText(message.toolResult);

  if (hasRichRenderer(description.toolName) && message.toolInput) {
    return (
      <ToolRenderer
        toolName={description.toolName}
        toolInput={message.toolInput}
        toolResult={message.toolResult}
        toolId={message.toolId}
        mode="input"
        onFileOpen={helpers.onFileOpen}
        createDiff={helpers.createDiff}
        selectedProject={helpers.selectedProject}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-normal text-muted-foreground">{fullInput(call)}</pre>
      {showViaHemilake && description.viaHemilake && (
        <span className="text-[11px] text-muted-foreground">{t('activity.viaHemilake', { defaultValue: 'via Hemilake' })}</span>
      )}
      {description.facts.length > 0 ? (
        description.facts.map((fact, index) => (
          <div key={index} className="grid grid-cols-[10px_minmax(0,1fr)] gap-2 border-t border-border/60 pt-1.5 text-[13px] leading-[1.45]">
            <span className="mt-1.5 h-[7px] w-[7px] rounded-full bg-hemi-copper" aria-hidden />
            <span className="text-foreground">
              {fact.text}
              {fact.meta && <span className="block font-mono text-[11px] text-muted-foreground">{fact.meta}</span>}
            </span>
          </div>
        ))
      ) : text.trim() ? (
        <pre
          className={cn(
            'max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 pt-1.5 font-mono text-[11.5px] leading-normal',
            call.status === 'error' ? 'text-destructive' : 'text-foreground/80',
          )}
        >
          {preview(text)}
        </pre>
      ) : null}
      {description.toolName === 'Read' && typeof (call.input as Record<string, unknown>)?.file_path === 'string' && helpers.onFileOpen && (
        <button
          type="button"
          className="self-start text-[11.5px] text-hemi-copper-text underline-offset-2 hover:underline"
          onClick={() => helpers.onFileOpen?.(String((call.input as Record<string, unknown>).file_path))}
        >
          {t('activity.openFile', { defaultValue: 'Open file' })}
        </button>
      )}
    </div>
  );
}

const StepRow = memo(function StepRow({ step, helpers, forceOpen }: { step: ActivityStep; helpers: Helpers; forceOpen: boolean }) {
  const [open, setOpen] = useState(false);
  const isOpen = open || forceOpen;
  const { description } = step;
  const diffStats = diffStatsOf(step, helpers.createDiff);
  const count = step.calls.length;
  const firstCall = step.calls[0];

  return (
    <div className="hemi-activity-rise flex flex-col" data-message-timestamp={firstCall.message.timestamp ? String(firstCall.message.timestamp) : undefined}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={isOpen}
        className={cn(
          'grid w-full grid-cols-[18px_minmax(0,auto)_minmax(0,1fr)_auto_auto] items-center gap-2.5 rounded-md px-1.5 py-[5px] text-left transition-colors hover:bg-muted/70',
          isOpen && 'bg-muted/70',
        )}
      >
        <span className="inline-flex items-center justify-center">
          <ActivityIcon kind={description.icon} className={description.icon === 'bash' ? 'text-[12px]' : undefined} />
        </span>
        <span className="whitespace-nowrap text-[13.5px] font-medium text-foreground">
          {description.verb}
          {count > 1 && <span className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground">×{count}</span>}
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">{description.arg}</span>
        <span
          className={cn(
            'whitespace-nowrap text-[11.5px]',
            description.resultTone === 'bad' ? 'text-destructive' : description.resultTone === 'ok' ? 'text-hemi-ok' : 'text-muted-foreground',
          )}
        >
          {diffStats ? <DiffStatsBadge stats={diffStats} /> : step.status === 'interrupted' ? 'no result' : description.result}
        </span>
        <span className="w-[42px] whitespace-nowrap text-right font-mono text-[11px] text-muted-foreground/70">{formatDuration(step.durationMs)}</span>
      </button>
      {step.status === 'error' && description.errorLine && !isOpen && (
        <span className="ml-[34px] truncate pb-1 font-mono text-[11.5px] text-destructive">{description.errorLine}</span>
      )}
      {isOpen && (
        <div className="hemi-activity-rise mb-2 ml-[34px] mt-0.5 flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
          {step.calls.map((call, index) => (
            <div key={String(call.message.toolId ?? index)} className={cn(index > 0 && 'border-t border-border pt-2')}>
              <CallDetail call={call} helpers={helpers} showViaHemilake={index === 0} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

/** The line of what runs now: a spinner (or the lake's ping), the verb under a light sweep, the elapsed time. */
export function LiveLine({ live, statusText }: { live: LiveState; statusText?: string | null }) {
  const { t } = useTranslation('chat');
  const now = useNow(true);
  const call = live.call;
  const kind: StepIconKind | null = call ? call.description.icon : null;
  const verb = call
    ? call.description.verb
    : live.writing
      ? t('activity.writing', { defaultValue: 'Writing' })
      : (statusText || t('activity.thinking', { defaultValue: 'Thinking' })).replace(/[.…]+$/, '');
  const elapsed = live.since !== null ? Math.max(0, Math.floor((now - live.since) / 1000)) : null;
  const arg = call ? call.description.arg : '';

  return (
    <div
      className="hemi-activity-rise grid grid-cols-[18px_minmax(0,auto)_minmax(0,1fr)_auto] items-center gap-2.5 px-1.5 py-[5px]"
      data-activity-live=""
      role="status"
      aria-live="polite"
    >
      <span className="relative inline-flex h-4 w-4 items-center justify-center">
        {kind === 'lake' ? (
          <>
            <span className="hemi-activity-ping absolute inset-0 rounded-full bg-hemi-copper" aria-hidden />
            <ActivityIcon kind="lake" className="relative" />
          </>
        ) : (
          <span className="hemi-activity-spin h-3 w-3 rounded-full border-[1.5px] border-hemi-copper/30 border-t-hemi-copper" aria-hidden />
        )}
      </span>
      <span className="hemi-activity-sweep whitespace-nowrap text-[13.5px] font-medium">{verb}</span>
      <span className="truncate font-mono text-xs text-muted-foreground">
        {arg}
        {live.alsoRunning > 0 && <span className="ml-1.5 text-muted-foreground/70">+{live.alsoRunning}</span>}
      </span>
      <span className="whitespace-nowrap font-mono text-[11px] text-hemi-copper-text">{elapsed !== null ? `${elapsed}s` : ''}</span>
    </div>
  );
}

type ActivitySegmentProps = Helpers & {
  segment: ActivitySegmentModel;
  /** As the user left it; unset, a segment with a failed step opens itself. */
  open?: boolean;
  onToggle: (id: string, open: boolean) => void;
  /** The live line, when this segment is the one the running turn adds to. */
  live?: LiveState | null;
  liveStatusText?: string | null;
};

/**
 * Fork (Hemilake Studio activity): one stretch of tool calls between two
 * sentences, folded into a line that says what Claude did, in words. Opened,
 * one row per step; a row opens to its full input and what came back.
 */
function ActivitySegment({ segment, open, onToggle, live, liveStatusText, createDiff, onFileOpen, selectedProject }: ActivitySegmentProps) {
  const { t } = useTranslation('chat');
  const isExporting = useIsExportingTranscript();
  const isOpen = (open ?? segment.hasError) || isExporting;
  const helpers: Helpers = { createDiff, onFileOpen, selectedProject };
  const running = Boolean(live) || segment.running.length > 0;
  const n = segment.stepCount;
  const summary = segment.isTrailing
    ? `${n} ${t('activity.doneSoFar', { defaultValue: 'done so far' })}`
    : segment.summary;
  const meta = [
    stepsLabel(n, t),
    !segment.isTrailing && segment.startedAt !== null && segment.endedAt !== null
      ? formatDuration(segment.endedAt - segment.startedAt)
      : '',
  ].filter(Boolean).join(' · ');

  return (
    <div
      className={cn(
        'chat-message activity hemi-activity-rise ml-0.5 flex flex-col border-l-2 pl-3 sm:ml-0.5',
        running ? 'border-hemi-copper/40' : isOpen ? 'border-border' : 'border-border/70',
      )}
      data-message-timestamp={segment.timestamp ? String(segment.timestamp) : undefined}
      data-activity-segment={segment.id}
    >
      {n > 0 && (
        <button
          type="button"
          onClick={() => onToggle(segment.id, !isOpen)}
          aria-expanded={isOpen}
          className="flex w-full items-center gap-2.5 py-1 text-left text-foreground/80 transition-colors hover:text-foreground"
        >
          <ActivityIconStack kinds={segment.steps.map((step) => step.description.icon)} />
          <span className="min-w-0 flex-1 truncate text-[13.5px]">{summary}</span>
          <span className="whitespace-nowrap font-mono text-[11.5px] text-muted-foreground/70">{meta}</span>
          <span className="w-3 text-[11px] text-muted-foreground/70" aria-hidden>{isOpen ? '▾' : '▸'}</span>
        </button>
      )}
      {isOpen && n > 0 && (
        <div className="flex flex-col py-1">
          {segment.steps.map((step) => (
            <StepRow key={step.id} step={step} helpers={helpers} forceOpen={isExporting} />
          ))}
        </div>
      )}
      {!isOpen && segment.steps.filter((step) => step.status === 'error').map((step) => (
        <span key={step.id} className="ml-[34px] truncate pb-1 font-mono text-[11.5px] text-destructive">{step.description.errorLine}</span>
      ))}
      {live && <LiveLine live={live} statusText={liveStatusText} />}
    </div>
  );
}

/** One line under a finished turn: how many steps and how long it took. */
export function TurnFooter({ steps, durationMs }: { steps: number; durationMs: number | null }) {
  const { t } = useTranslation('chat');
  const parts = [
    stepsLabel(steps, t),
    formatDuration(durationMs),
  ].filter(Boolean);
  return (
    <div className="chat-turn-footer px-3 font-mono text-[11.5px] text-muted-foreground/70 sm:px-0">{parts.join(' · ')}</div>
  );
}

export default memo(ActivitySegment);
