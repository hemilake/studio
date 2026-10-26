/**
 * Application-layer End-to-End Encryption (E2EE) transport for Hemilake Studio.
 *
 * TLS-inspecting corporate proxies (such as Netskope) terminate HTTPS and WSS
 * using a local Root CA and inspect HTTP URLs, headers, bodies, and WebSocket
 * frames in plaintext. This module negotiates an ephemeral ECDH P-256 session
 * authenticated by the server's persistent ECDSA P-256 identity key, derives a
 * 256-bit AES-GCM key via HKDF-SHA256, and transparently tunnels:
 * - all `/api/*` HTTP requests and responses (JSON, FormData uploads, blobs)
 *   through `POST /api/e2e` as opaque `application/octet-stream` payloads
 * - all `/api/*` SSE streams (`EventSource`) as length-prefixed AES-GCM frames
 * - all WebSocket upgrades and frames (`/ws`, `/shell`, `/desktop-notifications`,
 *   `/plugin-ws/*`) with encrypted upgrade tokens and per-frame sequence AADs.
 */

const HANDSHAKE_CONTEXT = 'cloudcli-e2e-v1';
const HKDF_INFO = 'cloudcli-e2e-v1-aes256gcm';
const PINNED_FINGERPRINT_KEY = 'cloudcli:e2e:server-fingerprint';
const STRICT_PIN_KEY = 'cloudcli:e2e:strict-pin';
const STATUS_EVENT_NAME = 'cloudcli:e2e-status';
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export type E2EClientStatus = {
  active: boolean;
  kid: string | null;
  fingerprint: string | null;
  establishedAt: number | null;
};

type ActiveClientE2ESession = {
  kid: string;
  key: CryptoKey;
  fingerprint: string;
  establishedAt: number;
};

type E2EHandshakeWireResponse = {
  kid: string;
  serverEcdhPublicKey: string;
  identityPublicKey: string;
  identityFingerprint: string;
  signature: string;
};

type E2ERequestMeta = {
  method: string;
  url: string;
  headers: Record<string, string>;
  ts: number;
};

type E2EResponseMeta = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
};

let currentSession: ActiveClientE2ESession | null = null;
let handshakePromise: Promise<ActiveClientE2ESession | null> | null = null;
let interceptorsInstalled = false;
let nativeFetchRef: typeof fetch | null = null;
let nativeWebSocketRef: typeof WebSocket | null = null;
let nativeEventSourceRef: typeof EventSource | null = null;

function getSubtleCrypto(): SubtleCrypto | null {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    return globalThis.crypto.subtle;
  }
  return null;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function packBinaryEnvelope<TMeta>(meta: TMeta, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + metaBytes.byteLength + body.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, metaBytes.byteLength, false);
  out.set(metaBytes, 4);
  out.set(body, 4 + metaBytes.byteLength);
  return out;
}

export function unpackBinaryEnvelope<TMeta>(packed: Uint8Array): { meta: TMeta; body: Uint8Array<ArrayBuffer> } {
  if (packed.byteLength < 4) {
    throw new Error('E2E envelope too short');
  }
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const metaLen = view.getUint32(0, false);
  if (metaLen < 2 || 4 + metaLen > packed.byteLength) {
    throw new Error('Invalid E2E envelope header length');
  }
  const metaJson = new TextDecoder().decode(packed.subarray(4, 4 + metaLen));
  const meta = JSON.parse(metaJson) as TMeta;
  const body = new Uint8Array(packed.subarray(4 + metaLen));
  return { meta, body };
}

export async function encryptClientBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const subtle = getSubtleCrypto();
  if (!subtle) {
    throw new Error('WebCrypto subtle API unavailable');
  }
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const aadBytes = new TextEncoder().encode(aad);
  const cipherBuffer = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aadBytes as BufferSource,
      tagLength: GCM_TAG_BYTES * 8,
    },
    key,
    plaintext as BufferSource,
  );
  return concatUint8Arrays([iv, new Uint8Array(cipherBuffer)]);
}

