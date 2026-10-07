import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readEmbedConfig, readEmbedOrigins } from '../embed.config.js';

const SECRET = 'x'.repeat(40);

test('origins are normalised, deduplicated and anything that is not a bare http(s) origin is dropped', () => {
  const origins = readEmbedOrigins({
    CLOUDCLI_EMBED_ORIGINS: ' https://lake.example.com , https://lake.example.com/, http://127.0.0.1:8095,*,ftp://x.example,https://a.example/path,not a url',
  });
  assert.deepEqual(origins, ['https://lake.example.com', 'http://127.0.0.1:8095']);
});

test('no origins configured means nobody else may frame Studio', () => {
  assert.deepEqual(readEmbedOrigins({}), []);
});

test('the secret comes from the variable, else from the file, and must be long enough', () => {
  assert.equal(readEmbedConfig({ CLOUDCLI_EMBED_SECRET: SECRET }).secret, SECRET);
  assert.equal(readEmbedConfig({ CLOUDCLI_EMBED_SECRET: 'short' }).secret, null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-config-'));
  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, `${SECRET}\n`);
  try {
    assert.equal(readEmbedConfig({ CLOUDCLI_EMBED_SECRET_FILE: file }).secret, SECRET);
    assert.equal(readEmbedConfig({ CLOUDCLI_EMBED_SECRET_FILE: path.join(dir, 'missing') }).secret, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('console-only mode is on only when CLOUDCLI_EMBED_ONLY says so', () => {
  assert.equal(readEmbedConfig({}).only, false);
  assert.equal(readEmbedConfig({ CLOUDCLI_EMBED_ONLY: '1' }).only, true);
  assert.equal(readEmbedConfig({ CLOUDCLI_EMBED_ONLY: ' True ' }).only, true);
  assert.equal(readEmbedConfig({ CLOUDCLI_EMBED_ONLY: '0' }).only, false);
  assert.equal(readEmbedConfig({ CLOUDCLI_EMBED_ONLY: 'off' }).only, false);
});
