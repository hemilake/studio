import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { getClaudeConfigDirectory, getClaudeGlobalConfigPath } from '@/shared/utils.js';

test('without CLAUDE_CONFIG_DIR, Claude Code lives in ~/.claude and ~/.claude.json', () => {
  assert.equal(getClaudeConfigDirectory('/home/owner', {}), path.join('/home/owner', '.claude'));
  assert.equal(getClaudeGlobalConfigPath('/home/owner', {}), path.join('/home/owner', '.claude.json'));
});

test('with CLAUDE_CONFIG_DIR, both live inside it, as Claude Code writes them', () => {
  const environment = { CLAUDE_CONFIG_DIR: '/opt/studio/claude' };
  assert.equal(getClaudeConfigDirectory('/home/owner', environment), path.resolve('/opt/studio/claude'));
  assert.equal(getClaudeGlobalConfigPath('/home/owner', environment), path.join(path.resolve('/opt/studio/claude'), '.claude.json'));
});

test('a blank CLAUDE_CONFIG_DIR counts as unset', () => {
  assert.equal(getClaudeConfigDirectory('/home/owner', { CLAUDE_CONFIG_DIR: '  ' }), path.join('/home/owner', '.claude'));
});
