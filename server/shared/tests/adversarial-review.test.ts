import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendAdversarialReviewTag,
  normalizeAdversaries,
  parseAdversarialReviewTag,
} from '@/shared/adversarial-review.js';
import { appendFilesInputTag, parseFilesInputTag } from '@/shared/image-attachments.js';

test('normalizeAdversaries keeps known ids once, in catalog order', () => {
  assert.deepEqual(normalizeAdversaries(['codex', 'rm -rf', 'antigravity', 'codex', 3]), ['antigravity', 'codex']);
  assert.deepEqual(normalizeAdversaries('antigravity'), []);
  assert.deepEqual(normalizeAdversaries(undefined), []);
});

test('appendAdversarialReviewTag leaves the prompt alone without valid adversaries', () => {
  assert.equal(appendAdversarialReviewTag('hola', [], '/tmp/p'), 'hola');
  assert.equal(appendAdversarialReviewTag('hola', ['nope'], '/tmp/p'), 'hola');
});

test('appendAdversarialReviewTag names only the chosen adversaries with read-only commands', () => {
  const prompt = appendAdversarialReviewTag('Review the plan', ['antigravity'], "/home/u/it's here");
  assert.ok(prompt.startsWith('Review the plan\n\n<adversarial_review adversaries="antigravity">'));
  assert.match(prompt, /agy -p .* --mode plan /);
  assert.doesNotMatch(prompt, /codex exec/);
  // The project path is shell-quoted, single quote included.
  assert.ok(prompt.includes(`cd '/home/u/it'\\''s here' && agy`));

  const both = appendAdversarialReviewTag('x', ['codex', 'antigravity'], '/p');
  assert.match(both, /adversaries="antigravity,codex"/);
  assert.match(both, /codex exec -C '\/p' -s read-only /);
  // Each run leaves an exit-code marker the agent waits on.
  assert.match(both, /2>&1\); echo \$\? > <dir>\/codex\.done/);
  assert.match(both, /antigravity\.done, codex\.done/);
});

test('parseAdversarialReviewTag restores the typed text and the adversaries', () => {
  const sent = appendAdversarialReviewTag('¿Qué opináis?', ['antigravity', 'codex'], '/p');
  assert.deepEqual(parseAdversarialReviewTag(sent), { text: '¿Qué opináis?', adversaries: ['antigravity', 'codex'] });
  assert.deepEqual(parseAdversarialReviewTag('plain'), { text: 'plain', adversaries: [] });
});

test('the block survives the files tag the Claude runtime appends after it', () => {
  const sent = appendFilesInputTag(
    appendAdversarialReviewTag('Look at this', ['codex'], '/p'),
    [{ path: '/home/u/.cloudcli/assets/a.pdf', name: 'a.pdf' }],
  );
  const files = parseFilesInputTag(sent);
  assert.equal(files.attachments.length, 1);
  assert.deepEqual(parseAdversarialReviewTag(files.text), { text: 'Look at this', adversaries: ['codex'] });
});

test('only the last block is stripped, so typed text that quotes one stays', () => {
  const typed = 'Explain <adversarial_review adversaries="codex">this</adversarial_review> please';
  const parsed = parseAdversarialReviewTag(appendAdversarialReviewTag(typed, ['antigravity'], '/p'));
  assert.equal(parsed.text, typed);
  assert.deepEqual(parsed.adversaries, ['antigravity']);
});
