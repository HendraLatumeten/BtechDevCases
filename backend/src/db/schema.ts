import type { DbClient } from './client.js';

export async function runMigrations(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      balance_cents BIGINT NOT NULL CHECK (balance_cents >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id UUID PRIMARY KEY,
      sender_wallet_id UUID NOT NULL REFERENCES wallets(id),
      recipient_wallet_id UUID NOT NULL REFERENCES wallets(id),
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      notes TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (sender_wallet_id, idempotency_key)
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_wallet_tx_sender ON wallet_transactions(sender_wallet_id, created_at DESC);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_wallet_tx_recipient ON wallet_transactions(recipient_wallet_id, created_at DESC);
  `);
}

