export { createE2EMiddleware } from './e2e.middleware.js';
export {
  authenticateE2EWebSocketUpgrade,
  decryptServerBytes,
  encryptServerBytes,
  fromBase64Url,
  getE2ESession,
  getOrCreateServerIdentity,
  packBinaryEnvelope,
  packLengthPrefixedFrame,
  performE2EHandshake,
  toBase64Url,
  unpackBinaryEnvelope,
  wrapServerWebSocketWithE2E,
  type E2EHandshakeResponse,
  type E2ERequestMeta,
  type E2EResponseMeta,
  type E2ESession,
} from './e2e.service.js';
