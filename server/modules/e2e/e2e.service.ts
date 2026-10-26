import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WebSocket } from 'ws';

const HANDSHAKE_CONTEXT = 'cloudcli-e2e-v1';
const HKDF_INFO = Buffer.from('cloudcli-e2e-v1-aes256gcm', 'utf8');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 1024;
const WS_AUTH_WINDOW_MS = 5 * 60 * 1000;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const P256_UNCOMPRESSED_POINT_BYTES = 65;

export type E2ESession = {
  kid: string;
  key: Buffer;
  createdAt: number;
  lastUsedAt: number;
};

export type E2EHandshakeResponse = {
  kid: string;
  serverEcdhPublicKey: string;
  identityPublicKey: string;
  identityFingerprint: string;
  signature: string;
};

export type E2ERequestMeta = {
  method: string;
  url: string;
  headers: Record<string, string>;
  ts?: number;
};

export type E2EResponseMeta = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
};

type StoredIdentityKey = {
  publicKeySpkiB64: string;
  privateKeyPkcs8B64: string;
  fingerprint: string;
  createdAt: string;
};

type LoadedIdentityKey = {
  publicKeySpkiB64: string;
  privateKey: crypto.KeyObject;
  fingerprint: string;
};

const sessions = new Map<string, E2ESession>();
let cachedIdentity: LoadedIdentityKey | null = null;
let cachedIdentityPath: string | null = null;

export function toBase64Url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function resolveIdentityKeyPath(): string {
  if (process.env.E2E_IDENTITY_PATH) {
    return process.env.E2E_IDENTITY_PATH;
  }
  const baseDir = process.env.DATABASE_PATH
    ? path.dirname(process.env.DATABASE_PATH)
    : path.join(os.homedir(), '.cloudcli');
  return path.join(baseDir, 'e2e-identity.json');
}

function computeSpkiFingerprint(spkiDer: Buffer): string {
  return crypto.createHash('sha256').update(spkiDer).digest('hex');
}

export function getOrCreateServerIdentity(): LoadedIdentityKey {
  const identityPath = resolveIdentityKeyPath();
  if (cachedIdentity && cachedIdentityPath === identityPath) {
    return cachedIdentity;
  }

  try {
    if (fs.existsSync(identityPath)) {
      const raw = JSON.parse(fs.readFileSync(identityPath, 'utf8')) as StoredIdentityKey;
      const spkiDer = fromBase64Url(raw.publicKeySpkiB64);
      const pkcs8Der = fromBase64Url(raw.privateKeyPkcs8B64);
      const privateKey = crypto.createPrivateKey({
        key: pkcs8Der,
        format: 'der',
        type: 'pkcs8',
      });
      const fingerprint = computeSpkiFingerprint(spkiDer);
      cachedIdentity = {
        publicKeySpkiB64: raw.publicKeySpkiB64,
        privateKey,
        fingerprint,
      };
      cachedIdentityPath = identityPath;
      return cachedIdentity;
    }
  } catch (error) {
    console.warn('[E2E] Failed to load existing identity key, generating a fresh one:', (error as Error).message);
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pkcs8Der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const publicKeySpkiB64 = toBase64Url(spkiDer);
  const privateKeyPkcs8B64 = toBase64Url(pkcs8Der);
  const fingerprint = computeSpkiFingerprint(spkiDer);

  try {
    fs.mkdirSync(path.dirname(identityPath), { recursive: true });
    const stored: StoredIdentityKey = {
      publicKeySpkiB64,
      privateKeyPkcs8B64,
      fingerprint,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(identityPath, JSON.stringify(stored, null, 2), { mode: 0o600 });
  } catch (error) {
    console.warn('[E2E] Could not persist identity key to disk (using in-memory key):', (error as Error).message);
  }

  cachedIdentity = {
    publicKeySpkiB64,
    privateKey,
    fingerprint,
  };
  cachedIdentityPath = identityPath;
  return cachedIdentity;
}

function pruneSessions(now = Date.now()): void {
  for (const [kid, session] of sessions.entries()) {
    if (now - session.lastUsedAt > SESSION_TTL_MS) {
      sessions.delete(kid);
    }
  }
  while (sessions.size >= MAX_ACTIVE_SESSIONS) {
    const oldestKey = sessions.keys().next().value;
    if (!oldestKey) break;
    sessions.delete(oldestKey);
  }
}

export function getE2ESession(kid: string | null | undefined): E2ESession | null {
  if (!kid) return null;
  const session = sessions.get(kid);
  if (!session) return null;
  const now = Date.now();
  if (now - session.lastUsedAt > SESSION_TTL_MS) {
    sessions.delete(kid);
    return null;
  }
  session.lastUsedAt = now;
  return session;
}

export function performE2EHandshake(clientEcdhPublicKeyB64: string): E2EHandshakeResponse {
  if (!clientEcdhPublicKeyB64 || typeof clientEcdhPublicKeyB64 !== 'string') {
    throw new Error('Missing clientEcdhPublicKey');
  }

  const clientPubRaw = fromBase64Url(clientEcdhPublicKeyB64);
  if (clientPubRaw.length !== P256_UNCOMPRESSED_POINT_BYTES || clientPubRaw[0] !== 0x04) {
    throw new Error('Invalid P-256 uncompressed public key');
  }

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const serverPubRaw = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(clientPubRaw);

  const salt = crypto.createHash('sha256')
    .update(clientPubRaw)
    .update(serverPubRaw)
    .digest();

  const aesKey = Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, salt, HKDF_INFO, 32),
  );

  const identity = getOrCreateServerIdentity();
  const transcript = Buffer.concat([
    Buffer.from(HANDSHAKE_CONTEXT, 'utf8'),
    clientPubRaw,
    serverPubRaw,
  ]);
  const signature = crypto.sign('sha256', transcript, {
    key: identity.privateKey,
    dsaEncoding: 'ieee-p1363',
  });

  pruneSessions();
  const kid = toBase64Url(crypto.randomBytes(16));
  const now = Date.now();
  sessions.set(kid, {
    kid,
    key: aesKey,
    createdAt: now,
    lastUsedAt: now,
  });

  return {
    kid,
    serverEcdhPublicKey: toBase64Url(serverPubRaw),
    identityPublicKey: identity.publicKeySpkiB64,
    identityFingerprint: identity.fingerprint,
    signature: toBase64Url(signature),
  };
}

