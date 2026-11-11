import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import type { DbClient } from '../db/client.js';
import { AppError } from '../errors.js';
import { verifyAuthToken } from '../utils/jwt.js';

export interface AuthContext {
  userId: string;
  email: string;
  sessionId: string;
  lastActiveAt: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

interface SessionRow {
  id: string;
  user_id: string;
  last_active_at: string | Date;
  revoked_at: string | Date | null;
}

export function createAuthMiddleware(
  db: DbClient,
  config: AppConfig,
  now: () => Date = () => new Date()
) {
  return async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AppError(401, 'Authentication token is required', 'UNAUTHORIZED');
      }

      const token = authHeader.slice('Bearer '.length).trim();
      if (!token) {
        throw new AppError(401, 'Authentication token is required', 'UNAUTHORIZED');
      }

      let claims;
      try {
        claims = verifyAuthToken(token, config);
      } catch {
        throw new AppError(401, 'Invalid or expired token', 'INVALID_TOKEN');
      }

      const sessionRes = await db.query<SessionRow>(
        'SELECT id, user_id, last_active_at, revoked_at FROM sessions WHERE id = $1',
        [claims.jti]
      );

      if (sessionRes.rows.length === 0) {
        throw new AppError(401, 'Session not found', 'SESSION_NOT_FOUND');
      }

      const session = sessionRes.rows[0];
      if (session.revoked_at !== null) {
        throw new AppError(401, 'Session has been logged out', 'SESSION_REVOKED');
      }

      const currentTime = now();
      const lastActiveMs = new Date(session.last_active_at).getTime();
      const elapsedMs = currentTime.getTime() - lastActiveMs;

      if (elapsedMs >= config.inactivityTimeoutMs) {
        await db.query('UPDATE sessions SET revoked_at = $1 WHERE id = $2', [
          currentTime.toISOString(),
          session.id,
        ]);
        throw new AppError(
          401,
          `Session expired after ${config.inactivityTimeoutMinutes} minutes of inactivity`,
          'SESSION_INACTIVE_TIMEOUT'
        );
      }

      const isoNow = currentTime.toISOString();
      await db.query('UPDATE sessions SET last_active_at = $1 WHERE id = $2', [isoNow, session.id]);

      res.setHeader(
        'X-Inactivity-Timeout-Seconds',
        String(Math.round(config.inactivityTimeoutMs / 1000))
      );

      req.auth = {
        userId: claims.userId,
        email: claims.email,
        sessionId: claims.jti,
        lastActiveAt: isoNow,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

