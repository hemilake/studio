import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

const readUserPreference = vi.fn();
const browseFilesystem = vi.fn();

vi.mock('@/shared/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/shared/api');
  return { ...actual, api: { browseFilesystem } };
});

vi.mock('@/shared/userSettings', () => ({
  readUserPreference,
  writeUserPreference: vi.fn(),
  subscribeToUserPreferences: () => () => undefined,
}));

const chatProject: Project = { projectId: 'chat', displayName: 'Chat', fullPath: '/home/p/chat' };
const codeProject: Project = { projectId: 'code', displayName: 'code', fullPath: '/home/p/code' };

beforeEach(async () => {
  readUserPreference.mockImplementation((key: string) => (key === 'chatWorkspacePath' ? '/home/p/chat' : ''));
  browseFilesystem.mockResolvedValue(new Response(JSON.stringify({ path: '/home/p', suggestions: [] })));
  const { resetChatWorkspacePathCache } = await import('@/modules/chat-workspace/chatWorkspace');
  resetChatWorkspacePathCache();
});

test('new sessions in the chat workspace get the chat model and effort, others get nothing', async () => {
  const { useChatWorkspaceModel } = await import('@/modules/chat-workspace/useChatWorkspaceModel');

  const chat = renderHook(() => useChatWorkspaceModel({ selectedProject: chatProject, provider: 'claude', hasSession: false }));
  assert.equal(chat.result.current.model, 'opus');
  assert.equal(chat.result.current.effort, 'medium');

  const code = renderHook(() => useChatWorkspaceModel({ selectedProject: codeProject, provider: 'claude', hasSession: false }));
  assert.equal(code.result.current.model, null);
  assert.equal(code.result.current.effort, null);

  const open = renderHook(() => useChatWorkspaceModel({ selectedProject: chatProject, provider: 'claude', hasSession: true }));
  assert.equal(open.result.current.model, null);
  assert.equal(open.result.current.effort, null);

  const codex = renderHook(() => useChatWorkspaceModel({ selectedProject: chatProject, provider: 'codex', hasSession: false }));
  assert.equal(codex.result.current.model, null);
  assert.equal(codex.result.current.effort, null);
});

test('a manual pick sticks for the new chat and is dropped once a session exists', async () => {
  const { useChatWorkspaceModel } = await import('@/modules/chat-workspace/useChatWorkspaceModel');
  let hasSession = false;
  const hook = renderHook(() => useChatWorkspaceModel({ selectedProject: chatProject, provider: 'claude', hasSession }));

  act(() => hook.result.current.setModel('sonnet'));
  act(() => hook.result.current.setEffort('high'));
  assert.equal(hook.result.current.model, 'sonnet');
  assert.equal(hook.result.current.effort, 'high');

  hasSession = true;
  hook.rerender();
  assert.equal(hook.result.current.model, null);
  assert.equal(hook.result.current.effort, null);

  hasSession = false;
  hook.rerender();
  assert.equal(hook.result.current.model, 'opus');
  assert.equal(hook.result.current.effort, 'medium');
});
