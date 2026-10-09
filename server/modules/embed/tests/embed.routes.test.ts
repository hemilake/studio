import assert from 'node:assert/strict';
import test from 'node:test';

import { createCorsOriginCheck } from '../embed.routes.js';

const CONSOLE = 'https://lake.example.com';

function allows(origin: string | undefined, origins: string[] = [CONSOLE]): boolean | undefined {
  let answer: boolean | undefined;
  createCorsOriginCheck(() => origins)(origin, (error, allow) => {
    assert.equal(error, null);
    answer = allow;
  });
  return answer;
}

test('only the consoles allowed to frame Studio may read it cross-origin', () => {
  assert.equal(allows(CONSOLE), true);
  assert.equal(allows('https://evil.example'), false);
  assert.equal(allows('https://lake.example.com.evil.example'), false);
  assert.equal(allows('null'), false);
  assert.equal(allows(undefined), false);
  assert.equal(allows(CONSOLE, []), false);
});
