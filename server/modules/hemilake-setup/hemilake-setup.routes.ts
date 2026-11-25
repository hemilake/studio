import express from 'express';

import {
  type ClaudeConnectionInput,
  createHemilakeSetupService,
  defaultHemilakeSetupDependencies,
  SetupError,
} from './hemilake-setup.service.js';

/** Fork (Hemilake): `/api/hemilake-setup`, the first-run setup of a Studio that runs without hemi. */
export function createHemilakeSetupRouter(
  service: ReturnType<typeof createHemilakeSetupService> = createHemilakeSetupService(defaultHemilakeSetupDependencies()),
): express.Router {
  const router = express.Router();

  // hemi runs Studio with CLOUDCLI_EMBED_ONLY=1 and owns Claude Code's configuration and the lake connection there
  // (`hemi studio credentials`); a second writer would fight it.
  router.use((_request, response, next) => {
    if (process.env.CLOUDCLI_EMBED_ONLY === '1') {
      response.status(404).json({ error: 'hemi manages this Studio: use hemi studio credentials.' });
      return;
    }
    next();
  });

  const handle = (fn: (request: express.Request) => Promise<unknown>) =>
    async (request: express.Request, response: express.Response, next: express.NextFunction) => {
      try {
        response.json(await fn(request));
      } catch (error) {
        if (error instanceof SetupError) {
          response.status(error.status).json({ error: error.message });
          return;
        }
        next(error);
      }
    };

  router.get('/status', handle(() => service.getStatus()));
  router.post('/claude-connection', handle((request) => service.saveConnection(request.body as ClaudeConnectionInput)));
  router.post('/lake', handle((request) => service.connectLake(String((request.body as { address?: unknown })?.address ?? ''))));

  return router;
}
