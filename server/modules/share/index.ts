// shareRoutes: used by the server entrypoint to mount authenticated owner session-sharing endpoints at /api/shares.
export { shareRoutes } from './share.module.js';
// publicShareRoutes: used by the server entrypoint to mount unauthenticated public session-sharing endpoints at /api/public/shares.
export { publicShareRoutes } from './share.module.js';
// initializeCloudShareSync: used by the server entrypoint to resume and poll active cloud shares every 5 seconds.
export { initializeCloudShareSync } from './share.module.js';
// closeCloudShareSync: used by the server entrypoint to stop the cloud share sync loop on shutdown.
export { closeCloudShareSync } from './share.module.js';