export async function decryptClientBytes(
  key: CryptoKey,
  wireFrame: Uint8Array,
  aad: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const subtle = getSubtleCrypto();
  if (!subtle) {
    throw new Error('WebCrypto subtle API unavailable');
  }
  if (wireFrame.byteLength < GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new Error('E2E ciphertext too short');
  }
  const iv = wireFrame.subarray(0, GCM_IV_BYTES);
  const ciphertextAndTag = wireFrame.subarray(GCM_IV_BYTES);
  const aadBytes = new TextEncoder().encode(aad);
  const plainBuffer = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      additionalData: aadBytes as BufferSource,
      tagLength: GCM_TAG_BYTES * 8,
    },
    key,
    ciphertextAndTag as BufferSource,
  );
  return new Uint8Array(plainBuffer);
}

function notifyStatusChange(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(STATUS_EVENT_NAME, { detail: getE2EStatus() }));
  } catch {
    // Ignore in environments without CustomEvent
  }
}

export function getE2EStatus(): E2EClientStatus {
  if (!currentSession) {
    return {
      active: false,
      kid: null,
      fingerprint: null,
      establishedAt: null,
    };
  }
  return {
    active: true,
    kid: currentSession.kid,
    fingerprint: currentSession.fingerprint,
    establishedAt: currentSession.establishedAt,
  };
}

export function subscribeE2EStatus(listener: (status: E2EClientStatus) => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  const handler = () => listener(getE2EStatus());
  window.addEventListener(STATUS_EVENT_NAME, handler);
  return () => window.removeEventListener(STATUS_EVENT_NAME, handler);
}

function consumeUrlHashFingerprintPin(): void {
  if (typeof window === 'undefined' || !window.location.hash) return;
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);
  const fp = params.get('e2e_fp')?.trim().toLowerCase().replace(/^sha256:/, '');
  if (fp && /^[0-9a-f]{64}$/.test(fp)) {
    try {
      localStorage.setItem(PINNED_FINGERPRINT_KEY, fp);
      localStorage.setItem(STRICT_PIN_KEY, '1');
      params.delete('e2e_fp');
      const remaining = params.toString();
      const newUrl = `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`;
      window.history.replaceState(null, '', newUrl);
    } catch {
      // Ignore storage failures
    }
  }
}

export function invalidateE2ESession(kid?: string): void {
  if (!kid || currentSession?.kid === kid) {
    currentSession = null;
    notifyStatusChange();
  }
}

async function performClientHandshake(): Promise<ActiveClientE2ESession | null> {
  const subtle = getSubtleCrypto();
  const baseFetch = nativeFetchRef ?? globalThis.fetch?.bind(globalThis);
  if (!subtle || !baseFetch) {
    return null;
  }

  consumeUrlHashFingerprintPin();

  const clientKeyPair = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const clientPubRaw = new Uint8Array(await subtle.exportKey('raw', clientKeyPair.publicKey));

  const response = await baseFetch('/api/e2e/handshake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientEcdhPublicKey: toBase64Url(clientPubRaw),
    }),
    cache: 'no-store',
    credentials: 'same-origin',
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as E2EHandshakeWireResponse;
  if (!data?.kid || !data?.serverEcdhPublicKey || !data?.identityPublicKey || !data?.signature) {
    throw new Error('Malformed E2E handshake response');
  }

  const serverPubRaw = fromBase64Url(data.serverEcdhPublicKey);
  const identitySpkiBytes = fromBase64Url(data.identityPublicKey);
  const signatureBytes = fromBase64Url(data.signature);

  const computedDigest = new Uint8Array(await subtle.digest('SHA-256', identitySpkiBytes));
  const computedFingerprint = toHex(computedDigest);

  const identityVerifyKey = await subtle.importKey(
    'spki',
    identitySpkiBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );

  const transcript = concatUint8Arrays([
    new TextEncoder().encode(HANDSHAKE_CONTEXT),
    clientPubRaw,
    serverPubRaw,
  ]);

  const signatureValid = await subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    identityVerifyKey,
    signatureBytes,
    transcript,
  );
  if (!signatureValid) {
    throw new Error('E2E handshake signature verification failed');
  }

  try {
    const pinned = localStorage.getItem(PINNED_FINGERPRINT_KEY);
    const strictPin = localStorage.getItem(STRICT_PIN_KEY) === '1';
    if (!pinned) {
      localStorage.setItem(PINNED_FINGERPRINT_KEY, computedFingerprint);
    } else if (pinned !== computedFingerprint) {
      if (strictPin) {
        throw new Error(
          `E2E server key fingerprint mismatch (expected ${pinned.slice(0, 12)}…, got ${computedFingerprint.slice(0, 12)}…)`,
        );
      }
      localStorage.setItem(PINNED_FINGERPRINT_KEY, computedFingerprint);
    }
  } catch (error) {
    if ((error as Error).message?.includes('fingerprint mismatch')) {
      throw error;
    }
  }

  const serverEcdhPubKey = await subtle.importKey(
    'raw',
    serverPubRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  const sharedSecretBits = await subtle.deriveBits(
    { name: 'ECDH', public: serverEcdhPubKey },
    clientKeyPair.privateKey,
    256,
  );

  const salt = new Uint8Array(
    await subtle.digest('SHA-256', concatUint8Arrays([clientPubRaw, serverPubRaw])),
  );

  const hkdfBaseKey = await subtle.importKey(
    'raw',
    sharedSecretBits,
    'HKDF',
    false,
    ['deriveKey'],
  );

  const aesKey = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode(HKDF_INFO),
    },
    hkdfBaseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  const session: ActiveClientE2ESession = {
    kid: data.kid,
    key: aesKey,
    fingerprint: computedFingerprint,
    establishedAt: Date.now(),
  };
  currentSession = session;
  notifyStatusChange();
  return session;
}

