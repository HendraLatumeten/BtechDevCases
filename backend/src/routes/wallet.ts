import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { DbClient, QueryExecutor } from '../db/client.js';
import { AppError, isPgUniqueViolation } from '../errors.js';
import { formatCentsToAmount, parseAmountToCents } from '../utils/money.js';

const transferSchema = z.object({
  recipient: z
    .string({ required_error: 'Recipient is required' })
    .trim()
    .toLowerCase()
    .email('Recipient must be a valid email address'),
  amount: z.union([z.number(), z.string()], {
    required_error: 'Amount is required',
  }),
  notes: z
    .string()
    .trim()
    .max(255, 'Notes must be at most 255 characters')
    .optional()
    .default(''),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});

interface WalletRow {
  id: string;
  user_id: string;
  balance_cents: string | number;
  updated_at: string | Date;
}

interface TransactionJoinRow {
  id: string;
  sender_wallet_id: string;
  recipient_wallet_id: string;
  amount_cents: string | number;
  notes: string;
  idempotency_key: string | null;
  created_at: string | Date;
  sender_email: string;
  recipient_email: string;
}

function formatTransaction(row: TransactionJoinRow, myWalletId: string) {
  const isOutgoing = row.sender_wallet_id === myWalletId;
  const amountCents = Number(row.amount_cents);
  return {
    id: row.id,
    direction: isOutgoing ? ('OUT' as const) : ('IN' as const),
    senderEmail: row.sender_email,
    recipientEmail: row.recipient_email,
    counterpartyEmail: isOutgoing ? row.recipient_email : row.sender_email,
    amountCents,
    amount: formatCentsToAmount(amountCents),
    notes: row.notes,
    idempotencyKey: row.idempotency_key,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function findIdempotentTx(
  executor: QueryExecutor,
  senderWalletId: string,
  idempotencyKey: string
): Promise<TransactionJoinRow | null> {
  const res = await executor.query<TransactionJoinRow>(
    `SELECT
      t.id,
      t.sender_wallet_id,
      t.recipient_wallet_id,
      t.amount_cents,
      t.notes,
      t.idempotency_key,
      t.created_at,
      su.email AS sender_email,
      ru.email AS recipient_email
    FROM wallet_transactions t
    JOIN wallets sw ON sw.id = t.sender_wallet_id
    JOIN users su ON su.id = sw.user_id
    JOIN wallets rw ON rw.id = t.recipient_wallet_id
    JOIN users ru ON ru.id = rw.user_id
    WHERE t.sender_wallet_id = $1 AND t.idempotency_key = $2`,
    [senderWalletId, idempotencyKey]
  );
  return res.rows[0] ?? null;
}

export function createWalletRouter(
  db: DbClient,
  requireAuth: RequestHandler,
  now: () => Date = () => new Date()
): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      const userId = req.auth!.userId;
      const walletRes = await db.query<WalletRow>(
        'SELECT id, user_id, balance_cents, updated_at FROM wallets WHERE user_id = $1',
        [userId]
      );

      if (walletRes.rows.length === 0) {
        throw new AppError(404, 'Wallet not found', 'WALLET_NOT_FOUND');
      }

      const wallet = walletRes.rows[0];
      const balanceCents = Number(wallet.balance_cents);

      const txRes = await db.query<TransactionJoinRow>(
        `SELECT
          t.id,
          t.sender_wallet_id,
          t.recipient_wallet_id,
          t.amount_cents,
          t.notes,
          t.idempotency_key,
          t.created_at,
          su.email AS sender_email,
          ru.email AS recipient_email
        FROM wallet_transactions t
        JOIN wallets sw ON sw.id = t.sender_wallet_id
        JOIN users su ON su.id = sw.user_id
        JOIN wallets rw ON rw.id = t.recipient_wallet_id
        JOIN users ru ON ru.id = rw.user_id
        WHERE t.sender_wallet_id = $1 OR t.recipient_wallet_id = $1
        ORDER BY t.created_at DESC
        LIMIT 50`,
        [wallet.id]
      );

      res.status(200).json({
        wallet: {
          id: wallet.id,
          balanceCents,
          balance: formatCentsToAmount(balanceCents),
          updatedAt: new Date(wallet.updated_at).toISOString(),
        },
        transactions: txRes.rows.map((row) => formatTransaction(row, wallet.id)),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/transfer', async (req, res, next) => {
    try {
      const parsed = transferSchema.safeParse(req.body);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        throw new AppError(400, firstIssue?.message || 'Invalid transfer request', 'VALIDATION_ERROR');
      }

      const headerKeyRaw = req.header('Idempotency-Key');
      const idempotencyKey = headerKeyRaw?.trim() || parsed.data.idempotencyKey || null;
      if (idempotencyKey && idempotencyKey.length > 128) {
        throw new AppError(400, 'Idempotency-Key is too long', 'VALIDATION_ERROR');
      }

      const recipientEmail = parsed.data.recipient;
      const notes = parsed.data.notes;
      const amountCents = parseAmountToCents(parsed.data.amount);
      if (amountCents === null) {
        throw new AppError(
          400,
          'Amount must be a positive number with up to 2 decimal places',
          'INVALID_AMOUNT'
        );
      }

      if (recipientEmail === req.auth!.email.toLowerCase()) {
        throw new AppError(400, 'Cannot transfer funds to your own account', 'SELF_TRANSFER');
      }

      const performTransfer = () =>
        db.transaction(async (tx) => {
          const senderWalletRes = await tx.query<WalletRow>(
            'SELECT id, user_id, balance_cents, updated_at FROM wallets WHERE user_id = $1',
            [req.auth!.userId]
          );
          if (senderWalletRes.rows.length === 0) {
            throw new AppError(404, 'Sender wallet not found', 'WALLET_NOT_FOUND');
          }
          const senderWalletMeta = senderWalletRes.rows[0];

          if (idempotencyKey) {
            const existing = await findIdempotentTx(tx, senderWalletMeta.id, idempotencyKey);
            if (existing) {
              if (
                existing.recipient_email !== recipientEmail ||
                Number(existing.amount_cents) !== amountCents ||
                existing.notes !== notes
              ) {
                throw new AppError(
                  409,
                  'Idempotency key was already used with different transfer details',
                  'IDEMPOTENCY_CONFLICT'
                );
              }

              const latestWalletRes = await tx.query<WalletRow>(
                'SELECT id, user_id, balance_cents, updated_at FROM wallets WHERE id = $1',
                [senderWalletMeta.id]
              );
              const latestWallet = latestWalletRes.rows[0];
              const latestBalanceCents = Number(latestWallet.balance_cents);
              return {
                idempotentReplay: true,
                transaction: formatTransaction(existing, senderWalletMeta.id),
                wallet: {
                  id: latestWallet.id,
                  balanceCents: latestBalanceCents,
                  balance: formatCentsToAmount(latestBalanceCents),
                  updatedAt: new Date(latestWallet.updated_at).toISOString(),
                },
              };
            }
          }

          const recipientRes = await tx.query<{
            user_id: string;
            email: string;
            wallet_id: string;
          }>(
            `SELECT u.id AS user_id, u.email, w.id AS wallet_id
             FROM users u
             JOIN wallets w ON w.user_id = u.id
             WHERE u.email = $1`,
            [recipientEmail]
          );

          if (recipientRes.rows.length === 0) {
            throw new AppError(404, 'Recipient user not found', 'RECIPIENT_NOT_FOUND');
          }
          const recipient = recipientRes.rows[0];

          // Lock both wallets in deterministic UUID order to avoid deadlocks under concurrency.
          const [firstId, secondId] = [senderWalletMeta.id, recipient.wallet_id].sort();
          const lockedRes = await tx.query<WalletRow>(
            'SELECT id, user_id, balance_cents, updated_at FROM wallets WHERE id IN ($1, $2) ORDER BY id ASC FOR UPDATE',
            [firstId, secondId]
          );

          const lockedSender = lockedRes.rows.find((w) => w.id === senderWalletMeta.id);
          const lockedRecipient = lockedRes.rows.find((w) => w.id === recipient.wallet_id);
          if (!lockedSender || !lockedRecipient) {
            throw new AppError(404, 'Wallet record missing', 'WALLET_NOT_FOUND');
          }

          const senderBalanceCents = Number(lockedSender.balance_cents);
          if (senderBalanceCents < amountCents) {
            throw new AppError(400, 'Insufficient wallet balance', 'INSUFFICIENT_BALANCE');
          }

          const txTimestamp = now().toISOString();
          const newSenderBalance = senderBalanceCents - amountCents;
          const newRecipientBalance = Number(lockedRecipient.balance_cents) + amountCents;

          await tx.query(
            'UPDATE wallets SET balance_cents = $1, updated_at = $2 WHERE id = $3',
            [newSenderBalance, txTimestamp, lockedSender.id]
          );
          await tx.query(
            'UPDATE wallets SET balance_cents = $1, updated_at = $2 WHERE id = $3',
            [newRecipientBalance, txTimestamp, lockedRecipient.id]
          );

          const txId = randomUUID();
          await tx.query(
            `INSERT INTO wallet_transactions
             (id, sender_wallet_id, recipient_wallet_id, amount_cents, notes, idempotency_key, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [txId, lockedSender.id, lockedRecipient.id, amountCents, notes, idempotencyKey, txTimestamp]
          );

          return {
            idempotentReplay: false,
            transaction: formatTransaction(
              {
                id: txId,
                sender_wallet_id: lockedSender.id,
                recipient_wallet_id: lockedRecipient.id,
                amount_cents: amountCents,
                notes,
                idempotency_key: idempotencyKey,
                created_at: txTimestamp,
                sender_email: req.auth!.email,
                recipient_email: recipient.email,
              },
              lockedSender.id
            ),
            wallet: {
              id: lockedSender.id,
              balanceCents: newSenderBalance,
              balance: formatCentsToAmount(newSenderBalance),
              updatedAt: txTimestamp,
            },
          };
        });

      let result;
      try {
        result = await performTransfer();
      } catch (err) {
        // Handle concurrent duplicate retry racing on the unique (sender_wallet_id, idempotency_key) index.
        if (idempotencyKey && isPgUniqueViolation(err)) {
          result = await performTransfer();
        } else {
          throw err;
        }
      }

      res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

