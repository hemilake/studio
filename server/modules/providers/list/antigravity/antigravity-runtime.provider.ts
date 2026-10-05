import { open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import {
  buildProviderCliEnv,
  createCompleteMessage,
  createNormalizedMessage,
  resolveConfiguredCliExecutable,
} from '@/shared/utils.js';

/*
 * AGY runs in NDJSON mode both ways:
 *   agy --input-format stream-json --output-format stream-json
 * Each stdin line {"event":"user","message":{"role":"user","content":...}}
 * runs one turn. stdout carries `init` (with the conversation id), a
 * `step_update` per model step, tool call and text delta, and one `result` per
 * turn. One process serves a whole chat: later turns are written to its stdin,
 * and it exits when stdin closes after an idle period.
 *
 * The stream carries no reasoning text. AGY writes it to the conversation's
 * transcript_full.jsonl, which the runtime tails while the turn runs.
 */

type AntigravityProcess = ReturnType<typeof crossSpawn>;

type AntigravitySpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdio: ['pipe', 'pipe', 'pipe'];
    env: NodeJS.ProcessEnv;
  },
) => AntigravityProcess;

type AntigravityRuntimeDependencies = {
  spawnProcess: AntigravitySpawn;
  /** How long an idle process is kept for the chat's next turn. */
  idleMs: number;
};

type TurnOutcome = { code: number; error?: string; aborted?: boolean };

/** One AGY process and the turn it is currently running, if any. */
type LiveProcess = {
  child: AntigravityProcess;
  /** Spawn-time options; a turn that needs different ones gets a new process. */
  signature: string;
  conversationId: string | null;
  writer: ProviderRuntimeWriter;
  context: ProviderRuntimeContext;
  sessionSummary: string | null;
  fallbackSessionId: string;
  turn: { settle: (outcome: TurnOutcome) => void } | null;
  aborted: boolean;
  exited: boolean;
  stderr: string;
  idleTimer: NodeJS.Timeout | null;
  /** Read position in transcript_full.jsonl and the partial line after it. */
  transcriptOffset: number;
  transcriptRemainder: string;
};

const NOT_INSTALLED_MESSAGE = 'Antigravity CLI is not installed. Install it from https://antigravity.google/cli/install.sh';
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