export async function ensureE2ESession(forceRefresh = false): Promise<ActiveClientE2ESession | null> {
  if (!forceRefresh && currentSession) {
    return currentSession;
  }
  if (!forceRefresh && handshakePromise) {
    return handshakePromise;
  }
  handshakePromise = performClientHandshake()
    .catch((error) => {
      console.warn('[E2E] Handshake failed:', (error as Error).message);
      return null;
    })
    .finally(() => {
      handshakePromise = null;
    });
  return handshakePromise;
}

function shouldTunnelApiUrl(rawUrl: string): { tunnel: boolean; parsedUrl: URL | null } {
  if (typeof window === 'undefined') {
    return { tunnel: false, parsedUrl: null };
  }
  try {
    const parsed = new URL(rawUrl, window.location.origin);
    if (parsed.origin !== window.location.origin) {
      return { tunnel: false, parsedUrl: parsed };
    }
    const pathname = parsed.pathname;
    if (!pathname.startsWith('/api/')) {
      return { tunnel: false, parsedUrl: parsed };
    }
    if (pathname === '/api/e2e' || pathname.startsWith('/api/e2e/') || pathname.startsWith('/api/public/shares/')) {
      return { tunnel: false, parsedUrl: parsed };
    }
    return { tunnel: true, parsedUrl: parsed };
  } catch {
    return { tunnel: false, parsedUrl: null };
  }
}

async function executeTunneledFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  isRetry = false,
): Promise<Response> {
  const baseFetch = nativeFetchRef!;
  const session = await ensureE2ESession();
  if (!session) {
    return baseFetch(input, init);
  }

  const req = new Request(input, init);
  const parsed = new URL(req.url, window.location.origin);
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const bodyBytes = req.method !== 'GET' && req.method !== 'HEAD'
    ? new Uint8Array(await req.arrayBuffer())
    : new Uint8Array(0);

  const meta: E2ERequestMeta = {
    method: req.method,
    url: `${parsed.pathname}${parsed.search}`,
    headers,
    ts: Date.now(),
  };

  const packedRequest = packBinaryEnvelope(meta, bodyBytes);
  const encryptedRequest = await encryptClientBytes(
    session.key,
    packedRequest,
    `c2s:http:${session.kid}`,
  );

  const outerResponse = await baseFetch('/api/e2e', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-E2E-Kid': session.kid,
    },
    body: encryptedRequest,
    signal: init?.signal ?? req.signal,
    credentials: 'same-origin',
    cache: 'no-store',
  });

  if (outerResponse.status === 425 && !isRetry) {
    invalidateE2ESession(session.kid);
    await ensureE2ESession(true);
    return executeTunneledFetch(input, init, true);
  }

  if (!outerResponse.ok) {
    return outerResponse;
  }

  const encryptedResponseBytes = new Uint8Array(await outerResponse.arrayBuffer());
  const decryptedResponseBytes = await decryptClientBytes(
    session.key,
    encryptedResponseBytes,
    `s2c:http:${session.kid}`,
  );
  const { meta: resMeta, body: resBody } = unpackBinaryEnvelope<E2EResponseMeta>(decryptedResponseBytes);

  return new Response(resBody, {
    status: resMeta.status,
    statusText: resMeta.statusText,
    headers: resMeta.headers,
  });
}

