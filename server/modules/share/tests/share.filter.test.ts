import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';

import {
  buildShareCandidateItems,
  buildSharePreviewItems,
  filterSharedItems,
} from '../share.filter.js';

function msg(overrides: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
  return {
    sessionId: 'session-1',
    timestamp: '2026-10-08T10:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    ...overrides,
  };
}

test('tool calls, tool results, thinking, subagent internals, slash commands, and compaction never appear', () => {
  const messages: NormalizedMessage[] = [
    msg({ id: 'u-1', role: 'user', content: 'Explain the auth flow' }),
    msg({ id: 't-think', kind: 'thinking', role: 'assistant', content: 'Secret chain of thought' }),
    msg({ id: 'a-1', role: 'assistant', content: 'Let me inspect the auth module first.' }),
    msg({
      id: 'tool-1',
      kind: 'tool_use',
      role: 'assistant',
      toolName: 'Read',
      toolId: 'call-1',
      toolInput: { file_path: '/secret/auth.ts' },
      toolResult: { content: 'const SECRET_KEY = "top-secret";', isError: false },
    }),
    msg({
      id: 'tr-1',
      kind: 'tool_result',
      role: 'user',
      toolId: 'call-1',
      content: 'const SECRET_KEY = "top-secret";',
    }),
    msg({
      id: 'sub-1',
      kind: 'text',
      role: 'assistant',
      parentToolUseId: 'call-agent-1',
      content: 'Subagent internal trace that must not leak',
    }),
    msg({ id: 'a-2', role: 'assistant', content: 'The auth module verifies HS256 assertions.' }),
    msg({
      id: 'cmd-1',
      role: 'user',
      content: '/cost',
      commandName: '/cost',
      isLocalCommand: true,
    }),
    msg({
      id: 'cmd-out-1',
      role: 'assistant',
      content: 'Total cost: $0.12',
      isLocalCommandStdout: true,
    }),
    msg({
      id: 'cmd-raw',
      role: 'user',
      content: '<command-name>/clear</command-name><command-message>clear</command-message>',
    }),
    msg({
      id: 'stdout-raw',
      role: 'user',
      content: '<local-command-stdout>cleared</local-command-stdout>',
    }),
    msg({
      id: 'compact-boundary',
      role: 'assistant',
      content: 'Compacted · auto · 120k → 20k tokens',
      compact: { phase: 'done', trigger: 'auto', preTokens: 120000, postTokens: 20000 },
    }),
    msg({
      id: 'compact-summary',
      role: 'assistant',
      content: 'Summary of compacted conversation',
      isCompactSummary: true,
    }),
    msg({
      id: 'compact-summary-unflagged',
      role: 'assistant',
      content: 'Summary of compacted conversation',
    }),
    msg({
      id: 'compact-ack',
      role: 'assistant',
      content: 'Compacted.',
    }),
    msg({
      id: 'meta-1',
      role: 'user',
      content: 'Base directory for this skill: /home/user/.claude/skills/foo',
    }),
    msg({
      id: 'task-notif',
      role: 'user',
      content: '<task-notification><status>completed</status><summary>Done</summary></task-notification>',
    }),
  ];

  const items = filterSharedItems(messages);

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: 'u-1',
    role: 'user',
    text: 'Explain the auth flow',
    timestamp: '2026-10-08T10:00:00.000Z',
  });
  // Assistant text blocks from the same turn are joined and keep the first block's id.
  assert.deepEqual(items[1], {
    id: 'a-1',
    role: 'assistant',
    text: 'Let me inspect the auth module first.\n\nThe auth module verifies HS256 assertions.',
    timestamp: '2026-10-08T10:00:00.000Z',
  });

  const serialized = JSON.stringify(items);
  assert.ok(!serialized.includes('Secret chain of thought'));
  assert.ok(!serialized.includes('SECRET_KEY'));
  assert.ok(!serialized.includes('Read'));
  assert.ok(!serialized.includes('Subagent internal'));
  assert.ok(!serialized.includes('Total cost'));
  assert.ok(!serialized.includes('Compacted'));
  assert.ok(!serialized.includes('Base directory for this skill'));
});

