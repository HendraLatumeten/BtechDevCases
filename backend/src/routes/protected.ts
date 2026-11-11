import { Router, type RequestHandler } from 'express';
import type { AppConfig } from '../config.js';

export function createProtectedRouter(
  config: AppConfig,
  requireAuth: RequestHandler,
  now: () => Date = () => new Date()
): Router {
  const router = Router();

  const handler: RequestHandler = (req, res) => {
    const auth = req.auth!;
    res.status(200).json({
      message: `Hello ${auth.email}, welcome back`,
      user: {
        id: auth.userId,
        email: auth.email,
      },
      inactivityTimeoutSeconds: Math.round(config.inactivityTimeoutMs / 1000),
      lastActiveAt: auth.lastActiveAt,
      serverTime: now().toISOString(),
    });
  };

  router.get('/protected', requireAuth, handler);
  router.get('/me', requireAuth, handler);

  return router;
}