/**
 * E2E-encrypted replacement for `EventSource` that tunnels `/api/*` SSE streams
 * over `POST /api/e2e` and decrypts length-prefixed AES-256-GCM frames as they
 * arrive.
 */
class E2EEventSource extends EventTarget {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSED = 2 as const;

  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSED = 2 as const;

  readonly url: string;
  readonly withCredentials: boolean;
  readyState: number = E2EEventSource.CONNECTING;

  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;

  #abortController = new AbortController();
  #nativeFallback: EventSource | null = null;

  constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
    super();
    this.url = String(url);
    this.withCredentials = Boolean(eventSourceInitDict?.withCredentials);

    const { tunnel, parsedUrl } = shouldTunnelApiUrl(this.url);
    if (!tunnel || !parsedUrl) {
      const NativeES = nativeEventSourceRef!;
      const es = new NativeES(url, eventSourceInitDict);
      this.#nativeFallback = es;
      return es as unknown as E2EEventSource;
    }

    void this.#startStream(parsedUrl);
  }

  async #startStream(parsedUrl: URL, isRetry = false): Promise<void> {
    try {
      const baseFetch = nativeFetchRef!;
      const session = await ensureE2ESession();
      if (!session) {
        this.#fail();
        return;
      }

      const meta: E2ERequestMeta = {
        method: 'GET',
        url: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers: {
          accept: 'text/event-stream',
        },
        ts: Date.now(),
      };

      const packed = packBinaryEnvelope(meta, new Uint8Array(0));
      const encrypted = await encryptClientBytes(session.key, packed, `c2s:http:${session.kid}`);

      const response = await baseFetch('/api/e2e', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-E2E-Kid': session.kid,
        },
        body: encrypted,
        signal: this.#abortController.signal,
        credentials: 'same-origin',
        cache: 'no-store',
      });

      if (response.status === 425 && !isRetry) {
        invalidateE2ESession(session.kid);
        await ensureE2ESession(true);
        await this.#startStream(parsedUrl, true);
        return;
      }

      if (!response.ok || !response.body) {
        this.#fail();
        return;
      }

      this.readyState = E2EEventSource.OPEN;
      const openEvent = new Event('open');
      this.onopen?.call(this as unknown as EventSource, openEvent);
      this.dispatchEvent(openEvent);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let frameBuffer: Uint8Array = new Uint8Array(0);
      let sseTextBuffer = '';
      let sseSeq = 0;

      while (this.readyState !== E2EEventSource.CLOSED) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          frameBuffer = concatUint8Arrays([frameBuffer, value]);
        }

        while (frameBuffer.byteLength >= 4) {
          const view = new DataView(
            frameBuffer.buffer,
            frameBuffer.byteOffset,
            frameBuffer.byteLength,
          );
          const frameLen = view.getUint32(0, false);
          if (frameBuffer.byteLength < 4 + frameLen) {
            break;
          }
          const encryptedFrame = frameBuffer.subarray(4, 4 + frameLen);
          frameBuffer = frameBuffer.subarray(4 + frameLen);

          const decryptedChunk = await decryptClientBytes(
            session.key,
            encryptedFrame,
            `s2c:sse:${session.kid}:${sseSeq++}`,
          );
          sseTextBuffer += decoder.decode(decryptedChunk, { stream: true });
          sseTextBuffer = this.#consumeSseBlocks(sseTextBuffer);
        }
      }

      if (this.readyState !== E2EEventSource.CLOSED) {
        this.#fail();
      }
    } catch {
      if (this.readyState !== E2EEventSource.CLOSED) {
        this.#fail();
      }
    }
  }

  #consumeSseBlocks(buffer: string): string {
    const normalized = buffer.replace(/\r\n/g, '\n');
    const blocks = normalized.split('\n\n');
    const remainder = blocks.pop() ?? '';

    for (const block of blocks) {
      if (!block.trim()) continue;
      let eventType = 'message';
      const dataLines: string[] = [];

      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim() || 'message';
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }

      if (dataLines.length === 0) continue;
      const msgEvent = new MessageEvent(eventType, {
        data: dataLines.join('\n'),
        origin: window.location.origin,
      });
      if (eventType === 'message') {
        this.onmessage?.call(this as unknown as EventSource, msgEvent);
      }
      this.dispatchEvent(msgEvent);
    }

    return remainder;
  }

  #fail(): void {
    this.readyState = E2EEventSource.CLOSED;
    const errEvent = new Event('error');
    this.onerror?.call(this as unknown as EventSource, errEvent);
    this.dispatchEvent(errEvent);
  }

  close(): void {
    if (this.#nativeFallback) {
      this.#nativeFallback.close();
      return;
    }
    this.readyState = E2EEventSource.CLOSED;
    this.#abortController.abort();
  }
}

