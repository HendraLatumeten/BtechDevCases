import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig, type AppConfig } from '../config.js';
import { createDbClient, type DbClient } from '../db/client.js';
import { runMigrations } from '../db/schema.js';

describe('Auth & Wallet API integration', () => {
  let db: DbClient;
  let config: AppConfig;
  let currentMs: number;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    currentMs = new Date('2026-11-11T10:00:00.000Z').getTime();
    config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      JWT_SECRET: 'test-jwt-secret-key',
      INACTIVITY_TIMEOUT_MINUTES: '15',
      INITIAL_WALLET_BALANCE: '1000.00',
      BCRYPT_ROUNDS: '4',
    });
    db = await createDbClient(config.databaseUrl);
    await runMigrations(db);
    app = createApp({
      db,
      config,
      now: () => new Date(currentMs),
    });
  });

  afterEach(async () => {
    await db.close();
  });

  async function registerAndLogin(email: string, password = 'Password123') {
    const reg = await request(app).post('/api/auth/register').send({
      email,
      password,
      confirmPassword: password,
    });
    expect(reg.status).toBe(201);

    const login = await request(app).post('/api/auth/login').send({
      email,
      password,
    });
    expect(login.status).toBe(200);
    return {
      token: login.body.token as string,
      user: login.body.user as { id: string; email: string },
    };
  }

  it('validates registration fields and rejects duplicate emails', async () => {
    const mismatch = await request(app).post('/api/auth/register').send({
      email: 'alice@example.com',
      password: 'Password123',
      confirmPassword: 'Different123',
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toMatch(/do not match/i);

    const weak = await request(app).post('/api/auth/register').send({
      email: 'alice@example.com',
      password: 'short',
      confirmPassword: 'short',
    });
    expect(weak.status).toBe(400);

    const ok = await request(app).post('/api/auth/register').send({
      email: '  Alice@Example.com ',
      password: 'Password123',
      confirmPassword: 'Password123',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.user.email).toBe('alice@example.com');
    expect(ok.body.wallet.balance).toBe('1000.00');

    const dup = await request(app).post('/api/auth/register').send({
      email: 'alice@example.com',
      password: 'Password123',
      confirmPassword: 'Password123',
    });
    expect(dup.status).toBe(409);
  });

  it('returns JWT containing email and userId, and serves Hello [email], welcome back', async () => {
    const { token, user } = await registerAndLogin('alice@example.com');
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.email).toBe('alice@example.com');
    expect(decoded.userId).toBe(user.id);
    expect(decoded.sub).toBe(user.id);

    const unauth = await request(app).get('/api/protected');
    expect(unauth.status).toBe(401);

    const protectedRes = await request(app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(protectedRes.status).toBe(200);
    expect(protectedRes.body.message).toBe('Hello alice@example.com, welcome back');
  });

  it('logs out user after 15 minutes of inactivity using sliding window', async () => {
    const { token } = await registerAndLogin('alice@example.com');

    // Advance 10 minutes and call protected route -> resets inactivity timer
    currentMs += 10 * 60 * 1000;
    const activeAt10 = await request(app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(activeAt10.status).toBe(200);

    // Advance another 10 minutes (total 20m since login, only 10m since last activity) -> still valid!
    currentMs += 10 * 60 * 1000;
    const activeAt20 = await request(app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(activeAt20.status).toBe(200);

    // Advance 15 full minutes of inactivity -> must reject with 401
    currentMs += 15 * 60 * 1000;
    const expired = await request(app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('SESSION_INACTIVE_TIMEOUT');

    // Session stays revoked even on subsequent attempts
    const stillRevoked = await request(app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(stillRevoked.status).toBe(401);
  });

  it('revokes token immediately on explicit logout', async () => {
    const { token } = await registerAndLogin('alice@example.com');

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(logoutRes.status).toBe(200);

    const afterLogout = await request(app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(afterLogout.status).toBe(401);
  });

  it('transfers funds safely, validates invalid cases, and supports idempotent retries', async () => {
    const alice = await registerAndLogin('alice@example.com');
    const bob = await registerAndLogin('bob@example.com');

    // Self transfer blocked
    const selfRes = await request(app)
      .post('/api/wallet/transfer')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ recipient: 'alice@example.com', amount: '10.00', notes: 'self' });
    expect(selfRes.status).toBe(400);

    // Negative / zero amount blocked
    const negRes = await request(app)
      .post('/api/wallet/transfer')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ recipient: 'bob@example.com', amount: '-50.00', notes: 'exploit' });
    expect(negRes.status).toBe(400);

    // Non-existent recipient blocked
    const missingRes = await request(app)
      .post('/api/wallet/transfer')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ recipient: 'nobody@example.com', amount: '10.00', notes: 'test' });
    expect(missingRes.status).toBe(404);

    // Insufficient balance blocked
    const tooMuchRes = await request(app)
      .post('/api/wallet/transfer')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ recipient: 'bob@example.com', amount: '1500.00', notes: 'too big' });
    expect(tooMuchRes.status).toBe(400);

    // Valid transfer with Idempotency-Key
    const idempotencyKey = 'cave-retry-uuid-001';
    const transferRes = await request(app)
      .post('/api/wallet/transfer')
      .set('Authorization', `Bearer ${alice.token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ recipient: 'bob@example.com', amount: '125.50', notes: 'Jungle supplies' });
    expect(transferRes.status).toBe(201);
    expect(transferRes.body.idempotentReplay).toBe(false);
    expect(transferRes.body.wallet.balance).toBe('874.50');
    expect(transferRes.body.transaction.notes).toBe('Jungle supplies');

    // Network dropped in cave -> client retries with exact same Idempotency-Key -> no double debit!
    const retryRes = await request(app)
      .post('/api/wallet/transfer')
      .set('Authorization', `Bearer ${alice.token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ recipient: 'bob@example.com', amount: '125.50', notes: 'Jungle supplies' });
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.idempotentReplay).toBe(true);
    expect(retryRes.body.wallet.balance).toBe('874.50');
    expect(retryRes.body.transaction.id).toBe(transferRes.body.transaction.id);

    // Reusing key with mismatched payload is rejected
    const conflictRes = await request(app)
      .post('/api/wallet/transfer')
      .set('Authorization', `Bearer ${alice.token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ recipient: 'bob@example.com', amount: '99.00', notes: 'Different' });
    expect(conflictRes.status).toBe(409);

    // Verify Bob received exact funds and sees incoming transaction
    const bobWallet = await request(app)
      .get('/api/wallet')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(bobWallet.status).toBe(200);
    expect(bobWallet.body.wallet.balance).toBe('1125.50');
    expect(bobWallet.body.transactions).toHaveLength(1);
    expect(bobWallet.body.transactions[0]).toMatchObject({
      direction: 'IN',
      counterpartyEmail: 'alice@example.com',
      amount: '125.50',
      notes: 'Jungle supplies',
    });
  });

  it('prevents overdraft under concurrent transfers', async () => {
    const alice = await registerAndLogin('alice@example.com');
    const bob = await registerAndLogin('bob@example.com');

    // Attempt two 600.00 transfers simultaneously from a 1000.00 balance
    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/wallet/transfer')
        .set('Authorization', `Bearer ${alice.token}`)
        .set('Idempotency-Key', 'concurrent-1')
        .send({ recipient: 'bob@example.com', amount: '600.00', notes: 'First' }),
      request(app)
        .post('/api/wallet/transfer')
        .set('Authorization', `Bearer ${alice.token}`)
        .set('Idempotency-Key', 'concurrent-2')
        .send({ recipient: 'bob@example.com', amount: '600.00', notes: 'Second' }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 400]);

    const aliceWallet = await request(app)
      .get('/api/wallet')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(aliceWallet.body.wallet.balance).toBe('400.00');

    const bobWallet = await request(app)
      .get('/api/wallet')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(bobWallet.body.wallet.balance).toBe('1600.00');
  });
});