test('system reminders and hook blocks are stripped from user prompts and reminder-only messages are dropped', () => {
  const messages: NormalizedMessage[] = [
    msg({
      id: 'u-reminder-only',
      role: 'user',
      content: '<system-reminder>\nDo not leak this system reminder.\n</system-reminder>',
    }),
    msg({
      id: 'u-with-reminder',
      role: 'user',
      content:
        'Please fix the bug in login.ts\n<system-reminder>\nCLAUDE.md context: secret internal rules\n</system-reminder>\n<user-prompt-submit-hook>hook secret</user-prompt-submit-hook>',
    }),
    msg({
      id: 'a-reply',
      role: 'assistant',
      content: 'Fixed the bug in login.ts.',
    }),
  ];

  const items = filterSharedItems(messages);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'u-with-reminder');
  assert.equal(items[0].text, 'Please fix the bug in login.ts');
  assert.ok(!items[0].text.includes('system-reminder'));
  assert.ok(!items[0].text.includes('secret internal rules'));
  assert.ok(!items[0].text.includes('hook secret'));
});

test('images and file attachments become [image] and [attachment] placeholders without leaking data or paths', () => {
  const messages: NormalizedMessage[] = [
    msg({
      id: 'u-media',
      role: 'user',
      content: 'Check this screenshot and log file',
      images: [{ data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA' }],
      files: [{ path: '/home/owner/.cloudcli/assets/secret.log', name: 'secret.log' }],
    }),
    msg({
      id: 'u-image-only',
      role: 'user',
      content: '',
      images: [
        { data: 'data:image/png;base64,AAAA' },
        { data: 'data:image/png;base64,BBBB' },
      ],
    }),
  ];

  const items = filterSharedItems(messages);
  assert.equal(items.length, 2);
  assert.equal(items[0].text, 'Check this screenshot and log file\n\n[image] [attachment]');
  assert.equal(items[1].text, '[image] [image]');

  const serialized = JSON.stringify(items);
  assert.ok(!serialized.includes('iVBORw0KGgo'));
  assert.ok(!serialized.includes('secret.log'));
  assert.ok(!serialized.includes('.cloudcli/assets'));
});

test('hidden ids are removed from public items and flagged hidden: true in preview items with identical ids', () => {
  const messages: NormalizedMessage[] = [
    msg({ id: 'u-1', role: 'user', content: 'First prompt' }),
    msg({ id: 'a-1a', role: 'assistant', content: 'Part one of turn 1' }),
    msg({ id: 'a-1b', role: 'assistant', content: 'Part two of turn 1' }),
    msg({ id: 'u-2', role: 'user', content: 'Second prompt (sensitive)' }),
    msg({ id: 'a-2', role: 'assistant', content: 'Second reply' }),
  ];

  const candidates = buildShareCandidateItems(messages);
  assert.deepEqual(
    candidates.map((item) => item.id),
    ['u-1', 'a-1a', 'u-2', 'a-2'],
  );

  const hiddenIds = ['a-1a', 'u-2'];
  const publicItems = filterSharedItems(messages, hiddenIds);
  assert.deepEqual(
    publicItems.map((item) => item.id),
    ['u-1', 'a-2'],
  );
  assert.ok(!JSON.stringify(publicItems).includes('Second prompt (sensitive)'));
  assert.ok(!JSON.stringify(publicItems).includes('Part one of turn 1'));

  const previewItems = buildSharePreviewItems(messages, hiddenIds);
  assert.deepEqual(
    previewItems.map((item) => ({ id: item.id, hidden: item.hidden })),
    [
      { id: 'u-1', hidden: false },
      { id: 'a-1a', hidden: true },
      { id: 'u-2', hidden: true },
      { id: 'a-2', hidden: false },
    ],
  );
});