async function toBytesFromWsData(data: unknown): Promise<Uint8Array> {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return new TextEncoder().encode(String(data ?? ''));
}

/**
 * E2E-encrypted replacement for `WebSocket` that hides both the JWT token and
 * target path (`/ws`, `/shell`, etc.) inside an AES-256-GCM upgrade token and
 * encrypts every bidirectional frame with monotonic sequence numbers.
 */
class E2EWebSocket extends EventTarget {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSING = 2 as const;
  static readonly CLOSED = 3 as const;

  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSING = 2 as const;
  readonly CLOSED = 3 as const;

  readonly url: string;
  binaryType: BinaryType = 'blob';
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;

  #raw: WebSocket | null = null;
  #closedBeforeRaw = false;
  #c2sSeq = 0;
  #s2cSeq = 0;
  #sendChain: Promise<void> = Promise.resolve();
  #recvChain: Promise<void> = Promise.resolve();

  constructor(url: string | URL, protocols?: string | string[]) {
    super();
    this.url = String(url);

    const NativeWS = nativeWebSocketRef!;
    let parsed: URL | null = null;
    try {
      parsed = new URL(this.url, window.location.href);
    } catch {
      parsed = null;
    }

    if (!parsed || parsed.host !== window.location.host) {
      const ws = protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
      this.#raw = ws;
      return ws as unknown as E2EWebSocket;
    }

    void this.#connectEncrypted(parsed, protocols);
  }

  get readyState(): number {
    if (this.#closedBeforeRaw) {
      return E2EWebSocket.CLOSED;
    }
    if (!this.#raw) {
      return E2EWebSocket.CONNECTING;
    }
    return this.#raw.readyState;
  }

  get bufferedAmount(): number {
    return this.#raw?.bufferedAmount ?? 0;
  }

  get extensions(): string {
    return this.#raw?.extensions ?? '';
  }

  get protocol(): string {
    return this.#raw?.protocol ?? '';
  }