/** Reads a trimmed runtime option without accepting blank values. */
function readStringOption(options: AnyRecord, key: string): string | null {
  const value = options[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Maps CloudCLI permission modes to the Antigravity CLI flags consumed by the
 * runtime adapter. Exported for the Providers module runtime tests.
 */
export function resolveAntigravityPermissionArgs(permissionMode: unknown): string[] {
  switch (permissionMode) {
    case 'plan':
      return ['--mode', 'plan'];
    case 'acceptEdits':
      return ['--mode', 'accept-edits'];
    case 'bypassPermissions':
      return ['--dangerously-skip-permissions'];
    default:
      return [];
  }
}

/** Builds the AGY arguments for a chat process. Exported for runtime tests. */
export function buildAntigravityArgs(input: {
  conversationId: string | null;
  model: string | undefined;
  permissionMode: unknown;
}): string[] {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (input.conversationId) {
    args.push('--conversation', input.conversationId);
  }
  if (input.model) {
    args.push('--model', input.model);
  }
  args.push(...resolveAntigravityPermissionArgs(input.permissionMode));
  return args;
}

/** One stdin line for a user turn. */
function encodeUserTurn(command: string): string {
  return `${JSON.stringify({ event: 'user', message: { role: 'user', content: command } })}\n`;
}

/** Context-window usage in the shape the composer's budget indicator reads. */
function buildTokenBudget(usage: AnyRecord) {
  const read = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const cacheReadTokens = read(usage.cache_read_tokens);
  const inputTokens = read(usage.input_tokens) + cacheReadTokens;
  const outputTokens = read(usage.output_tokens) + read(usage.thinking_tokens);
  return {
    used: inputTokens + outputTokens,
    total: parseInt(process.env.ANTIGRAVITY_CONTEXT_WINDOW ?? '', 10) || 1_000_000,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    cacheTokens: cacheReadTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

/** Where AGY keeps a conversation's full transcript (with reasoning). */
function resolveFullTranscriptPath(conversationId: string): string | null {
  if (!/^[\w-]+$/.test(conversationId)) {
    return null;
  }
  const brainDir = process.env.ANTIGRAVITY_BRAIN_DIR
    || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
  return path.join(brainDir, conversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
}

/** Bytes appended to a file since `offset`, or null when it does not exist yet. */
async function readAppended(filePath: string, offset: number): Promise<{ text: string; size: number } | null> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size <= offset) {
      return { text: '', size };
    }
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    return { text: buffer.toString('utf8'), size };
  } finally {
    await handle.close();
  }
}

/** Forwards the reasoning AGY has written to the transcript since the last read. */
async function forwardNewThinking(live: LiveProcess): Promise<void> {
  const transcriptPath = live.conversationId ? resolveFullTranscriptPath(live.conversationId) : null;
  if (!transcriptPath) {
    return;
  }
  const appended = await readAppended(transcriptPath, live.transcriptOffset);
  if (!appended?.text) {
    return;
  }
  live.transcriptOffset = appended.size;
  const lines = `${live.transcriptRemainder}${appended.text}`.split('\n');
  live.transcriptRemainder = lines.pop() ?? '';
  for (const line of lines) {
    let step: AnyRecord;
    try {
      step = JSON.parse(line) as AnyRecord;
    } catch {
      continue;
    }
    const thinking = typeof step.thinking === 'string' ? step.thinking.trim() : '';
    if (step.source !== 'MODEL' || step.type !== 'PLANNER_RESPONSE' || !thinking) {
      continue;
    }
    live.writer.send(createNormalizedMessage({
      id: `${live.conversationId}-${String(step.step_index)}-thinking`,
      sessionId: live.conversationId,
      provider: 'antigravity',
      kind: 'thinking',
      role: 'assistant',
      content: thinking,
    }));
  }
}

/**
 * Starts tailing the transcript. A resumed conversation starts from the
 * current end so earlier turns are not replayed; a new one from the start.
 */
async function startTranscriptTail(live: LiveProcess, resumed: boolean): Promise<void> {
  live.transcriptOffset = 0;
  live.transcriptRemainder = '';
  const transcriptPath = resumed && live.conversationId ? resolveFullTranscriptPath(live.conversationId) : null;
  if (!transcriptPath) {
    return;
  }
  try {
    live.transcriptOffset = (await stat(transcriptPath)).size;
  } catch {
    // Not written yet.
  }
}

/** Runs one chat turn, reusing the chat's AGY process when it can. */
async function runAntigravity(
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
  dependencies: AntigravityRuntimeDependencies,
  liveProcesses: Map<string, LiveProcess>,
): Promise<void> {
  const appSessionId = readStringOption(options, 'sessionId');
  const providerSessionId = context.resolveProviderSessionId(appSessionId);
  const fallbackSessionId = appSessionId ?? providerSessionId ?? `${Date.now()}`;
  const processKey = appSessionId ?? providerSessionId ?? fallbackSessionId;
  const workingDirectory = readStringOption(options, 'cwd')
    ?? readStringOption(options, 'projectPath')
    ?? process.cwd();
  const sessionSummary = readStringOption(options, 'sessionSummary');

  let resolvedModel: string | undefined;
  try {
    resolvedModel = await context.resolveResumeModel(appSessionId ?? undefined, readStringOption(options, 'model'));
  } catch (error) {
    const resolvedError = error instanceof Error ? error : new Error(String(error));
    const sessionId = providerSessionId ?? fallbackSessionId;
    writer.send(createNormalizedMessage({ kind: 'error', content: resolvedError.message, sessionId, provider: 'antigravity' }));
    writer.send(createCompleteMessage({ provider: 'antigravity', sessionId, exitCode: 1 }));
    notifyRunFailed({
      userId: writer.userId ?? null,
      provider: 'antigravity',
      sessionId: fallbackSessionId,
      sessionName: sessionSummary,
      error: resolvedError,
    });
    throw resolvedError;
  }

  const signature = JSON.stringify([workingDirectory, resolvedModel ?? null, options.permissionMode ?? null]);
  let live = liveProcesses.get(processKey);
  if (live && (live.exited || live.turn || live.signature !== signature)) {
    stopProcess(live, liveProcesses, processKey);
    live = undefined;
  }

  if (!live) {
    const conversationId = providerSessionId;
    const child = dependencies.spawnProcess(
      resolveConfiguredCliExecutable(process.env.AGY_CLI_PATH, 'agy'),
      buildAntigravityArgs({ conversationId, model: resolvedModel, permissionMode: options.permissionMode }),
      {
        cwd: workingDirectory,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildProviderCliEnv(),
      },
    );
    live = {
      child,
      signature,
      conversationId,
      writer,
      context,
      sessionSummary,
      fallbackSessionId,
      turn: null,
      aborted: false,
      exited: false,
      stderr: '',
      idleTimer: null,
      transcriptOffset: 0,
      transcriptRemainder: '',
    };
    attachProcess(live, liveProcesses, processKey);
  }

  if (live.idleTimer) {
    clearTimeout(live.idleTimer);
    live.idleTimer = null;
  }
  live.writer = writer;
  live.context = context;
  live.sessionSummary = sessionSummary;
  live.fallbackSessionId = fallbackSessionId;
  if (live.conversationId) {
    writer.setSessionId?.(live.conversationId);
  }

  const current = live;
  const outcome = await new Promise<TurnOutcome>((resolve) => {
    current.turn = { settle: resolve };
    current.child.stdin?.write(encodeUserTurn(command.trim()));
  });

  const outputSessionId = current.conversationId ?? fallbackSessionId;
  if (outcome.aborted) {
    // The websocket abort handler owns the terminal aborted frame.
    notifyRunStopped({
      userId: writer.userId ?? null,
      provider: 'antigravity',
      sessionId: fallbackSessionId,
      sessionName: sessionSummary,
      stopReason: 'aborted',
    });
    return;
  }

  if (outcome.error) {
    writer.send(createNormalizedMessage({ kind: 'error', content: outcome.error, sessionId: outputSessionId, provider: 'antigravity' }));
  }
  writer.send(createCompleteMessage({ provider: 'antigravity', sessionId: outputSessionId, exitCode: outcome.code }));

  if (outcome.code === 0) {
    notifyRunStopped({
      userId: writer.userId ?? null,
      provider: 'antigravity',
      sessionId: fallbackSessionId,
      sessionName: sessionSummary,
      stopReason: 'completed',
    });
    if (!current.exited && liveProcesses.get(processKey) === current) {
      current.idleTimer = setTimeout(() => stopProcess(current, liveProcesses, processKey), dependencies.idleMs);
      current.idleTimer.unref?.();
    }
    return;
  }

  const error = new Error(outcome.error ?? `Antigravity CLI exited with code ${outcome.code}`);
  notifyRunFailed({
    userId: writer.userId ?? null,
    provider: 'antigravity',
    sessionId: fallbackSessionId,
    sessionName: sessionSummary,
    error,
  });
  throw error;
}

/** Wires stdout parsing and exit handling for a freshly spawned process. */
function attachProcess(live: LiveProcess, liveProcesses: Map<string, LiveProcess>, processKey: string): void {
  liveProcesses.set(processKey, live);
  let buffered = '';
  let eventQueue: Promise<void> = Promise.resolve();

  const finishTurn = (outcome: TurnOutcome) => {
    const turn = live.turn;
    live.turn = null;
    turn?.settle(outcome);
  };

  const handleEvent = async (event: AnyRecord) => {
    const sessionId = live.conversationId ?? live.fallbackSessionId;
    switch (event.event) {
      case 'init': {
        const conversationId = typeof event.conversation_id === 'string' ? event.conversation_id : null;
        const resumed = Boolean(live.conversationId);
        if (conversationId && !live.conversationId) {
          live.conversationId = conversationId;
        }
        await startTranscriptTail(live, resumed);
        if (conversationId && !resumed) {
          live.writer.setSessionId?.(conversationId);
          live.writer.send(createNormalizedMessage({
            kind: 'session_created',
            newSessionId: conversationId,
            sessionId: conversationId,
            provider: 'antigravity',
          }));
        }
        return;
      }
      case 'step_update': {
        const step = event.step_update as AnyRecord | undefined;
        // A planner step's reasoning lands in the transcript around the time
        // the step ends; read it before the tool calls it led to.
        if (step?.step_type === 'tool' || (step?.step_type === 'agent_response' && step.state === 'DONE')) {
          await forwardNewThinking(live).catch(() => {});
        }
        for (const message of live.context.normalizeMessage(step, sessionId)) {
          live.writer.send(message);
        }
        if (step?.usage && typeof step.usage === 'object') {
          live.writer.send(createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget: buildTokenBudget(step.usage as AnyRecord),
            sessionId,
            provider: 'antigravity',
          }));
        }
        return;
      }
      case 'result': {
        await forwardNewThinking(live).catch(() => {});
        const result = (event.result ?? {}) as AnyRecord;
        if (result.status === 'SUCCESS') {
          finishTurn({ code: 0 });
        } else {
          const error = typeof result.error === 'string' && result.error.trim()
            ? result.error.trim()
            : `Antigravity turn ended with status ${String(result.status ?? 'unknown')}`;
          finishTurn({ code: 1, error });
        }
        return;
      }
      default:
    }
  };

  live.child.stdout?.on('data', (data: Buffer | string) => {
    buffered += data.toString();
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
      if (!line) {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event && typeof event === 'object') {
        // Events are handled one after another: reading the transcript is async.
        eventQueue = eventQueue.then(() => handleEvent(event as AnyRecord)).catch((error) => {
          console.warn('[Antigravity] Failed to handle a stream event:', error instanceof Error ? error.message : error);
        });
      }
    }
  });

  live.child.stderr?.on('data', (data: Buffer | string) => {
    // Bounded: a long-lived process should not grow this without limit.
    live.stderr = `${live.stderr}${data.toString()}`.slice(-8000);
  });

  const onExit = async (code: number | null, spawnError?: Error) => {
    if (live.exited) {
      return;
    }
    live.exited = true;
    if (live.idleTimer) {
      clearTimeout(live.idleTimer);
      live.idleTimer = null;
    }
    if (liveProcesses.get(processKey) === live) {
      liveProcesses.delete(processKey);
    }
    if (!live.turn) {
      return;
    }
    if (live.aborted) {
      finishTurn({ code: 1, aborted: true });
      return;
    }

    let error: string;
    if (spawnError || code === 127) {
      const installed = await live.context.isProviderInstalled();
      error = installed ? (spawnError?.message ?? `Antigravity CLI exited with code ${code}`) : NOT_INSTALLED_MESSAGE;
    } else {
      const stderr = live.stderr.trim();
      error = code === null
        ? 'Antigravity CLI process was terminated'
        : `Antigravity CLI exited with code ${code}${stderr ? `: ${stderr}` : ''}`;
    }
    finishTurn({ code: code === 0 || code === null ? 1 : code, error });
  };

  live.child.once('close', (code: number | null) => { void eventQueue.then(() => onExit(code)); });
  live.child.once('error', (error: Error) => { void eventQueue.then(() => onExit(null, error)); });
  // A write to a process that died before reading stdin must not crash the server.
  live.child.stdin?.on('error', () => {});
}

