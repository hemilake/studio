import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project } from '@/shared/types';

/**
 * Fork. Adversarial mode lasts one message: the send that carries the
 * adversaries tells ChatInterface to turn the toggle off, so the next message
 * goes without them unless the user turns it on again.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
    },
  };
});

const renderComposer = (adversaries: string[]) => {
  const sendMessage = vi.fn();
  const onAdversariesSent = vi.fn();
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: { id: 'session-a' },
    currentSessionId: 'session-a',
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    adversaries,
    onAdversariesSent,
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));
  return { view, sendMessage, onAdversariesSent };
};

const submit = async (view: { result: { current: ReturnType<typeof useChatComposerState> } }, text: string) => {
  await act(async () => {
    view.result.current.setInput(text);
  });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
};

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
});

test('sending a turn with adversaries turns adversarial mode off', async () => {
  const { view, sendMessage, onAdversariesSent } = renderComposer(['gemini4']);
  await submit(view, 'Review this');

  assert.equal(sendMessage.mock.calls.length, 1);
  assert.deepEqual(sendMessage.mock.calls[0][0].options.adversaries, ['gemini4']);
  assert.equal(onAdversariesSent.mock.calls.length, 1);
});

test('a turn without adversaries leaves the mode alone', async () => {
  const { view, sendMessage, onAdversariesSent } = renderComposer([]);
  await submit(view, 'Plain message');

  assert.equal(sendMessage.mock.calls.length, 1);
  assert.equal(sendMessage.mock.calls[0][0].options.adversaries, undefined);
  assert.equal(onAdversariesSent.mock.calls.length, 0);
});

test('a turn queued with adversaries turns the mode off, and editing it turns it back on', async () => {
  const sendMessage = vi.fn();
  const onAdversariesSent = vi.fn();
  const onAdversariesRestored = vi.fn();
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: { id: 'session-a' },
    currentSessionId: 'session-a',
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    adversaries: ['codex'],
    onAdversariesSent,
    onAdversariesRestored,
    // A turn is in flight, so the message is queued instead of sent.
    isLoading: true,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));

  await submit(view, 'Queued review');
  assert.equal(sendMessage.mock.calls.length, 0);
  assert.equal(onAdversariesSent.mock.calls.length, 1);

  await act(async () => {
    view.result.current.editQueuedDraft();
  });
  assert.equal(view.result.current.input, 'Queued review');
  assert.equal(onAdversariesRestored.mock.calls.length, 1);
});