  async #connectEncrypted(parsedUrl: URL, protocols?: string | string[]): Promise<void> {
    const NativeWS = nativeWebSocketRef!;
    try {
      const session = await ensureE2ESession();
      if (this.#closedBeforeRaw) {
        return;
      }

      if (!session) {
        const plainWs = protocols !== undefined
          ? new NativeWS(parsedUrl.toString(), protocols)
          : new NativeWS(parsedUrl.toString());
        this.#bindPlainSocket(plainWs);
        return;
      }

      const token = parsedUrl.searchParams.get('token');
      const authPayload = new TextEncoder().encode(
        JSON.stringify({
          token,
          path: parsedUrl.pathname,
          ts: Date.now(),
        }),
      );
      const encryptedAuth = await encryptClientBytes(
        session.key,
        authPayload,
        `c2s:ws-auth:${session.kid}`,
      );
      if (this.#closedBeforeRaw) {
        return;
      }

      const wireUrl = `${parsedUrl.protocol}//${parsedUrl.host}/ws?e2e=${encodeURIComponent(session.kid)}&e2e_auth=${encodeURIComponent(toBase64Url(encryptedAuth))}`;
      const raw = protocols !== undefined ? new NativeWS(wireUrl, protocols) : new NativeWS(wireUrl);
      raw.binaryType = 'arraybuffer';
      this.#raw = raw;

      let opened = false;

      raw.onopen = (ev) => {
        opened = true;
        this.onopen?.call(this as unknown as WebSocket, ev);
        this.dispatchEvent(new Event('open'));
      };

      raw.onmessage = (ev) => {
        const seq = this.#s2cSeq++;
        const rawData = ev.data;
        this.#recvChain = this.#recvChain
          .then(async () => {
            if (this.#closedBeforeRaw) return;
            const cipherBytes = await toBytesFromWsData(rawData);
            const plainBytes = await decryptClientBytes(
              session.key,
              cipherBytes,
              `s2c:ws:${session.kid}:${seq}`,
            );
            const text = new TextDecoder().decode(plainBytes);
            const msgEvent = new MessageEvent('message', {
              data: text,
              origin: ev.origin,
            });
            this.onmessage?.call(this as unknown as WebSocket, msgEvent);
            this.dispatchEvent(msgEvent);
          })
          .catch((error) => {
            console.warn('[E2E] Failed to decrypt WebSocket message:', (error as Error).message);
            raw.close(1008, 'E2E decrypt error');
          });
      };

      raw.onclose = (ev) => {
        if (!opened) {
          // If the upgrade was rejected (e.g. server restarted and lost in-memory E2E session),
          // refresh the E2E session now so the caller's reconnect succeeds immediately.
          invalidateE2ESession(session.kid);
          void ensureE2ESession(true);
        }
        this.#recvChain = this.#recvChain.finally(() => {
          const closeEvent = new CloseEvent('close', {
            code: ev.code,
            reason: ev.reason,
            wasClean: ev.wasClean,
          });
          this.onclose?.call(this as unknown as WebSocket, closeEvent);
          this.dispatchEvent(closeEvent);
        });
      };

      raw.onerror = (ev) => {
        this.onerror?.call(this as unknown as WebSocket, ev);
        this.dispatchEvent(new Event('error'));
      };
    } catch {
      const errEvent = new Event('error');
      this.onerror?.call(this as unknown as WebSocket, errEvent);
      this.dispatchEvent(errEvent);
      const closeEvent = new CloseEvent('close', { code: 1006, reason: '', wasClean: false });
      this.onclose?.call(this as unknown as WebSocket, closeEvent);
      this.dispatchEvent(closeEvent);
    }
  }

  #bindPlainSocket(raw: WebSocket): void {
    this.#raw = raw;
    raw.onopen = (ev) => {
      this.onopen?.call(this as unknown as WebSocket, ev);
      this.dispatchEvent(new Event('open'));
    };
    raw.onmessage = (ev) => {
      const msgEvent = new MessageEvent('message', { data: ev.data, origin: ev.origin });
      this.onmessage?.call(this as unknown as WebSocket, msgEvent);
      this.dispatchEvent(msgEvent);
    };
    raw.onclose = (ev) => {
      const closeEvent = new CloseEvent('close', {
        code: ev.code,
        reason: ev.reason,
        wasClean: ev.wasClean,
      });
      this.onclose?.call(this as unknown as WebSocket, closeEvent);
      this.dispatchEvent(closeEvent);
    };
    raw.onerror = (ev) => {
      this.onerror?.call(this as unknown as WebSocket, ev);
      this.dispatchEvent(new Event('error'));
    };
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const session = currentSession;
    const raw = this.#raw;
    if (!raw || raw.readyState !== E2EWebSocket.OPEN) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError');
    }
    if (!session) {
      raw.send(data);
      return;
    }

    const seq = this.#c2sSeq++;
    this.#sendChain = this.#sendChain
      .then(async () => {
        if (!this.#raw || this.#raw.readyState !== E2EWebSocket.OPEN) {
          return;
        }
        const plainBytes = await toBytesFromWsData(data);
        const encrypted = await encryptClientBytes(
          session.key,
          plainBytes,
          `c2s:ws:${session.kid}:${seq}`,
        );
        if (this.#raw && this.#raw.readyState === E2EWebSocket.OPEN) {
          this.#raw.send(encrypted);
        }
      })
      .catch((error) => {
        console.warn('[E2E] Failed to encrypt WebSocket message:', (error as Error).message);
      });
  }

  close(code?: number, reason?: string): void {
    this.#closedBeforeRaw = true;
    if (this.#raw) {
      this.#raw.close(code, reason);
    }
  }
}