/** Closes a process's stdin and, if it is mid-turn, kills it. */
function stopProcess(live: LiveProcess, liveProcesses: Map<string, LiveProcess>, processKey: string): void {
  if (live.idleTimer) {
    clearTimeout(live.idleTimer);
    live.idleTimer = null;
  }
  if (liveProcesses.get(processKey) === live) {
    liveProcesses.delete(processKey);
  }
  if (live.exited) {
    return;
  }
  live.child.stdin?.end();
  if (live.turn) {
    live.child.kill('SIGTERM');
  }
}

/** Terminates the AGY process of an app or provider session id. */
function abortAntigravitySession(sessionId: string, liveProcesses: Map<string, LiveProcess>): boolean {
  const live = liveProcesses.get(sessionId);
  if (!live || !live.turn) {
    return false;
  }

  // AGY has no stdin control to interrupt a turn, so the process goes; the next
  // turn resumes the conversation in a new one.
  live.aborted = true;
  liveProcesses.delete(sessionId);
  live.child.kill('SIGTERM');
  return true;
}

/**
 * Creates an Antigravity runtime adapter with injectable process
 * dependencies. The provider registry uses the defaults; Providers module
 * tests inject deterministic in-memory subprocesses.
 */
export function createAntigravityRuntime(
  overrides: Partial<AntigravityRuntimeDependencies> = {},
): IProviderRuntime {
  const dependencies: AntigravityRuntimeDependencies = {
    spawnProcess: crossSpawn as AntigravitySpawn,
    idleMs: parseInt(process.env.ANTIGRAVITY_IDLE_MS ?? '', 10) || DEFAULT_IDLE_MS,
    ...overrides,
  };
  const liveProcesses = new Map<string, LiveProcess>();

  return {
    run: (command, options, writer, context) => (
      runAntigravity(command, options, writer, context, dependencies, liveProcesses)
    ),
    abort: (sessionId) => abortAntigravitySession(sessionId, liveProcesses),
  };
}

/** Runtime adapter consumed by the Providers registry and runtime service. */
export const antigravityRuntime: IProviderRuntime = createAntigravityRuntime();
