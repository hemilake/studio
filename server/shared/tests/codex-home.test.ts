import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { getCodexHomeDirectory } from '@/shared/utils.js';

test('without CODEX_HOME, Codex lives in ~/.codex', () => {
  assert.equal(getCodexHomeDirectory('/home/owner', {}), path.join('/home/owner', '.codex'));
});

test('with CODEX_HOME, Codex lives there, as Codex itself reads it', () => {
  assert.equal(getCodexHomeDirectory('/home/owner', { CODEX_HOME: '/opt/studio/codex' }), path.resolve('/opt/studio/codex'));
});

test('a blank CODEX_HOME counts as unset', () => {
  assert.equal(getCodexHomeDirectory('/home/owner', { CODEX_HOME: '  ' }), path.join('/home/owner', '.codex'));
});