export type E2EXhrUploadResult = {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
};

/**
 * Sends a `FormData` upload through `POST /api/e2e` using `XMLHttpRequest` so
 * upload progress events (`xhr.upload.onprogress`) continue to work while the
 * target path, filenames, and file contents remain encrypted on the wire.
 */
export async function sendE2EXhrUpload(options: {
  url: string;
  headers: Record<string, string>;
  formData: FormData;
  onProgress: (percent: number) => void;
}): Promise<E2EXhrUploadResult | null> {
  const session = await ensureE2ESession();
  if (!session) {
    return null;
  }

  const parsed = new URL(options.url, window.location.origin);
  const tempReq = new Request(parsed.toString(), {
    method: 'POST',
    headers: options.headers,
    body: options.formData,
  });
  const reqHeaders: Record<string, string> = {};
  tempReq.headers.forEach((v, k) => {
    reqHeaders[k] = v;
  });
  const bodyBytes = new Uint8Array(await tempReq.arrayBuffer());
  const meta: E2ERequestMeta = {
    method: 'POST',
    url: `${parsed.pathname}${parsed.search}`,
    headers: reqHeaders,
    ts: Date.now(),
  };

  const packed = packBinaryEnvelope(meta, bodyBytes);
  const encrypted = await encryptClientBytes(session.key, packed, `c2s:http:${session.kid}`);

  return new Promise<E2EXhrUploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/e2e');
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-E2E-Kid', session.kid);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      options.onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };

    xhr.onload = () => {
      void (async () => {
        try {
          if (xhr.status === 425) {
            invalidateE2ESession(session.kid);
            await ensureE2ESession(true);
            const retried = await sendE2EXhrUpload(options);
            if (retried) {
              resolve(retried);
              return;
            }
          }
          const buf = new Uint8Array(xhr.response as ArrayBuffer);
          const decrypted = await decryptClientBytes(session.key, buf, `s2c:http:${session.kid}`);
          const { meta: resMeta, body: resBody } = unpackBinaryEnvelope<E2EResponseMeta>(decrypted);
          resolve({
            status: resMeta.status,
            headers: resMeta.headers,
            bodyText: new TextDecoder().decode(resBody),
          });
        } catch (error) {
          reject(error);
        }
      })();
    };

    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new Error('Upload canceled.'));
    xhr.send(encrypted);
  });
}

/**
 * Installs the E2E transport interceptors (`fetch`, `EventSource`, `WebSocket`)
 * and negotiates the initial ECDH P-256 session before the React tree mounts.
 */
export async function initE2ETransport(): Promise<void> {
  if (typeof window === 'undefined' || !getSubtleCrypto()) {
    return;
  }

  if (!interceptorsInstalled) {
    interceptorsInstalled = true;
    nativeFetchRef = window.fetch.bind(window);
    nativeWebSocketRef = window.WebSocket;
    nativeEventSourceRef = window.EventSource;

    window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const rawUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const { tunnel } = shouldTunnelApiUrl(rawUrl);
      if (!tunnel) {
        return nativeFetchRef!(input, init);
      }
      return executeTunneledFetch(input, init);
    }) as typeof window.fetch;

    window.WebSocket = E2EWebSocket as unknown as typeof window.WebSocket;
    if (nativeEventSourceRef) {
      window.EventSource = E2EEventSource as unknown as typeof window.EventSource;
    }
  }

  await ensureE2ESession();
}
