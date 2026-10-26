import http from 'node:http';
import net from 'node:net';

import type { Express, NextFunction, Request, Response } from 'express';

import {
  decryptServerBytes,
  encryptServerBytes,
  getE2ESession,
  packBinaryEnvelope,
  packLengthPrefixedFrame,
  performE2EHandshake,
  unpackBinaryEnvelope,
  type E2ERequestMeta,
  type E2EResponseMeta,
} from './e2e.service.js';

const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_TUNNEL_BODY_BYTES = 65 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'te',
  'trailer',
  'upgrade',
]);

function readRawBody(req: Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function collectInnerHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = res.getHeaders();
  for (const [key, value] of Object.entries(raw)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || value === undefined) {
      continue;
    }
    out[lower] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
  }
  return out;
}

function toBufferChunk(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding ?? 'utf8');
  return Buffer.from(String(chunk ?? ''), 'utf8');
}

/**
 * Express middleware that handles:
 * - `POST /api/e2e/handshake`: ECDH P-256 + ECDSA P-256 authenticated key exchange
 * - `POST /api/e2e`: AES-256-GCM encrypted HTTP/SSE tunnel for all `/api/*` routes
 *
 * Mount BEFORE `express.json()` so tunnel payloads are decrypted before body
 * parsers and `multer` inspect the inner request stream.
 */
