/**
 * Fork (Hemilake Studio activity): splits the transcript into what the chat draws.
 *
 * An assistant turn is an ordered list of segments: text blocks, and activity
 * segments, each the maximal run of tool calls between two pieces of prose.
 * An activity segment renders as one folded line; each call inside it is one
 * row, call and result together (the result is already merged into its
 * tool_use by id, see useChatMessages). Identical consecutive calls fold into
 * one row with ×N. While a turn runs, what runs now is the live line: exactly
 * one, at the end of the transcript.
 *
 * Presentation only: the stored messages are untouched.
 */
import type { ChatMessage } from '@/shared/types';
import { describeStep, summarizeSteps, type StepDescription } from '@/modules/chat/utils/activityNaming';
import { parseToolPayload } from '@/modules/chat/utils/messageTransforms';

/**
 * Tools that keep their own card instead of folding into a line: the question
 * the user answers, the plan they approve, and spawned agents (which arrive as
 * subagent containers).
 */
const STANDALONE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode', 'Task', 'Agent']);

export type CallStatus = 'done' | 'error' | 'running' | 'interrupted';

export type ActivityCall = {
  message: ChatMessage;
  input: unknown;
  description: StepDescription;
  status: CallStatus;
  startedAt: number | null;
  endedAt: number | null;
};

/** One row: a call, or identical consecutive calls folded with ×N. */
export type ActivityStep = {
  id: string;
  calls: ActivityCall[];
  /** The first call's naming, with the last call's result. */
  description: StepDescription;
  status: CallStatus;
  durationMs: number | null;
};

export type ActivitySegment = {
  kind: 'activity';
  id: string;
  /** Every tool message of the segment, in order (finished and running). */
  messages: ChatMessage[];
  /** Finished rows; calls still running are the live line, not rows. */
  steps: ActivityStep[];
  /** Calls without a result while the turn runs, oldest first. */
  running: ActivityCall[];
  stepCount: number;
  summary: string;
  hasError: boolean;
  /** The segment the running turn is still adding to: its summary waits. */
  isTrailing: boolean;
  startedAt: number | null;
  endedAt: number | null;
  timestamp: ChatMessage['timestamp'];
};

export type MessageItem = { kind: 'message'; message: ChatMessage };

export type TurnFooterItem = {
  kind: 'turn-footer';
  id: string;
  steps: number;
  durationMs: number | null;
  timestamp: ChatMessage['timestamp'];
};

export type TranscriptItem = MessageItem | ActivitySegment | TurnFooterItem;

/** What runs now. Null once the turn is over. */
export type LiveState = {
  /** The newest call still running, if a tool runs. */
  call: ActivityCall | null;
  /** Other calls running alongside it (parallel tool calls). */
  alsoRunning: number;
  /** The trailing segment the live line belongs to, if the turn ends in one. */
  segmentId: string | null;
  /** True while the last thing on screen is prose still streaming. */
  writing: boolean;
  /** Since when the live line has been what it is, for its elapsed time. */
  since: number | null;
};

export type TranscriptModel = {
  items: TranscriptItem[];
  live: LiveState | null;
};

export function toMillis(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const time = value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
  return Number.isFinite(time) ? time : null;
}

export function isFoldableTool(message: ChatMessage): boolean {
  return Boolean(
    message.isToolUse
      && message.toolName
      && !message.isSubagentContainer
      && !STANDALONE_TOOLS.has(String(message.toolName)),
  );
}

function rendersNothing(message: ChatMessage, showThinking: boolean): boolean {
  return Boolean(message.isThinking && !showThinking);
}

function toCall(message: ChatMessage, turnIsLive: boolean): ActivityCall {
  const input = parseToolPayload(message.toolInput);
  const result = message.toolResult ?? null;
  const description = describeStep(String(message.toolName), input, result);
  const status: CallStatus = result
    ? result.isError ? 'error' : 'done'
    : message.toolStatus === 'failed'
      ? 'error'
      : turnIsLive ? 'running' : 'interrupted';
  return {
    message,
    input,
    description,
    status,
    startedAt: toMillis(message.timestamp),
    endedAt: toMillis(result?.timestamp),
  };
}

function durationOf(call: ActivityCall): number | null {
  return call.startedAt !== null && call.endedAt !== null ? Math.max(0, call.endedAt - call.startedAt) : null;
}

/** Folds finished calls into rows, identical consecutive ones into one row. */
export function collapseCalls(calls: ActivityCall[]): ActivityStep[] {
  const steps: ActivityStep[] = [];
  for (const call of calls) {
    const previous = steps[steps.length - 1];
    if (
      previous
      && call.status !== 'error'
      && previous.status !== 'error'
      && previous.description.collapseKey === call.description.collapseKey
    ) {
      previous.calls.push(call);
      previous.description = { ...previous.description, result: call.description.result, resultTone: call.description.resultTone };
      const duration = durationOf(call);
      previous.durationMs = previous.durationMs !== null && duration !== null ? previous.durationMs + duration : null;
      if (call.status === 'interrupted') previous.status = 'interrupted';
      continue;
    }
    steps.push({
      id: String(call.message.toolId ?? call.message.timestamp),
      calls: [call],
      description: call.description,
      status: call.status,
      durationMs: durationOf(call),
    });
  }
  return steps;
}

