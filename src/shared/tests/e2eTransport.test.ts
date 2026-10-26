import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  decryptClientBytes,
  encryptClientBytes,
  fromBase64Url,
  packBinaryEnvelope,
  toBase64Url,
  unpackBinaryEnvelope,
} from '@/shared/e2eTransport';

test('packs and unpacks binary envelopes preserving metadata and binary body', () => {
  const meta = {
    method: 'POST',
    url: '/api/projects/123/sessions?limit=20',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    ts: 1700000000000,
  };
  const body = new Uint8Array([0, 1, 2, 128, 255]);
  const packed = packBinaryEnvelope(meta, body);
  const unpacked = unpackBinaryEnvelope<typeof meta>(packed);

  assert.deepEqual(unpacked.meta, meta);
  assert.deepEqual(Array.from(unpacked.body), [0, 1, 2, 128, 255]);
});

test('encrypts and decrypts payloads with AES-256-GCM and rejects mismatched AAD', async () => {
  const key = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  const plaintext = new TextEncoder().encode('confidential prompt payload');
  const ciphertext = await encryptClientBytes(key, plaintext, 'c2s:http:kid-1');

  const decrypted = await decryptClientBytes(key, ciphertext, 'c2s:http:kid-1');
  assert.equal(new TextDecoder().decode(decrypted), 'confidential prompt payload');

  // Reflection or sequence mismatch must fail authentication
  await assert.rejects(
    () => decryptClientBytes(key, ciphertext, 's2c:http:kid-1'),
  );
  await assert.rejects(
    () => decryptClientBytes(key, ciphertext, 'c2s:http:kid-2'),
  );
});

test('round-trips base64url bytes without padding', () => {
  const raw = new Uint8Array(65);
  globalThis.crypto.getRandomValues(raw);
  const encoded = toBase64Url(raw);
  assert.equal(encoded.includes('='), false);
  assert.equal(encoded.includes('+'), false);
  assert.equal(encoded.includes('/'), false);
  assert.deepEqual(Array.from(fromBase64Url(encoded)), Array.from(raw));
});
