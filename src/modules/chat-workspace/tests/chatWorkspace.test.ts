import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

const createProject = vi.fn();
const projects = vi.fn();
const browseFilesystem = vi.fn();
const readUserPreference = vi.fn();

vi.mock('@/shared/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/shared/api');
  return {
    ...actual,
    api: { createProject, projects, browseFilesystem },
  };
});

vi.mock('@/shared/userSettings', () => ({
  readUserPreference,
  writeUserPreference: vi.fn(),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const project = (fullPath: string, projectId = fullPath): Project => ({ projectId, displayName: 'x', fullPath });

beforeEach(() => {
  readUserPreference.mockReturnValue('');
});

test('resolveChatWorkspacePath prefers the configured preference', async () => {
  const { resolveChatWorkspacePath } = await import('@/modules/chat-workspace/chatWorkspace');
  readUserPreference.mockReturnValue('/data/notes/');

  assert.equal(await resolveChatWorkspacePath(), '/data/notes/');
  assert.equal(browseFilesystem.mock.calls.length, 0);
});

test('resolveChatWorkspacePath falls back to <workspace root>/chat', async () => {
  const { resolveChatWorkspacePath } = await import('@/modules/chat-workspace/chatWorkspace');
  browseFilesystem.mockResolvedValue(jsonResponse({ path: '/home/beatriz', suggestions: [] }));

  assert.equal(await resolveChatWorkspacePath(), '/home/beatriz/chat');
});

test('ensureChatProject reuses a known project regardless of trailing slash', async () => {
  const { ensureChatProject } = await import('@/modules/chat-workspace/chatWorkspace');
  const known = project('/home/p/chat', 'p1');

  const result = await ensureChatProject('/home/p/chat/', [known]);

  assert.equal(result, known);
  assert.equal(createProject.mock.calls.length, 0);
});

test('ensureChatProject creates the project with the Chat display name', async () => {
  const { ensureChatProject } = await import('@/modules/chat-workspace/chatWorkspace');
  const created = project('/home/p/chat', 'new');
  createProject.mockResolvedValue(jsonResponse({ success: true, project: created }));

  const result = await ensureChatProject('/home/p/chat', []);

  assert.deepEqual(result, created);
  assert.deepEqual(createProject.mock.calls[0][0], { path: '/home/p/chat', customName: 'Chat' });
});

test('ensureChatProject looks the project up again when the server reports it already exists', async () => {
  const { ensureChatProject } = await import('@/modules/chat-workspace/chatWorkspace');
  const existing = project('/home/p/chat', 'old');
  createProject.mockResolvedValue(
    jsonResponse({ success: false, error: { code: 'PROJECT_ALREADY_EXISTS', message: 'exists' } }, 409),
  );
  projects.mockResolvedValue(jsonResponse([project('/home/p/other'), existing]));

  const result = await ensureChatProject('/home/p/chat', []);

  assert.deepEqual(result, existing);
});

test('ensureChatProject surfaces other server errors', async () => {
  const { ensureChatProject } = await import('@/modules/chat-workspace/chatWorkspace');
  createProject.mockResolvedValue(
    jsonResponse({ success: false, error: { code: 'INVALID_PROJECT_PATH', message: 'Invalid project path' } }, 400),
  );

  await assert.rejects(ensureChatProject('/etc/chat', []), /Invalid project path/);
});