function buildSegment(messages: ChatMessage[], turnIsLive: boolean): ActivitySegment {
  const calls = messages.map((message) => toCall(message, turnIsLive));
  const finished = calls.filter((call) => call.status !== 'running');
  const running = calls.filter((call) => call.status === 'running');
  const starts = calls.map((call) => call.startedAt).filter((time): time is number => time !== null);
  const ends = finished.map((call) => call.endedAt ?? call.startedAt).filter((time): time is number => time !== null);
  const first = messages[0];
  return {
    kind: 'activity',
    id: `activity-${first.toolId ?? String(first.timestamp)}`,
    messages,
    steps: collapseCalls(finished),
    running,
    stepCount: finished.length,
    summary: summarizeSteps(finished),
    hasError: finished.some((call) => call.status === 'error'),
    isTrailing: false,
    startedAt: starts.length ? Math.min(...starts) : null,
    endedAt: ends.length ? Math.max(...ends) : null,
    timestamp: first.timestamp,
  };
}

/** The latest moment a message is known to have produced something. */
function lastActivityOf(message: ChatMessage): number | null {
  return toMillis(message.toolResult?.timestamp) ?? toMillis(message.timestamp);
}

type TurnStats = { start: number | null; end: number | null; steps: number; lastTimestamp: ChatMessage['timestamp'] | null };

/**
 * Builds the transcript the chat draws from the visible messages.
 *
 * `isProcessing` says the last turn is still running: its calls without a
 * result are live (otherwise they were interrupted), its trailing segment
 * waits for its summary, and the live line is computed.
 */
export function buildTranscript(
  messages: ChatMessage[],
  { showThinking = true, isProcessing = false }: { showThinking?: boolean; isProcessing?: boolean } = {},
): TranscriptModel {
  const items: TranscriptItem[] = [];
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type === 'user') {
      lastUserIndex = index;
      break;
    }
  }

  let turn: TurnStats = { start: null, end: null, steps: 0, lastTimestamp: null };
  const closeTurn = () => {
    if (turn.steps > 0 && turn.lastTimestamp !== null) {
      items.push({
        kind: 'turn-footer',
        id: `turn-footer-${String(turn.lastTimestamp)}-${items.length}`,
        steps: turn.steps,
        durationMs: turn.start !== null && turn.end !== null ? Math.max(0, turn.end - turn.start) : null,
        timestamp: turn.lastTimestamp,
      });
    }
    turn = { start: null, end: null, steps: 0, lastTimestamp: null };
  };
  const touch = (message: ChatMessage) => {
    const time = lastActivityOf(message);
    if (time !== null) {
      turn.start = turn.start ?? toMillis(message.timestamp);
      turn.end = Math.max(turn.end ?? time, time);
    }
    turn.lastTimestamp = message.timestamp;
  };

  let index = 0;
  while (index < messages.length) {
    const message = messages[index];

    if (rendersNothing(message, showThinking)) {
      index += 1;
      continue;
    }

    if (message.type === 'user') {
      closeTurn();
      items.push({ kind: 'message', message });
      turn.start = toMillis(message.timestamp);
      index += 1;
      continue;
    }

    const turnIsLive = isProcessing && index > lastUserIndex;

    if (!isFoldableTool(message)) {
      items.push({ kind: 'message', message });
      if (message.isToolUse) turn.steps += 1;
      touch(message);
      index += 1;
      continue;
    }

    const run: ChatMessage[] = [];
    while (index < messages.length) {
      const candidate = messages[index];
      if (rendersNothing(candidate, showThinking)) {
        index += 1;
        continue;
      }
      if (!isFoldableTool(candidate)) break;
      run.push(candidate);
      touch(candidate);
      index += 1;
    }
    const segment = buildSegment(run, turnIsLive);
    turn.steps += run.length;
    items.push(segment);
  }

  if (!isProcessing) {
    closeTurn();
    return { items, live: null };
  }

  // The running turn: its last segment is still being written, and exactly one
  // live line says what happens now.
  const last = items[items.length - 1];
  const trailing = last && last.kind === 'activity' && messages.indexOf(last.messages[0]) > lastUserIndex ? last : null;
  if (trailing) trailing.isTrailing = true;

  const runningCalls = trailing?.running ?? [];
  const newest = runningCalls[runningCalls.length - 1] ?? null;
  const lastMessage = last?.kind === 'message' ? last.message : null;
  const lastTime = last?.kind === 'activity'
    ? last.endedAt ?? last.startedAt
    : lastMessage ? lastActivityOf(lastMessage) : null;

  return {
    items,
    live: {
      call: newest,
      alsoRunning: Math.max(0, runningCalls.length - 1),
      segmentId: trailing?.id ?? null,
      writing: Boolean(lastMessage && lastMessage.type === 'assistant' && lastMessage.isStreaming && !lastMessage.isToolUse),
      since: newest?.startedAt ?? lastTime,
    },
  };
}
