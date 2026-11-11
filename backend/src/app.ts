import compression from 'compression';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type { AppConfig } from './config.js';
import type { DbClient } from './db/client.js';
import { AppError } from './errors.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAuthRouter } from './routes/auth.js';
import { createProtectedRouter } from './routes/protected.js';
import { createWalletRouter } from './routes/wallet.js';

export interface CreateAppDeps {
  db: DbClient;
  config: AppConfig;
  now?: () => Date;
}

export function createApp({ db, config, now = () => new Date() }: CreateAppDeps) {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
      credentials: false,
      exposedHeaders: ['X-Inactivity-Timeout-Seconds'],
    })
  );
  // Gzip payloads to reduce bandwidth on poor jungle/cave connections.
  app.use(compression({ threshold: 256 }));
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', async (_req, res, next) => {
    try {
      await db.query('SELECT 1');
      res.status(200).json({ status: 'ok', time: now().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  const requireAuth = createAuthMiddleware(db, config, now);

  app.use('/api/auth', createAuthRouter(db, config, requireAuth, now));
  app.use('/api', createProtectedRouter(config, requireAuth, now));
  app.use('/api/wallet', createWalletRouter(db, requireAuth, now));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }

    if (
      typeof err === 'object' &&
      err !== null &&
      'type' in err &&
      (err as { type?: string }).type === 'entity.parse.failed'
    ) {
      res.status(400).json({ error: 'Invalid JSON request body', code: 'INVALID_JSON' });
      return;
    }

    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });

  return app;
}

