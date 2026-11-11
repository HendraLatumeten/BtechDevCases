import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  NetworkError,
  fetchProtectedWelcome,
  fetchWallet,
  transferFunds,
} from '../lib/api';
import {
  loadCachedDashboard,
  loadOutbox,
  saveCachedDashboard,
  saveOutbox,
} from '../lib/storage';
import type {
  AuthSession,
  QueuedTransfer,
  WalletInfo,
  WalletTransaction,
} from '../types';

interface DashboardViewProps {
  session: AuthSession;
  isOnline: boolean;
  remainingSeconds: number;
  onServerSynced: () => void;
  onSessionInvalidated: (reason: string) => void;
  onLogout: () => void;
}

function formatCountdown(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function DashboardView({
  session,
  isOnline,
  remainingSeconds,
  onServerSynced,
  onSessionInvalidated,
  onLogout,
}: DashboardViewProps) {
  const cached = loadCachedDashboard(session.user.id);

  const [welcomeMessage, setWelcomeMessage] = useState(
    cached?.welcomeMessage || `Hello ${session.user.email}, welcome back`
  );
  const [wallet, setWallet] = useState<WalletInfo | null>(cached?.wallet ?? null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>(
    cached?.transactions ?? []
  );
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(
    cached?.lastSyncedAt ?? null
  );
  const [usingCachedData, setUsingCachedData] = useState<boolean>(!isOnline);

  const [outbox, setOutbox] = useState<QueuedTransfer[]>(() => loadOutbox(session.user.id));
  const [syncing, setSyncing] = useState(false);

  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'warning' | 'error'; text: string } | null>(
    null
  );

  const syncingOutboxRef = useRef(false);
  const outboxRef = useRef<QueuedTransfer[]>(outbox);
  const onServerSyncedRef = useRef(onServerSynced);
  onServerSyncedRef.current = onServerSynced;
  const onSessionInvalidatedRef = useRef(onSessionInvalidated);
  onSessionInvalidatedRef.current = onSessionInvalidated;

  const updateOutbox = useCallback(
    (updater: (prev: QueuedTransfer[]) => QueuedTransfer[]) => {
      const next = updater(outboxRef.current);
      outboxRef.current = next;
      saveOutbox(session.user.id, next);
      setOutbox(next);
    },
    [session.user.id]
  );

  const syncDashboard = useCallback(async () => {
    if (!navigator.onLine) {
      setUsingCachedData(true);
      return;
    }

    setSyncing(true);
    try {
      const [protectedRes, walletRes] = await Promise.all([
        fetchProtectedWelcome(session.token),
        fetchWallet(session.token),
      ]);
      const syncedAt = new Date().toISOString();
      setWelcomeMessage(protectedRes.message);
      setWallet(walletRes.wallet);
      setTransactions(walletRes.transactions);
      setLastSyncedAt(syncedAt);
      setUsingCachedData(false);
      saveCachedDashboard(session.user.id, {
        welcomeMessage: protectedRes.message,
        wallet: walletRes.wallet,
        transactions: walletRes.transactions,
        lastSyncedAt: syncedAt,
      });
      onServerSyncedRef.current();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onSessionInvalidatedRef.current(err.message);
        return;
      }
      if (err instanceof NetworkError) {
        setUsingCachedData(true);
      }
    } finally {
      setSyncing(false);
    }
  }, [session.token, session.user.id]);

  const flushOutbox = useCallback(async (): Promise<boolean> => {
    if (syncingOutboxRef.current || !navigator.onLine) return false;
    const pendingItems = outboxRef.current.filter((t) => t.status === 'PENDING_SYNC');
    if (pendingItems.length === 0) return false;

    syncingOutboxRef.current = true;
    setSyncing(true);

    let syncedCount = 0;
    try {
      for (const item of pendingItems) {
        try {
          const res = await transferFunds(session.token, {
            recipient: item.recipient,
            amount: item.amount,
            notes: item.notes,
            idempotencyKey: item.idempotencyKey,
          });
          syncedCount += 1;
          setWallet(res.wallet);
          updateOutbox((prev) => prev.filter((q) => q.idempotencyKey !== item.idempotencyKey));
        } catch (err) {
          if (err instanceof ApiError) {
            if (err.status === 401) {
              onSessionInvalidatedRef.current(err.message);
              return false;
            }
            updateOutbox((prev) =>
              prev.map((q) =>
                q.idempotencyKey === item.idempotencyKey
                  ? { ...q, status: 'FAILED', attempts: q.attempts + 1, lastError: err.message }
                  : q
              )
            );
          } else {
            updateOutbox((prev) =>
              prev.map((q) =>
                q.idempotencyKey === item.idempotencyKey
                  ? { ...q, attempts: q.attempts + 1 }
                  : q
              )
            );
            setUsingCachedData(true);
            break;
          }
        }
      }

      if (syncedCount > 0) {
        setFeedback({
          type: 'success',
          text: `Synced ${syncedCount} queued offline transfer(s) safely.`,
        });
      }
      return syncedCount > 0;
    } finally {
      syncingOutboxRef.current = false;
      setSyncing(false);
    }
  }, [session.token, updateOutbox]);

  useEffect(() => {
    if (isOnline) {
      void flushOutbox().then(() => syncDashboard());
    } else {
      setUsingCachedData(true);
    }
  }, [flushOutbox, isOnline, syncDashboard]);

  const handleTransferSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    const normalizedRecipient = recipient.trim().toLowerCase();
    const trimmedAmount = amount.trim();
    const trimmedNotes = notes.trim();

    if (!normalizedRecipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedRecipient)) {
      setFeedback({ type: 'error', text: 'Enter a valid recipient email address.' });
      return;
    }
    if (normalizedRecipient === session.user.email.toLowerCase()) {
      setFeedback({ type: 'error', text: 'You cannot transfer funds to yourself.' });
      return;
    }
    if (!/^\d+(\.\d{1,2})?$/.test(trimmedAmount) || Number(trimmedAmount) <= 0) {
      setFeedback({
        type: 'error',
        text: 'Enter a positive amount with up to 2 decimal places (e.g. 25.50).',
      });
      return;
    }

    const idempotencyKey = generateIdempotencyKey();

    if (!navigator.onLine) {
      updateOutbox((prev) => [
        ...prev,
        {
          idempotencyKey,
          recipient: normalizedRecipient,
          amount: trimmedAmount,
          notes: trimmedNotes,
          createdAt: new Date().toISOString(),
          status: 'PENDING_SYNC',
          attempts: 0,
        },
      ]);
      setRecipient('');
      setAmount('');
      setNotes('');
      setFeedback({
        type: 'warning',
        text: 'No signal detected. Transfer queued in Offline Outbox and will auto-send when connection returns.',
      });
      return;
    }

    setSubmitting(true);
    try {
      const res = await transferFunds(session.token, {
        recipient: normalizedRecipient,
        amount: trimmedAmount,
        notes: trimmedNotes,
        idempotencyKey,
      });

      setWallet(res.wallet);
      setTransactions((prev) => [res.transaction, ...prev]);
      setRecipient('');
      setAmount('');
      setNotes('');
      setFeedback({
        type: 'success',
        text: `Transferred $${res.transaction.amount} to ${res.transaction.recipientEmail}.`,
      });
      onServerSynced();
      void syncDashboard();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          onSessionInvalidated(err.message);
          return;
        }
        setFeedback({ type: 'error', text: err.message });
      } else if (err instanceof NetworkError) {
        updateOutbox((prev) => [
          ...prev,
          {
            idempotencyKey,
            recipient: normalizedRecipient,
            amount: trimmedAmount,
            notes: trimmedNotes,
            createdAt: new Date().toISOString(),
            status: 'PENDING_SYNC',
            attempts: 1,
            lastError: err.message,
          },
        ]);
        setUsingCachedData(true);
        setRecipient('');
        setAmount('');
        setNotes('');
        setFeedback({
          type: 'warning',
          text: 'Connection dropped mid-request. Saved to Offline Outbox with idempotency protection so retrying will never double-charge.',
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const retryQueuedItem = (key: string) => {
    updateOutbox((prev) =>
      prev.map((q) =>
        q.idempotencyKey === key ? { ...q, status: 'PENDING_SYNC', lastError: undefined } : q
      )
    );
    void flushOutbox().then((didSync) => {
      if (didSync) void syncDashboard();
    });
  };

  const discardQueuedItem = (key: string) => {
    updateOutbox((prev) => prev.filter((q) => q.idempotencyKey !== key));
  };

  return (
    <div className="dashboard-shell">
      <header className="topbar card">
        <div>
          <span className="brand-badge">TrailWallet</span>
          <h1 className="welcome-heading">{welcomeMessage}</h1>
        </div>
        <div className="topbar-actions">
          <span className={`conn-pill ${isOnline ? 'online' : 'offline'}`}>
            {isOnline ? 'Online' : 'Offline — Cave Mode'}
          </span>
          <span className="timer-pill" title="Auto-logout after 15 minutes of inactivity">
            Idle logout: {formatCountdown(remainingSeconds)}
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void flushOutbox().then(() => syncDashboard())}
            disabled={syncing || !isOnline}
          >
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
          <button type="button" className="btn-secondary" onClick={onLogout}>
            Logout
          </button>
        </div>
      </header>

      {usingCachedData && (
        <div className="alert alert-warning" role="status">
          Poor or offline connection detected. Showing cached wallet data
          {lastSyncedAt ? ` (last synced ${new Date(lastSyncedAt).toLocaleTimeString()})` : ''}.
          Transfers you submit will be queued safely and sent automatically once signal returns.
        </div>
      )}

      {feedback && (
        <div className={`alert alert-${feedback.type}`} role="status">
          {feedback.text}
        </div>
      )}

      <div className="grid-two">
        <section className="card">
          <h2>Wallet Balance</h2>
          <div className="balance-amount">
            ${wallet ? wallet.balance : '—'}
          </div>
          <p className="muted">
            {lastSyncedAt
              ? `Last synced: ${new Date(lastSyncedAt).toLocaleString()}`
              : 'Waiting for first sync...'}
          </p>

          <hr className="divider" />

          <h3>Transfer Money</h3>
          <form onSubmit={handleTransferSubmit} className="stack">
            <label className="field">
              <span>Recipient (email)</span>
              <input
                type="email"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="bob@example.com"
                required
              />
            </label>

            <label className="field">
              <span>Amount ($)</span>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="25.50"
                required
              />
            </label>

            <label className="field">
              <span>Notes</span>
              <input
                type="text"
                maxLength={255}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Camp supplies, food, etc."
              />
            </label>

            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting
                ? 'Sending...'
                : isOnline
                  ? 'Send Transfer'
                  : 'Queue Offline Transfer'}
            </button>
          </form>
        </section>

        <section className="card">
          {outbox.length > 0 && (
            <div className="outbox-section">
              <h2>Offline Outbox ({outbox.length})</h2>
              <ul className="tx-list">
                {outbox.map((item) => (
                  <li key={item.idempotencyKey} className="tx-item outbox-item">
                    <div>
                      <strong>To: {item.recipient}</strong>
                      <div className="muted small">
                        ${item.amount} {item.notes ? `• ${item.notes}` : ''}
                      </div>
                      {item.lastError && (
                        <div className="error-text small">{item.lastError}</div>
                      )}
                    </div>
                    <div className="outbox-actions">
                      <span className={`status-tag ${item.status === 'FAILED' ? 'failed' : 'pending'}`}>
                        {item.status === 'FAILED' ? 'Failed' : 'Pending Sync'}
                      </span>
                      <button
                        type="button"
                        className="btn-tiny"
                        onClick={() => retryQueuedItem(item.idempotencyKey)}
                        disabled={!isOnline || syncing}
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        className="btn-tiny danger"
                        onClick={() => discardQueuedItem(item.idempotencyKey)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <hr className="divider" />
            </div>
          )}

          <h2>Recent Transactions</h2>
          {transactions.length === 0 ? (
            <p className="muted">No transfers recorded yet.</p>
          ) : (
            <ul className="tx-list">
              {transactions.map((tx) => (
                <li key={tx.id} className="tx-item">
                  <div>
                    <strong>
                      {tx.direction === 'OUT' ? `To ${tx.counterpartyEmail}` : `From ${tx.counterpartyEmail}`}
                    </strong>
                    {tx.notes && <div className="muted small">{tx.notes}</div>}
                    <div className="muted small">
                      {new Date(tx.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className={`tx-amount ${tx.direction === 'OUT' ? 'out' : 'in'}`}>
                    {tx.direction === 'OUT' ? '-' : '+'}${tx.amount}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
