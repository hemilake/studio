import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

const ENV = 'CLOUDCLI_AUTO_ARCHIVE_PROJECT_PATHS';

async function withDatabase(envValue: string | undefined, runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousPatterns = process.env[ENV];
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'projects-auto-archive-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  if (envValue === undefined) {
    delete process.env[ENV];
  } else {
    process.env[ENV] = envValue;
  }
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    for (const [key, value] of [['DATABASE_PATH', previousDatabasePath], [ENV, previousPatterns]] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('a session indexed from disk under an automated path files its project archived', async () => {
  await withDatabase('/agents/**,/tmp/**', () => {
    sessionsDb.createSession('s1', 'claude', '/agents/GH-1/repo');
    sessionsDb.createSession('s2', 'claude', '/home/owner/chat');
    sessionsDb.createSession('s3', 'claude', '/tmp/e2e/work');

    assert.equal(projectsDb.getProjectPath('/agents/GH-1/repo')?.isArchived, 1);
    assert.equal(projectsDb.getProjectPath('/tmp/e2e/work')?.isArchived, 1);
    assert.equal(projectsDb.getProjectPath('/home/owner/chat')?.isArchived, 0);
    assert.deepEqual(projectsDb.getProjectPaths().map((row) => row.project_path), ['/home/owner/chat']);
  });
});

test('new activity on disk does not reactivate an automated project', async () => {
  await withDatabase('/agents/**', () => {
    sessionsDb.createSession('s1', 'claude', '/agents/GH-2/repo');
    sessionsDb.createSession('s2', 'claude', '/agents/GH-2/repo', undefined, undefined, '2026-11-13T08:00:00.000Z');
    sessionsDb.createSession('s1', 'claude', '/agents/GH-2/repo', undefined, undefined, '2026-11-13T09:00:00.000Z');

    assert.equal(projectsDb.getProjectPath('/agents/GH-2/repo')?.isArchived, 1);
  });
});

test('an automated project the user reopened stays open while its sessions keep changing', async () => {
  await withDatabase('/agents/**', () => {
    sessionsDb.createSession('s1', 'claude', '/agents/GH-3/repo');
    assert.equal(projectsDb.createProjectPath('/agents/GH-3/repo').outcome, 'reactivated_archived');

    sessionsDb.createSession('s2', 'claude', '/agents/GH-3/repo');

    assert.equal(projectsDb.getProjectPath('/agents/GH-3/repo')?.isArchived, 0);
  });
});

test('other archived projects still come back with new activity, as upstream does', async () => {
  await withDatabase('/agents/**', () => {
    sessionsDb.createSession('s1', 'claude', '/home/owner/old');
    projectsDb.updateProjectIsArchived('/home/owner/old', true);

    sessionsDb.createSession('s2', 'claude', '/home/owner/old');

    assert.equal(projectsDb.getProjectPath('/home/owner/old')?.isArchived, 0);
  });
});

test('without patterns every indexed path is an active project', async () => {
  await withDatabase(undefined, () => {
    sessionsDb.createSession('s1', 'claude', '/agents/GH-4/repo');

    assert.equal(projectsDb.getProjectPath('/agents/GH-4/repo')?.isArchived, 0);
  });
});