export function createE2EMiddleware(app: Express) {
  return async function e2eMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.method === 'POST' && req.path === '/api/e2e/handshake') {
      try {
        const bodyBuf = await readRawBody(req, MAX_HANDSHAKE_BYTES);
        const parsed = JSON.parse(bodyBuf.toString('utf8')) as { clientEcdhPublicKey?: string };
        const result = performE2EHandshake(parsed.clientEcdhPublicKey ?? '');
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json(result);
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 400;
        res.status(status).json({
          error: (error as Error).message || 'E2E handshake failed',
        });
      }
      return;
    }

    if (req.method !== 'POST' || req.path !== '/api/e2e') {
      next();
      return;
    }

    const kidHeader = req.headers['x-e2e-kid'];
    const kid = Array.isArray(kidHeader) ? kidHeader[0] : kidHeader;
    const session = getE2ESession(kid);
    if (!session) {
      res.setHeader('X-E2E-Error', 'session-expired');
      res.status(425).json({ error: 'e2e_session_expired' });
      return;
    }

    let rawEncrypted: Buffer;
    try {
      rawEncrypted = await readRawBody(req, MAX_TUNNEL_BODY_BYTES);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 400;
      res.status(status).end();
      return;
    }

    let meta: E2ERequestMeta;
    let innerBody: Buffer;
    try {
      const decrypted = decryptServerBytes(session.key, rawEncrypted, `c2s:http:${session.kid}`);
      const unpacked = unpackBinaryEnvelope<E2ERequestMeta>(decrypted);
      meta = unpacked.meta;
      innerBody = unpacked.body;
    } catch {
      res.setHeader('X-E2E-Error', 'decrypt-failed');
      res.status(400).json({ error: 'e2e_decrypt_failed' });
      return;
    }

    const targetUrl = typeof meta.url === 'string' ? meta.url : '';
    if (!targetUrl.startsWith('/api/') || targetUrl.startsWith('/api/e2e')) {
      res.status(400).json({ error: 'Invalid tunnel target URL' });
      return;
    }

    // Use a detached Socket so innerReq cleanup never closes the outer HTTP/1.1 keep-alive socket.
    const dummySocket = new net.Socket();
    Object.defineProperty(dummySocket, 'remoteAddress', {
      value: req.socket?.remoteAddress,
      configurable: true,
    });
    Object.defineProperty(dummySocket, 'encrypted', {
      value: Boolean((req.socket as unknown as { encrypted?: boolean })?.encrypted),
      configurable: true,
    });

    const innerReq = new http.IncomingMessage(dummySocket);
    innerReq.httpVersion = '1.1';
    innerReq.httpVersionMajor = 1;
    innerReq.httpVersionMinor = 1;
    innerReq.method = (meta.method || 'GET').toUpperCase();
    innerReq.url = targetUrl;

    const normalizedHeaders: http.IncomingHttpHeaders = {};
    if (req.headers.host) {
      normalizedHeaders.host = req.headers.host;
    }
    if (req.headers.cookie) {
      normalizedHeaders.cookie = req.headers.cookie;
    }
    if (meta.headers && typeof meta.headers === 'object') {
      for (const [k, v] of Object.entries(meta.headers)) {
        if (typeof v === 'string') {
          normalizedHeaders[k.toLowerCase()] = v;
        }
      }
    }
    if (innerBody.length > 0) {
      normalizedHeaders['content-length'] = String(innerBody.length);
    } else {
      delete normalizedHeaders['content-length'];
    }
    delete normalizedHeaders['transfer-encoding'];
    innerReq.headers = normalizedHeaders;

    innerReq._read = () => {};
    if (innerBody.length > 0) {
      innerReq.push(innerBody);
    }
    innerReq.push(null);

    const onOuterClose = () => {
      if (!res.writableEnded) {
        innerReq.emit('close');
      }
    };
    req.on('close', onOuterClose);

    const outChunks: Buffer[] = [];
    const origWrite = res.write as (chunk: unknown, cb?: (error: Error | null | undefined) => void) => boolean;
    const origEnd = res.end as (chunk?: unknown, cb?: () => void) => Response;
    const origWriteHead = res.writeHead;

    let isSseStream = false;
    let sseHeadersSent = false;
    let sseSeq = 0;

    const isEventStreamResponse = (): boolean => {
      const ct = res.getHeader('content-type');
      const ctStr = Array.isArray(ct) ? ct.join('; ') : String(ct ?? '');
      return ctStr.toLowerCase().includes('text/event-stream');
    };

    const ensureSseOuterHeaders = (): void => {
      if (sseHeadersSent) return;
      sseHeadersSent = true;
      for (const name of res.getHeaderNames()) {
        res.removeHeader(name);
      }
      res.writeHead = origWriteHead;
      res.req = req;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-E2E-Stream', 'sse');
    };

    res.writeHead = function (
      statusCode: number,
      statusMessage?: string | http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
      headers?: http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
    ) {
      res.statusCode = statusCode;
      if (typeof statusMessage === 'string') {
        res.statusMessage = statusMessage;
      }
      const headerObj = (typeof statusMessage === 'object' && statusMessage !== null)
        ? statusMessage
        : headers;
      if (headerObj && !Array.isArray(headerObj)) {
        for (const [k, v] of Object.entries(headerObj)) {
          if (v !== undefined) {
            res.setHeader(k, v);
          }
        }
      }
      if (isEventStreamResponse()) {
        isSseStream = true;
      }
      return res;
    } as typeof res.writeHead;

    res.write = function (
      chunk: unknown,
      encodingOrCb?: BufferEncoding | ((error: Error | null | undefined) => void),
      cb?: (error: Error | null | undefined) => void,
    ): boolean {
      const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;

      if (isSseStream || isEventStreamResponse()) {
        isSseStream = true;
        ensureSseOuterHeaders();
        if (chunk !== undefined && chunk !== null) {
          const buf = toBufferChunk(chunk, encoding);
          if (buf.length > 0) {
            const encrypted = encryptServerBytes(
              session.key,
              buf,
              `s2c:sse:${session.kid}:${sseSeq++}`,
            );
            const framed = packLengthPrefixedFrame(encrypted);
            return origWrite.call(res, framed, callback as (err: Error | null | undefined) => void);
          }
        }
        if (callback) callback(null);
        return true;
      }

      if (chunk !== undefined && chunk !== null) {
        outChunks.push(toBufferChunk(chunk, encoding));
      }
      if (callback) callback(null);
      return true;
    } as typeof res.write;

    res.end = function (
      chunkOrCb?: unknown,
      encodingOrCb?: BufferEncoding | (() => void),
      cb?: () => void,
    ): Response {
      req.off('close', onOuterClose);
      const hasChunk = chunkOrCb !== undefined && chunkOrCb !== null && typeof chunkOrCb !== 'function';
      const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
      const callback = typeof chunkOrCb === 'function'
        ? (chunkOrCb as () => void)
        : typeof encodingOrCb === 'function'
          ? encodingOrCb
          : cb;

      if (isSseStream || isEventStreamResponse()) {
        ensureSseOuterHeaders();
        if (hasChunk) {
          const buf = toBufferChunk(chunkOrCb, encoding);
          if (buf.length > 0) {
            const encrypted = encryptServerBytes(
              session.key,
              buf,
              `s2c:sse:${session.kid}:${sseSeq++}`,
            );
            origWrite.call(res, packLengthPrefixedFrame(encrypted));
          }
        }
        res.write = origWrite as typeof res.write;
        res.end = origEnd as typeof res.end;
        res.req = req;
        return origEnd.call(res, undefined, callback as () => void);
      }

      if (hasChunk) {
        outChunks.push(toBufferChunk(chunkOrCb, encoding));
      }

      const responseMeta: E2EResponseMeta = {
        status: res.statusCode || 200,
        statusText: res.statusMessage || '',
        headers: collectInnerHeaders(res),
      };
      const fullBody = Buffer.concat(outChunks);
      const packed = packBinaryEnvelope(responseMeta, fullBody);
      const encryptedResponse = encryptServerBytes(session.key, packed, `s2c:http:${session.kid}`);

      for (const name of res.getHeaderNames()) {
        res.removeHeader(name);
      }

      res.writeHead = origWriteHead;
      res.write = origWrite as typeof res.write;
      res.end = origEnd as typeof res.end;
      res.req = req;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', String(encryptedResponse.length));

      return origEnd.call(res, encryptedResponse, callback as () => void);
    } as typeof res.end;

    app(innerReq, res);
  };
}