export function encryptServerBytes(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = cipher.update(plaintext);
  const finalBuf = cipher.final();
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, finalBuf, tag]);
}

export function decryptServerBytes(key: Buffer, wireFrame: Buffer, aad: string): Buffer {
  if (wireFrame.length < GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new Error('Ciphertext frame too short');
  }
  const iv = wireFrame.subarray(0, GCM_IV_BYTES);
  const tag = wireFrame.subarray(wireFrame.length - GCM_TAG_BYTES);
  const ciphertext = wireFrame.subarray(GCM_IV_BYTES, wireFrame.length - GCM_TAG_BYTES);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function packBinaryEnvelope<TMeta>(meta: TMeta, body: Buffer): Buffer {
  const metaBytes = Buffer.from(JSON.stringify(meta), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(metaBytes.length, 0);
  return Buffer.concat([header, metaBytes, body]);
}

export function unpackBinaryEnvelope<TMeta>(packed: Buffer): { meta: TMeta; body: Buffer } {
  if (packed.length < 4) {
    throw new Error('Envelope too short');
  }
  const metaLength = packed.readUInt32BE(0);
  if (metaLength < 2 || 4 + metaLength > packed.length) {
    throw new Error('Invalid envelope metadata length');
  }
  const metaJson = packed.subarray(4, 4 + metaLength).toString('utf8');
  const meta = JSON.parse(metaJson) as TMeta;
  const body = packed.subarray(4 + metaLength);
  return { meta, body };
}

export function packLengthPrefixedFrame(frame: Buffer): Buffer {
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(frame.length, 0);
  return Buffer.concat([prefix, frame]);
}

export type DecryptedWsUpgradeAuth = {
  session: E2ESession;
  token: string | null;
  path: string | null;
};

export function authenticateE2EWebSocketUpgrade(
  kid: string | null,
  encryptedAuthB64: string | null,
): DecryptedWsUpgradeAuth | null {
  const session = getE2ESession(kid);
  if (!session || !encryptedAuthB64) {
    return null;
  }
  try {
    const cipherBuf = fromBase64Url(encryptedAuthB64);
    const plainBuf = decryptServerBytes(session.key, cipherBuf, `c2s:ws-auth:${session.kid}`);
    const parsed = JSON.parse(plainBuf.toString('utf8')) as {
      token?: string | null;
      path?: string | null;
      ts?: number;
    };
    if (typeof parsed.ts !== 'number' || Math.abs(Date.now() - parsed.ts) > WS_AUTH_WINDOW_MS) {
      console.warn('[E2E] WebSocket upgrade auth timestamp outside allowed window');
      return null;
    }
    return {
      session,
      token: typeof parsed.token === 'string' ? parsed.token : null,
      path: typeof parsed.path === 'string' && parsed.path.startsWith('/') ? parsed.path : null,
    };
  } catch (error) {
    console.warn('[E2E] Failed to decrypt WebSocket upgrade auth:', (error as Error).message);
    return null;
  }
}

/**
 * Wraps a server-side `ws` WebSocket instance in-place so all application
 * frames sent via `ws.send` and received via `ws.on('message')` are
 * transparently encrypted/decrypted with AES-256-GCM and monotonic sequence
 * counters.
 */
export function wrapServerWebSocketWithE2E(ws: WebSocket, session: E2ESession): void {
  let s2cSeq = 0;
  let c2sSeq = 0;

  const origSend = ws.send.bind(ws);
  ws.send = ((data: unknown, optionsOrCb?: unknown, cb?: (err?: Error) => void) => {
    const callback = typeof optionsOrCb === 'function'
      ? (optionsOrCb as (err?: Error) => void)
      : cb;
    try {
      const plainBuf = Buffer.isBuffer(data)
        ? data
        : typeof data === 'string'
          ? Buffer.from(data, 'utf8')
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : ArrayBuffer.isView(data)
              ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
              : Buffer.from(String(data ?? ''), 'utf8');
      const seq = s2cSeq++;
      const encrypted = encryptServerBytes(session.key, plainBuf, `s2c:ws:${session.kid}:${seq}`);
      return origSend(encrypted, { binary: true }, callback);
    } catch (error) {
      if (callback) callback(error as Error);
      return;
    }
  }) as typeof ws.send;

  const origEmit = ws.emit.bind(ws);
  ws.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === 'message') {
      try {
        const rawData = args[0];
        const cipherBuf = Buffer.isBuffer(rawData)
          ? rawData
          : rawData instanceof ArrayBuffer
            ? Buffer.from(rawData)
            : Array.isArray(rawData)
              ? Buffer.concat(rawData)
              : Buffer.from(String(rawData ?? ''), 'utf8');
        const seq = c2sSeq++;
        const decrypted = decryptServerBytes(session.key, cipherBuf, `c2s:ws:${session.kid}:${seq}`);
        return origEmit('message', decrypted, false);
      } catch (error) {
        console.warn('[E2E] WebSocket frame decryption failed:', (error as Error).message);
        ws.close(1008, 'E2E decryption failed');
        return false;
      }
    }
    return origEmit(event, ...args);
  }) as typeof ws.emit;
}
