import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('TrailWallet Frontend', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('validates matching confirmPassword on registration before calling backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<App />);

    fireEvent.click(screen.getByRole('tab', { name: 'Register' }));
    fireEvent.change(screen.getByPlaceholderText('explorer@example.com'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Min 8 chars, letters & numbers'), {
      target: { value: 'Password123' },
    });
    fireEvent.change(screen.getByPlaceholderText('Re-enter password'), {
      target: { value: 'Mismatch123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs in, renders Hello [email], welcome back, and enforces 15-minute inactivity logout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-11-11T10:00:00.000Z'));

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/auth/login')) {
        return jsonResponse({
          token: 'jwt-token-123',
          user: { id: 'user-1', email: 'alice@example.com' },
          inactivityTimeoutSeconds: 900,
        });
      }
      if (url.endsWith('/api/protected')) {
        return jsonResponse({
          message: 'Hello alice@example.com, welcome back',
          user: { id: 'user-1', email: 'alice@example.com' },
          inactivityTimeoutSeconds: 900,
          lastActiveAt: new Date().toISOString(),
          serverTime: new Date().toISOString(),
        });
      }
      if (url.endsWith('/api/wallet')) {
        return jsonResponse({
          wallet: {
            id: 'wallet-1',
            balanceCents: 100000,
            balance: '1000.00',
            updatedAt: new Date().toISOString(),
          },
          transactions: [],
        });
      }
      if (url.endsWith('/api/auth/ping') || url.endsWith('/api/auth/logout')) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: 'Not found' }, 404);
    });

    render(<App />);

    fireEvent.change(screen.getByPlaceholderText('explorer@example.com'), {
      target: { value: 'alice@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter password'), {
      target: { value: 'Password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));

    expect(
      await screen.findByRole('heading', { name: 'Hello alice@example.com, welcome back' })
    ).toBeInTheDocument();
    expect(await screen.findByText('$1000.00')).toBeInTheDocument();

    // Advance 10 minutes, then simulate user activity -> resets 15m timer
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000);
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      vi.advanceTimersByTime(1000);
    });

    // Advance another 10 minutes (20m total since login, 10m since last activity) -> still logged in
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });
    expect(
      screen.getByRole('heading', { name: 'Hello alice@example.com, welcome back' })
    ).toBeInTheDocument();

    // Advance remaining 5+ minutes without activity -> automatically logged out
    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 2000);
    });

    expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/15 minutes of inactivity/i);
  });

  it('queues transfers offline and auto-syncs with Idempotency-Key when signal returns', async () => {
    localStorage.setItem(
      'trailwallet.session',
      JSON.stringify({
        token: 'jwt-token-123',
        user: { id: 'user-1', email: 'alice@example.com' },
        inactivityTimeoutSeconds: 900,
      })
    );
    localStorage.setItem('trailwallet.lastActivityAt', String(Date.now()));

    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    });

    const transferHeaders: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/wallet/transfer')) {
        const headers = new Headers(init?.headers);
        transferHeaders.push(headers.get('Idempotency-Key') || '');
        return jsonResponse(
          {
            idempotentReplay: false,
            transaction: {
              id: 'tx-1',
              direction: 'OUT',
              senderEmail: 'alice@example.com',
              recipientEmail: 'bob@example.com',
              counterpartyEmail: 'bob@example.com',
              amountCents: 2500,
              amount: '25.00',
              notes: 'Cave radio battery',
              idempotencyKey: transferHeaders[0],
              createdAt: new Date().toISOString(),
            },
            wallet: {
              id: 'wallet-1',
              balanceCents: 97500,
              balance: '975.00',
              updatedAt: new Date().toISOString(),
            },
          },
          201
        );
      }
      if (url.endsWith('/api/protected')) {
        return jsonResponse({
          message: 'Hello alice@example.com, welcome back',
          user: { id: 'user-1', email: 'alice@example.com' },
          inactivityTimeoutSeconds: 900,
          lastActiveAt: new Date().toISOString(),
          serverTime: new Date().toISOString(),
        });
      }
      if (url.endsWith('/api/wallet')) {
        return jsonResponse({
          wallet: {
            id: 'wallet-1',
            balanceCents: 97500,
            balance: '975.00',
            updatedAt: new Date().toISOString(),
          },
          transactions: [],
        });
      }
      return jsonResponse({ ok: true });
    });

    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Hello alice@example.com, welcome back' })
    ).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('bob@example.com'), {
      target: { value: 'bob@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('25.50'), {
      target: { value: '25.00' },
    });
    fireEvent.change(screen.getByPlaceholderText('Camp supplies, food, etc.'), {
      target: { value: 'Cave radio battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Queue Offline Transfer' }));

    expect(await screen.findByText(/Offline Outbox \(1\)/)).toBeInTheDocument();
    expect(screen.getByText('Pending Sync')).toBeInTheDocument();

    // Signal returns in the jungle -> window fires online -> auto-flushes queued transfer!
    await act(async () => {
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        value: true,
      });
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(transferHeaders).toHaveLength(1);
      expect(transferHeaders[0]).not.toBe('');
      expect(screen.queryByText(/Offline Outbox/)).not.toBeInTheDocument();
    });
    expect(screen.getByText('$975.00')).toBeInTheDocument();
  });
});
