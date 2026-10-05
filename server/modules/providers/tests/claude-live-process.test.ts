import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canContinueInLiveProcess,
  createHeldPromptStream,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';

const turn = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });

test('the held stream yields later turns pushed into it', async () => {
  const held = createHeldPromptStream([turn('first')]);
  const iterator = held.stream[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value.message.content, 'first');

  const second = iterator.next();
  assert.equal(held.push([turn('second')]), true);
  assert.equal((await second).value.message.content, 'second');

  const end = iterator.next();
  held.release();
  assert.equal((await end).done, true);
  assert.equal(held.push([turn('third')]), false);
  assert.equal(held.isReleased(), true);
});

test('turns pushed before the stream is read are not lost', async () => {
  const held = createHeldPromptStream([turn('first')]);
  held.push([turn('second')]);
  held.release();

  const seen: string[] = [];
  for await (const message of held.stream) {
    seen.push(message.message.content);
  }
  assert.deepEqual(seen, ['first', 'second']);
});

const launch = {
  cwd: '/home/u/chat',
  effort: 'high',
  model: 'opus[1m]',
  permissionMode: 'bypassPermissions',
  allowedTools: ['Read'],
  disallowedTools: ['WebFetch'],
  mcpServers: { a: { command: 'x' } },
};

test('model and permission mode changes keep the live process', () => {
  assert.equal(canContinueInLiveProcess(launch, { ...launch, model: 'sonnet', permissionMode: 'default' }), true);
});

test('a newly allowed tool keeps the live process', () => {
  assert.equal(canContinueInLiveProcess(launch, { ...launch, allowedTools: ['Read', 'Bash(git:*)'] }), true);
});

test('options fixed at spawn time need a new process', () => {
  assert.equal(canContinueInLiveProcess(launch, { ...launch, effort: 'max' }), false);
  assert.equal(canContinueInLiveProcess(launch, { ...launch, cwd: '/tmp' }), false);
  assert.equal(canContinueInLiveProcess(launch, { ...launch, settings: { ultracode: true } }), false);
  assert.equal(canContinueInLiveProcess(launch, { ...launch, mcpServers: {} }), false);
  assert.equal(canContinueInLiveProcess(launch, { ...launch, allowedTools: [] }), false);
  assert.equal(canContinueInLiveProcess(launch, { ...launch, disallowedTools: ['WebFetch', 'Bash'] }), false);
});
