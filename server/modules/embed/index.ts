// embedRoutes: used by the server entrypoint to mount the public embed configuration and sign-in exchange.
export { embedRoutes } from './embed.module.js';
// frameAncestors: used by the server entrypoint so only Studio itself and the configured consoles can frame it.
export { frameAncestors } from './embed.module.js';
// corsOrigin: used by the server entrypoint so only the configured consoles may read Studio's answers cross-origin.
export { corsOrigin } from './embed.module.js';
