import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import {
  buildAntigravityArgs,
  createAntigravityRuntime,
  resolveAntigravityPermissionArgs,
} from '@/modules/providers/list/antigravity/antigravity-runtime.provider.js';
import type {
  AnyRecord,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const sessionsProvider = new AntigravitySessionsProvider();

function createRuntimeContext(
  overrides: Partial<ProviderRuntimeContext> = {},
): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
    normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    ...overrides,
  };
}

type FakeAntigravityProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal?: NodeJS.Signals): boolean;
};

function createFakeProcess(
  onKill?: (signal: NodeJS.Signals | undefined) => void,
): FakeAntigravityProcess {
  const child = new EventEmitter() as FakeAntigravityProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    onKill?.(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

function createWriter(onMessage?: (message: AnyRecord) => void): {
  writer: ProviderRuntimeWriter;
  messages: AnyRecord[];
  getProviderSessionId(): string | null;
} {
  const messages: AnyRecord[] = [];
  let providerSessionId: string | null = null;
  return {
    messages,
    getProviderSessionId: () => providerSessionId,
    writer: {
      userId: null,
      send(data) {
        const message = data as AnyRecord;
        messages.push(message);
        onMessage?.(message);
      },
      setSessionId(sessionId) {
        providerSessionId = sessionId;
      },
    },
  };
}

/**
 * Fake AGY process: answers every stdin turn with the NDJSON lines `script`
 * returns for it, the way `agy --input-format stream-json` does.
 */
function createScriptedProcess(
  script: (turn: AnyRecord, turnIndex: number) => AnyRecord[],
  onKill?: (signal: NodeJS.Signals | undefined) => void,
) {
  const child = createFakeProcess(onKill);
  const turns: AnyRecord[] = [];
  let pending = '';
  child.stdin.on('data', (chunk: Buffer) => {
    pending += chunk.toString();
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const turn = JSON.parse(pending.slice(0, newline)) as AnyRecord;
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
      turns.push(turn);
      const lines = script(turn, turns.length - 1);
      queueMicrotask(() => {
        for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
      });
    }
  });
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
  return { child, turns };
}

const step = (conversationId: string, fields: AnyRecord) => ({
  event: 'step_update',
  step_update: { conversation_id: conversationId, ...fields },
});
const result = (conversationId: string, status = 'SUCCESS', error?: string) => ({
  event: 'result',
  result: { conversation_id: conversationId, status, ...(error ? { error } : {}) },
});

function replyScript(conversationId: string, reply = 'hola') {
  return (_turn: AnyRecord, turnIndex: number) => [
    ...(turnIndex === 0 ? [{ event: 'init', conversation_id: conversationId, init: { model: 'm' } }] : []),
    step(conversationId, { step_index: 0, state: 'DONE', step_type: 'user_input' }),
    step(conversationId, { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/tmp/a.txt' } } }),
    step(conversationId, { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/tmp/a.txt' }, output: '2 lines' } }),
    step(conversationId, { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: reply }),
    step(conversationId, { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '\n', usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 5 } }),
    result(conversationId),
  ];
}

test('Antigravity permission modes map to agy controls', () => {
  assert.deepEqual(resolveAntigravityPermissionArgs('plan'), ['--mode', 'plan']);
  assert.deepEqual(resolveAntigravityPermissionArgs('acceptEdits'), ['--mode', 'accept-edits']);
  assert.deepEqual(resolveAntigravityPermissionArgs('bypassPermissions'), ['--dangerously-skip-permissions']);
  assert.deepEqual(resolveAntigravityPermissionArgs('default'), []);
});

test('Antigravity runs in stream-json mode both ways', () => {
  assert.deepEqual(
    buildAntigravityArgs({ conversationId: 'c1', model: 'gemini-x', permissionMode: 'bypassPermissions' }),
    ['--input-format', 'stream-json', '--output-format', 'stream-json', '--conversation', 'c1', '--model', 'gemini-x', '--dangerously-skip-permissions'],
  );
});

test('Antigravity streams text and tool calls and captures the conversation id', async () => {
  const { child, turns } = createScriptedProcess(replyScript('agy-new'));
  const runtime = createAntigravityRuntime({ spawnProcess: () => child as never });
  const { writer, messages, getProviderSessionId } = createWriter();

  await runtime.run('Read a.txt', { sessionId: 'app-1' }, writer, createRuntimeContext());

  assert.deepEqual(turns, [{ event: 'user', message: { role: 'user', content: 'Read a.txt' } }]);
  assert.equal(getProviderSessionId(), 'agy-new');
  assert.deepEqual(
    messages.map((message) => message.kind).filter((kind) => kind !== 'status'),
    ['session_created', 'tool_use', 'tool_result', 'stream_delta', 'stream_delta', 'stream_end', 'complete'],
  );
  const toolUse = messages.find((message) => message.kind === 'tool_use');
  const toolResult = messages.find((message) => message.kind === 'tool_result');
  assert.equal(toolUse?.toolName, 'view_file');
  assert.deepEqual(toolUse?.toolInput, { AbsolutePath: '/tmp/a.txt' });
  assert.equal(toolResult?.toolId, toolUse?.toolId);
  assert.equal(toolResult?.content, '2 lines');
  assert.equal(messages.find((message) => message.kind === 'complete')?.exitCode, 0);
  const budget = messages.find((message) => message.kind === 'status')?.tokenBudget as AnyRecord;
  assert.equal(budget.used, 17);
});

test('Antigravity sends the next turn to the same process', async () => {
  let spawns = 0;
  const { child, turns } = createScriptedProcess(replyScript('agy-keep'));
  const runtime = createAntigravityRuntime({
    spawnProcess: () => {
      spawns += 1;
      return child as never;
    },
  });
  let providerSessionId: string | null = null;
  const context = createRuntimeContext({ resolveProviderSessionId: () => providerSessionId });
  const first = createWriter();
  await runtime.run('One', { sessionId: 'app-keep' }, first.writer, context);
  providerSessionId = first.getProviderSessionId();

  const second = createWriter();
  await runtime.run('Two', { sessionId: 'app-keep' }, second.writer, context);

  assert.equal(spawns, 1);
  assert.deepEqual(turns.map((turn) => (turn.message as AnyRecord).content), ['One', 'Two']);
  assert.equal(second.messages.filter((message) => message.kind === 'complete').length, 1);
  assert.equal(second.messages.some((message) => message.kind === 'session_created'), false);
  assert.equal(second.getProviderSessionId(), 'agy-keep');
});

test('Antigravity starts a new process with the conversation id when the model changes', async () => {
  const first = createScriptedProcess(replyScript('agy-switch'));
  const second = createScriptedProcess(replyScript('agy-switch'));
  const spawned: string[][] = [];
  let firstClosed = false;
  first.child.once('close', () => { firstClosed = true; });
  const runtime = createAntigravityRuntime({
    spawnProcess: (_command, args) => {
      spawned.push(args);
      return (spawned.length === 1 ? first.child : second.child) as never;
    },
  });
  let providerSessionId: string | null = null;
  const context = createRuntimeContext({ resolveProviderSessionId: () => providerSessionId });

  const writer = createWriter();
  await runtime.run('One', { sessionId: 'app-switch', model: 'gemini-a' }, writer.writer, context);
  providerSessionId = writer.getProviderSessionId();
  await runtime.run('Two', { sessionId: 'app-switch', model: 'gemini-b' }, createWriter().writer, context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(spawned.length, 2);
  assert.equal(firstClosed, true);
  assert.equal(spawned[1][spawned[1].indexOf('--conversation') + 1], 'agy-switch');
  assert.equal(spawned[1][spawned[1].indexOf('--model') + 1], 'gemini-b');
});

test('Antigravity closes an idle process after the idle period', async () => {
  const { child } = createScriptedProcess(replyScript('agy-idle'));
  let closed = false;
  child.once('close', () => { closed = true; });
  const runtime = createAntigravityRuntime({ spawnProcess: () => child as never, idleMs: 5 });

  await runtime.run('One', { sessionId: 'app-idle' }, createWriter().writer, createRuntimeContext());
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(closed, true);
});

test('Antigravity reports a failed turn as an error and a failed complete', async () => {
  const { child } = createScriptedProcess(() => [result('agy-err', 'ERROR', 'quota exhausted')]);
  const runtime = createAntigravityRuntime({ spawnProcess: () => child as never });
  const { writer, messages } = createWriter();

  await assert.rejects(
    runtime.run('Hi', { sessionId: 'app-err' }, writer, createRuntimeContext()),
    /quota exhausted/,
  );

  assert.equal(messages.find((message) => message.kind === 'error')?.content, 'quota exhausted');
  assert.equal(messages.find((message) => message.kind === 'complete')?.exitCode, 1);
});

test('Antigravity runtime uses the configured AGY executable', { concurrency: false }, async () => {
  const previousPath = process.env.AGY_CLI_PATH;
  const { child } = createScriptedProcess(replyScript('agy-path'));
  let capturedCommand = '';
  const runtime = createAntigravityRuntime({
    spawnProcess: (command) => {
      capturedCommand = command;
      return child as never;
    },
  });

  try {
    process.env.AGY_CLI_PATH = '  "/opt/agent wrappers/agy"  ';
    await runtime.run('Hi', {}, createWriter().writer, createRuntimeContext());
    assert.equal(capturedCommand, '/opt/agent wrappers/agy');
  } finally {
    if (previousPath === undefined) {
      delete process.env.AGY_CLI_PATH;
    } else {
      process.env.AGY_CLI_PATH = previousPath;
    }
  }
});

test('Antigravity resumes with the provider-native conversation id', async () => {
  const { child } = createScriptedProcess(replyScript('agy-existing-session'));
  let capturedArgs: string[] = [];
  const runtime = createAntigravityRuntime({
    spawnProcess: (_command, args) => {
      capturedArgs = args;
      return child as never;
    },
  });
  const { writer, getProviderSessionId } = createWriter();

  await runtime.run(
    'Continue',
    { sessionId: 'app-session-2' },
    writer,
    createRuntimeContext({
      resolveProviderSessionId: (sessionId) => (
        sessionId === 'app-session-2' ? 'agy-existing-session' : null
      ),
    }),
  );

  const conversationIndex = capturedArgs.indexOf('--conversation');
  assert.notEqual(conversationIndex, -1);
  assert.equal(capturedArgs[conversationIndex + 1], 'agy-existing-session');
  assert.equal(getProviderSessionId(), 'agy-existing-session');
});

test('Antigravity abort sends SIGTERM and leaves the aborted complete to the gateway', async () => {
  let receivedSignal: NodeJS.Signals | undefined;
  let resolveTurn: (() => void) | null = null;
  const turnReceived = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });
  const { child } = createScriptedProcess(() => {
    resolveTurn?.();
    return [];
  }, (signal) => {
    receivedSignal = signal;
  });
  const runtime = createAntigravityRuntime({ spawnProcess: () => child as never });
  const { writer, messages } = createWriter();
  const run = runtime.run('Wait', { sessionId: 'app-session-abort' }, writer, createRuntimeContext());

  await turnReceived;
  assert.equal(await runtime.abort('app-session-abort'), true);
  await run;

  assert.equal(receivedSignal, 'SIGTERM');
  assert.equal(messages.some((message) => message.kind === 'complete'), false);
});

test('Antigravity reports model-resolution failures as terminal errors', async () => {
  const runtime = createAntigravityRuntime({
    spawnProcess: () => {
      throw new Error('process must not start');
    },
  });
  const { writer, messages } = createWriter();
  await assert.rejects(
    runtime.run(
      'Hi',
      { sessionId: 'app-session-model-error' },
      writer,
      createRuntimeContext({
        resolveResumeModel: async () => {
          throw new Error('model lookup failed');
        },
      }),
    ),
    /model lookup failed/,
  );

  assert.equal(messages.some((message) => message.kind === 'error'), true);
  assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
});

test('Antigravity emits one terminal lifecycle when the CLI cannot spawn', async () => {
  const child = createFakeProcess();
  const runtime = createAntigravityRuntime({
    spawnProcess: () => {
      queueMicrotask(() => {
        child.emit('error', new Error('spawn agy ENOENT'));
        child.emit('close', -2, null);
      });
      return child as never;
    },
  });
  const { writer, messages } = createWriter();

  await assert.rejects(
    runtime.run('Hi', { sessionId: 'app-session-spawn-error' }, writer, createRuntimeContext({
      isProviderInstalled: async () => false,
    })),
    /not installed/,
  );

  assert.equal(messages.filter((message) => message.kind === 'error').length, 1);
  assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
});
