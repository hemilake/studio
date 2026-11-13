import assert from 'node:assert/strict';
import test from 'node:test';

import { isAutoArchivedProjectPath, parseAutoArchivePatterns } from '@/shared/project-auto-archive.js';

const HOME = '/home/owner';

test('no patterns: nothing is auto-archived', () => {
  assert.equal(isAutoArchivedProjectPath('/tmp/x', parseAutoArchivePatterns(undefined, HOME)), false);
  assert.equal(isAutoArchivedProjectPath('/tmp/x', parseAutoArchivePatterns(' , ', HOME)), false);
});

test('trailing /** matches the directory and everything below it', () => {
  const patterns = parseAutoArchivePatterns('~/.agents/**', HOME);
  assert.equal(isAutoArchivedProjectPath('/home/owner/.agents', patterns), true);
  assert.equal(isAutoArchivedProjectPath('/home/owner/.agents/GH-1/repo', patterns), true);
  assert.equal(isAutoArchivedProjectPath('/home/owner/.agents-other', patterns), false);
  assert.equal(isAutoArchivedProjectPath('/home/owner/chat', patterns), false);
});

test('* stays inside one segment and ? matches one character', () => {
  const patterns = parseAutoArchivePatterns('/work/*/repo, /scratch/run-?', HOME);
  assert.equal(isAutoArchivedProjectPath('/work/GH-7/repo', patterns), true);
  assert.equal(isAutoArchivedProjectPath('/work/a/b/repo', patterns), false);
  assert.equal(isAutoArchivedProjectPath('/scratch/run-1', patterns), true);
  assert.equal(isAutoArchivedProjectPath('/scratch/run-12', patterns), false);
});

test('exact paths, newlines and trailing slashes', () => {
  const patterns = parseAutoArchivePatterns('~/work/watcher\n/tmp/**', HOME);
  assert.equal(isAutoArchivedProjectPath('/home/owner/work/watcher/', patterns), true);
  assert.equal(isAutoArchivedProjectPath('/home/owner/work/watcher/sub', patterns), false);
  assert.equal(isAutoArchivedProjectPath('/tmp', patterns), true);
  assert.equal(isAutoArchivedProjectPath('/tmp/e2e.Ab+c/work', patterns), true);
});
