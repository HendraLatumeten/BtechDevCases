export interface AppConfig {
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  inactivityTimeoutMinutes: number;
  inactivityTimeoutMs: number;
  initialWalletBalanceCents: number;
  corsOrigins: string[];
  bcryptRounds: number;
}

/**
 * Parse a decimal currency string (e.g. "1000.00") to integer cents without float precision loss.
 */
export function parseDecimalEnvToCents(raw: string | undefined, fallbackCents: number): number {
  if (!raw || raw.trim() === '') return fallbackCents;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(`Invalid monetary config value: "${raw}"`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV || 'development';
  const jwtSecret = env.JWT_SECRET || (nodeEnv === 'production' ? '' : 'dev-only-insecure-secret-change-me');
  if (!jwtSecret) {
    throw new Error('JWT_SECRET environment variable is required in production');
  }

  const inactivityTimeoutMinutes = Number(env.INACTIVITY_TIMEOUT_MINUTES ?? '15');
  if (!Number.isFinite(inactivityTimeoutMinutes) || inactivityTimeoutMinutes <= 0) {
    throw new Error('INACTIVITY_TIMEOUT_MINUTES must be a positive number');
  }

  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('PORT must be a positive integer');
  }

  const bcryptRounds = Number(env.BCRYPT_ROUNDS ?? '10');
  if (!Number.isInteger(bcryptRounds) || bcryptRounds < 4 || bcryptRounds > 14) {
    throw new Error('BCRYPT_ROUNDS must be an integer between 4 and 14');
  }

  const corsRaw = env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:8080';
  const corsOrigins = corsRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  return {
    port,
    nodeEnv,
    databaseUrl: env.DATABASE_URL || 'pglite://./data/pgdata',
    jwtSecret,
    jwtExpiresIn: env.JWT_EXPIRES_IN || '24h',
    inactivityTimeoutMinutes,
    inactivityTimeoutMs: Math.round(inactivityTimeoutMinutes * 60 * 1000),
    initialWalletBalanceCents: parseDecimalEnvToCents(env.INITIAL_WALLET_BALANCE, 100_000),
    corsOrigins,
    bcryptRounds,
  };
}

