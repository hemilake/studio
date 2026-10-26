import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import multer from 'multer';
import { WebSocket } from 'ws';

import {
  createE2EMiddleware,
  decryptServerBytes,
  encryptServerBytes,
  fromBase64Url,
  packBinaryEnvelope,
  toBase64Url,
  unpackBinaryEnvelope,
  type E2EHandshakeResponse,
  type E2ERequestMeta,
  type E2EResponseMeta,
} from '@/modules/e2e/index.js';
import { createWebSocketServer } from '@/modules/websocket/index.js';

const { subtle } = globalThis.crypto;

async function performWebCryptoClientHandshake(baseUrl: string): Promise<{
  kid: string;
  aesKey: crypto.webcrypto.CryptoKey;
  rawKeyBytes: Buffer;
  fingerprint: string;
}> {
  const clientKeyPair = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const clientPubRaw = new Uint8Array(await subtle.exportKey('raw', clientKeyPair.publicKey));

  const res = await fetch(`${baseUrl}/api/e2e/handshake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientEcdhPublicKey: toBase64Url(clientPubRaw),
    }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as E2EHandshakeResponse;

  const serverPubRaw = fromBase64Url(data.serverEcdhPublicKey);
  const identitySpki = fromBase64Url(data.identityPublicKey);
  const signature = fromBase64Url(data.signature);

  const verifyKey = await subtle.importKey(
    'spki',
    identitySpki,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );

  const transcript = Buffer.concat([
    Buffer.from('cloudcli-e2e-v1', 'utf8'),
    Buffer.from(clientPubRaw),
    serverPubRaw,
  ]);

  const valid = await subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    signature,
    transcript,
  );
  assert.equal(valid, true, 'Server ECDSA P-256 handshake signature must verify in WebCrypto');

  const serverEcdhKey = await subtle.importKey(
    'raw',
    serverPubRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedBits = await subtle.deriveBits(
    { name: 'ECDH', public: serverEcdhKey },
    clientKeyPair.privateKey,
    256,
  );
  const salt = new Uint8Array(
    await subtle.digest('SHA-256', Buffer.concat([Buffer.from(clientPubRaw), serverPubRaw])),
  );
  const hkdfKey = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const aesKey = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode('cloudcli-e2e-v1-aes256gcm'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const rawBits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode('cloudcli-e2e-v1-aes256gcm'),
    },
    hkdfKey,
    256,
  );

  return {
    kid: data.kid,
    aesKey,
    rawKeyBytes: Buffer.from(rawBits),
    fingerprint: data.identityFingerprint,
  };
}

test('E2E HTTP tunnel handles JSON, GET query params, multer uploads, SSE streams, and 425 expiry', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-e2e-test-'));
  const prevIdentityPath = process.env.E2E_IDENTITY_PATH;
  process.env.E2E_IDENTITY_PATH = path.join(tempDir, 'e2e-identity.json');

  const app = express();
  const upload = multer({ storage: multer.memoryStorage() });

  app.use(createE2EMiddleware(app));
  app.use(express.json());

  app.get('/api/projects', (req, res) => {
    res.setHeader('X-Refreshed-Token', 'refreshed-jwt-123');
    res.status(200).json({
      success: true,
      filter: req.query.filter ?? null,
      auth: req.headers.authorization ?? null,
    });
  });

  app.post('/api/echo', (req, res) => {
    res.status(201).json({ received: req.body });
  });

  app.post('/api/upload', upload.single('attachment'), (req, res) => {
    res.status(200).json({
      filename: req.file?.originalname,
      content: req.file?.buffer.toString('utf8'),
    });
  });

  app.get('/api/search-stream', (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    res.write('event: result\ndata: {"hit":1}\n\n');
    res.write('event: done\ndata: {}\n\n');
    res.end();
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const session = await performWebCryptoClientHandshake(baseUrl);
    assert.match(session.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(process.env.E2E_IDENTITY_PATH), true);

    // 1. Encrypted GET with query string and Authorization header
    const getMeta: E2ERequestMeta = {
      method: 'GET',
      url: '/api/projects?filter=starred',
      headers: { authorization: 'Bearer secret-jwt' },
      ts: Date.now(),
    };
    const getCipher = encryptServerBytes(
      session.rawKeyBytes,
      packBinaryEnvelope(getMeta, Buffer.alloc(0)),
      `c2s:http:${session.kid}`,
    );
    const getRes = await fetch(`${baseUrl}/api/e2e`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-E2E-Kid': session.kid,
      },
      body: getCipher,
    });
    assert.equal(getRes.status, 200);
    const getDecrypted = decryptServerBytes(
      session.rawKeyBytes,
      Buffer.from(await getRes.arrayBuffer()),
      `s2c:http:${session.kid}`,
    );
    const getUnpacked = unpackBinaryEnvelope<E2EResponseMeta>(getDecrypted);
    assert.equal(getUnpacked.meta.status, 200);
    assert.equal(getUnpacked.meta.headers['x-refreshed-token'], 'refreshed-jwt-123');
    assert.deepEqual(JSON.parse(getUnpacked.body.toString('utf8')), {
      success: true,
      filter: 'starred',
      auth: 'Bearer secret-jwt',
    });

    // 2. Encrypted POST JSON returning 201
    const postBody = Buffer.from(JSON.stringify({ prompt: 'top secret prompt' }), 'utf8');
    const postMeta: E2ERequestMeta = {
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      ts: Date.now(),
    };
    const postCipher = encryptServerBytes(
      session.rawKeyBytes,
      packBinaryEnvelope(postMeta, postBody),
      `c2s:http:${session.kid}`,
    );
    const postRes = await fetch(`${baseUrl}/api/e2e`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-E2E-Kid': session.kid,
      },
      body: postCipher,
    });
    assert.equal(postRes.status, 200);
    const postDecrypted = decryptServerBytes(
      session.rawKeyBytes,
      Buffer.from(await postRes.arrayBuffer()),
      `s2c:http:${session.kid}`,
    );
    const postUnpacked = unpackBinaryEnvelope<E2EResponseMeta>(postDecrypted);
    assert.equal(postUnpacked.meta.status, 201);
    assert.deepEqual(JSON.parse(postUnpacked.body.toString('utf8')), {
      received: { prompt: 'top secret prompt' },
    });

    // 3. Encrypted multipart FormData upload handled by multer
    const form = new FormData();
    form.append('attachment', new Blob(['confidential payload']), 'secret.txt');
    const tempReq = new Request('http://localhost/api/upload', { method: 'POST', body: form });
    const multipartBytes = Buffer.from(await tempReq.arrayBuffer());
    const uploadMeta: E2ERequestMeta = {
      method: 'POST',
      url: '/api/upload',
      headers: { 'content-type': tempReq.headers.get('content-type') ?? '' },
      ts: Date.now(),
    };
    const uploadCipher = encryptServerBytes(
      session.rawKeyBytes,
      packBinaryEnvelope(uploadMeta, multipartBytes),
      `c2s:http:${session.kid}`,
    );
    const uploadRes = await fetch(`${baseUrl}/api/e2e`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-E2E-Kid': session.kid,
      },
      body: uploadCipher,
    });
    assert.equal(uploadRes.status, 200);
    const uploadDecrypted = decryptServerBytes(
      session.rawKeyBytes,
      Buffer.from(await uploadRes.arrayBuffer()),
      `s2c:http:${session.kid}`,
    );
    const uploadUnpacked = unpackBinaryEnvelope<E2EResponseMeta>(uploadDecrypted);
    assert.equal(uploadUnpacked.meta.status, 200);
    assert.deepEqual(JSON.parse(uploadUnpacked.body.toString('utf8')), {
      filename: 'secret.txt',
      content: 'confidential payload',
    });

    // 4. Encrypted SSE stream
    const sseMeta: E2ERequestMeta = {
      method: 'GET',
      url: '/api/search-stream',
      headers: { accept: 'text/event-stream' },
      ts: Date.now(),
    };
    const sseCipher = encryptServerBytes(
      session.rawKeyBytes,
      packBinaryEnvelope(sseMeta, Buffer.alloc(0)),
      `c2s:http:${session.kid}`,
    );
    const sseRes = await fetch(`${baseUrl}/api/e2e`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-E2E-Kid': session.kid,
      },
      body: sseCipher,
    });
    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers.get('x-e2e-stream'), 'sse');
    const sseStreamBytes = Buffer.from(await sseRes.arrayBuffer());
    let offset = 0;
    let sseSeq = 0;
    let sseCombined = '';
    while (offset < sseStreamBytes.length) {
      const frameLen = sseStreamBytes.readUInt32BE(offset);
      const frame = sseStreamBytes.subarray(offset + 4, offset + 4 + frameLen);
      offset += 4 + frameLen;
      const chunk = decryptServerBytes(
        session.rawKeyBytes,
        frame,
        `s2c:sse:${session.kid}:${sseSeq++}`,
      );
      sseCombined += chunk.toString('utf8');
    }
    assert.match(sseCombined, /event: result/);
    assert.match(sseCombined, /"hit":1/);
    assert.match(sseCombined, /event: done/);

    // 5. Unknown kid returns 425 Too Early
    const expiredRes = await fetch(`${baseUrl}/api/e2e`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-E2E-Kid': 'non-existent-kid',
      },
      body: getCipher,
    });
    assert.equal(expiredRes.status, 425);
  } finally {
    if (prevIdentityPath === undefined) {
      delete process.env.E2E_IDENTITY_PATH;
    } else {
      process.env.E2E_IDENTITY_PATH = prevIdentityPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('E2E WebSocket gateway authenticates encrypted upgrade token and encrypts bidirectional frames', async () => {
  const app = express();
  app.use(createE2EMiddleware(app));
  const httpServer = http.createServer(app);

  let receivedShellInit: Record<string, unknown> | null = null;

  createWebSocketServer(httpServer, {
    verifyClient: {
      isPlatform: false,
      authenticateWebSocket: (token) => (token === 'valid-jwt-token' ? { id: 1, username: 'pablo' } : null),
    },
    chat: {
      runtime: {
        hasRuntime: () => true,
        run: async () => undefined,
        abort: async () => false,
        resolveToolApproval: () => undefined,
        getPendingApprovalsForSession: () => [],
      },
    },
    shell: {
      resolveProviderSessionId: () => null,
    },
    getPluginPort: () => null,
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));

  let clientWs: WebSocket | null = null;
  try {
    const { port } = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const session = await performWebCryptoClientHandshake(baseUrl);

    const authPayload = Buffer.from(
      JSON.stringify({
        token: 'valid-jwt-token',
        path: '/ws',
        ts: Date.now(),
      }),
      'utf8',
    );
    const encryptedAuth = toBase64Url(
      encryptServerBytes(session.rawKeyBytes, authPayload, `c2s:ws-auth:${session.kid}`),
    );

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?e2e=${encodeURIComponent(session.kid)}&e2e_auth=${encodeURIComponent(encryptedAuth)}`,
    );
    clientWs = ws;

    await once(ws, 'open');

    // Send an encrypted frame (seq 0) asking for a non-existent session so the chat handler answers with protocol_error
    const frame0 = encryptServerBytes(
      session.rawKeyBytes,
      Buffer.from(JSON.stringify({ type: 'chat.send', sessionId: '' }), 'utf8'),
      `c2s:ws:${session.kid}:0`,
    );

    const replyPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('message', (data, isBinary) => {
        try {
          assert.equal(isBinary, true, 'Server must send binary encrypted frames');
          const rawBuf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          const decrypted = decryptServerBytes(session.rawKeyBytes, rawBuf, `s2c:ws:${session.kid}:0`);
          resolve(JSON.parse(decrypted.toString('utf8')) as Record<string, unknown>);
        } catch (err) {
          reject(err);
        }
      });
    });

    ws.send(frame0);
    const reply = await replyPromise;
    assert.equal(reply.kind, 'protocol_error');
    assert.equal(reply.code, 'SESSION_ID_REQUIRED');
    assert.equal(receivedShellInit, null);

    const closed = once(ws, 'close');
    ws.close();
    await closed;
  } finally {
    clientWs?.terminate();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});
