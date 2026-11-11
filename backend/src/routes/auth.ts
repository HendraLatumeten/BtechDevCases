import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { DbClient } from '../db/client.js';
import { AppError, isPgUniqueViolation } from '../errors.js';
import { signAuthToken } from '../utils/jwt.js';
import { formatCentsToAmount } from '../utils/money.js';

const emailSchema = z
  .string({ required_error: 'Email is required' })
  .trim()
  .toLowerCase()
  .email('Invalid email format')
  .max(254, 'Email is too long');

const registerSchema = z
  .object({
    email: emailSchema,
    password: z
      .string({ required_error: 'Password is required' })
      .min(8, 'Password must be at least 8 characters')
      .max(128, 'Password is too long')
      .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
        message: 'Password must contain at least one letter and one number',
      }),
    confirmPassword: z.string({ required_error: 'Confirm password is required' }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

const loginSchema = z.object({
  email: emailSchema,
  password: z
    .string({ required_error: 'Password is required' })
    .min(1, 'Password is required'),
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string | Date;
}

export function createAuthRouter(
  db: DbClient,
  config: AppConfig,
  requireAuth: RequestHandler,
  now: () => Date = () => new Date()
): Router {
  const router = Router();

  router.post('/register', async (req, res, next) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        throw new AppError(400, firstIssue?.message || 'Invalid registration data', 'VALIDATION_ERROR');
      }

      const { email, password } = parsed.data;
      const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
      const userId = randomUUID();
      const walletId = randomUUID();
      const createdAt = now().toISOString();

      try {
        await db.transaction(async (tx) => {
          await tx.query(
            'INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)',
            [userId, email, passwordHash, createdAt]
          );
          await tx.query(
            'INSERT INTO wallets (id, user_id, balance_cents, updated_at) VALUES ($1, $2, $3, $4)',
            [walletId, userId, config.initialWalletBalanceCents, createdAt]
          );
        });
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          throw new AppError(409, 'Email is already registered', 'EMAIL_EXISTS');
        }
        throw err;
      }

      res.status(201).json({
        user: {
          id: userId,
          email,
          createdAt,
        },
        wallet: {
          balanceCents: config.initialWalletBalanceCents,
          balance: formatCentsToAmount(config.initialWalletBalanceCents),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        throw new AppError(400, firstIssue?.message || 'Invalid login credentials', 'VALIDATION_ERROR');
      }

      const { email, password } = parsed.data;
      const userRes = await db.query<UserRow>(
        'SELECT id, email, password_hash, created_at FROM users WHERE email = $1',
        [email]
      );

      if (userRes.rows.length === 0) {
        throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
      }

      const user = userRes.rows[0];
      const matches = await bcrypt.compare(password, user.password_hash);
      if (!matches) {
        throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
      }

      const sessionId = randomUUID();
      const createdAt = now().toISOString();

      await db.query(
        'INSERT INTO sessions (id, user_id, last_active_at, created_at) VALUES ($1, $2, $3, $4)',
        [sessionId, user.id, createdAt, createdAt]
      );

      const token = signAuthToken(
        {
          userId: user.id,
          email: user.email,
          sessionId,
        },
        config
      );

      res.status(200).json({
        token,
        user: {
          id: user.id,
          email: user.email,
        },
        inactivityTimeoutSeconds: Math.round(config.inactivityTimeoutMs / 1000),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/ping', requireAuth, (req, res) => {
    res.status(200).json({
      ok: true,
      lastActiveAt: req.auth!.lastActiveAt,
    });
  });

  router.post('/logout', requireAuth, async (req, res, next) => {
    try {
      await db.query('UPDATE sessions SET revoked_at = $1 WHERE id = $2', [
        now().toISOString(),
        req.auth!.sessionId,
      ]);
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

