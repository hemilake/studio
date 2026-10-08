// shareRoutes: used by the server entrypoint to mount authenticated owner session-sharing endpoints at /api/shares.
export { shareRoutes } from './share.module.js';
// publicShareRoutes: used by the server entrypoint to mount unauthenticated public session-sharing endpoints at /api/public/shares.
export { publicShareRoutes } from './share.module.js';
