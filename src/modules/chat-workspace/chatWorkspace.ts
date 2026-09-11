import { api, readApiJson, ApiRequestError } from '@/shared/api';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';
import type { Project } from '@/shared/types';

/**
 * Fork feature: a one-click "Chat" that always lands in the same workspace.
 *
 * The workspace is an ordinary project. Its path comes from the
 * `chatWorkspacePath` user preference, or `<workspace root>/chat` when unset
 * (the root is the server's home directory unless WORKSPACES_ROOT overrides it,
 * so each instance gets its own folder).
 */

export const CHAT_WORKSPACE_FOLDER_NAME = 'chat';
export const CHAT_WORKSPACE_DISPLAY_NAME = 'Chat';

const stripTrailingSlashes = (value: string): string => value.replace(/[\\/]+$/, '') || value;

/** The configured chat workspace path, or an empty string for "use the default". */
export function readChatWorkspacePreference(): string {
  const stored = readUserPreference<unknown>('chatWorkspacePath', '');
  return typeof stored === 'string' ? stored.trim() : '';
}

export function writeChatWorkspacePreference(value: string): void {
  const trimmed = value.trim();
  writeUserPreference('chatWorkspacePath', trimmed.length > 0 ? stripTrailingSlashes(trimmed) : null);
}

/** `<workspace root>/chat`, asking the server where the root is. */
export async function fetchDefaultChatWorkspacePath(): Promise<string> {
  const response = await api.browseFilesystem(null);
  const data = await readApiJson<{ path?: unknown }>(response);
  if (typeof data.path !== 'string' || data.path.length === 0) {
    throw new Error('Workspace root is unavailable');
  }
  const separator = data.path.includes('\\') && !data.path.includes('/') ? '\\' : '/';
  return `${stripTrailingSlashes(data.path)}${separator}${CHAT_WORKSPACE_FOLDER_NAME}`;
}

export async function resolveChatWorkspacePath(): Promise<string> {
  const configured = readChatWorkspacePreference();
  return configured.length > 0 ? configured : fetchDefaultChatWorkspacePath();
}

export function findProjectByPath(projects: readonly Project[], targetPath: string): Project | null {
  const wanted = stripTrailingSlashes(targetPath);
  return projects.find((project) => stripTrailingSlashes(project.fullPath ?? project.path ?? '') === wanted) ?? null;
}

async function fetchProjectByPath(targetPath: string): Promise<Project | null> {
  const response = await api.projects();
  const projects = await readApiJson<Project[]>(response);
  return findProjectByPath(Array.isArray(projects) ? projects : [], targetPath);
}

/**
 * Returns the project registered at `targetPath`, creating the folder and the
 * project when needed. A 409 means the project exists but the caller's list
 * was stale, so it is looked up again instead of failing.
 */
export async function ensureChatProject(targetPath: string, knownProjects: readonly Project[]): Promise<Project> {
  const known = findProjectByPath(knownProjects, targetPath);
  if (known) {
    return known;
  }

  try {
    const response = await api.createProject({ path: targetPath, customName: CHAT_WORKSPACE_DISPLAY_NAME });
    const data = await readApiJson<{ project?: Project }>(response);
    if (data.project) {
      return data.project;
    }
  } catch (error) {
    const alreadyExists = error instanceof ApiRequestError && (error.status === 409 || error.code === 'PROJECT_ALREADY_EXISTS');
    if (!alreadyExists) {
      throw error;
    }
  }

  const existing = await fetchProjectByPath(targetPath);
  if (!existing) {
    throw new Error(`Chat workspace not found after creation: ${targetPath}`);
  }
  return existing;
}
