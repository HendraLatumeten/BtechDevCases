import type { AuthSession, WalletInfo, WalletTransaction } from '../types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'API_ERROR'
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NetworkError extends Error {
  constructor(message = 'Network unreachable or request timed out') {
    super(message);
    this.name = 'NetworkError';
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || '';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ResilientFetchOptions extends RequestInit {
  token?: string;
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
}

export async function resilientFetch<T>(
  path: string,
  options: ResilientFetchOptions = {}
): Promise<T> {
  const {
    token,
    timeoutMs = 8000,
    retries = 2,
    baseDelayMs = 300,
    headers: customHeaders,
    ...rest
  } = options;

  const method = (rest.method || 'GET').toUpperCase();
  const headers = new Headers(customHeaders);
  if (!headers.has('Content-Type') && rest.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // Only retry safe/idempotent requests automatically on transient network/5xx faults.
  const canRetry = method === 'GET' || method === 'HEAD' || headers.has('Idempotency-Key');
  const maxAttempts = canRetry ? retries + 1 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        ...rest,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const contentType = response.headers.get('content-type') || '';
      const payload = contentType.includes('application/json')
        ? ((await response.json()) as Record<string, unknown>)
        : null;

      if (response.ok) {
        return payload as T;
      }

      if (response.status >= 500 && attempt + 1 < maxAttempts) {
        await wait(baseDelayMs * Math.pow(2, attempt));
        continue;
      }

      const errorMessage =
        (payload && typeof payload.error === 'string' && payload.error) ||
        `Request failed (${response.status})`;
      const errorCode =
        (payload && typeof payload.code === 'string' && payload.code) || 'API_ERROR';

      throw new ApiError(response.status, errorMessage, errorCode);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof ApiError) {
        throw err;
      }

      if (attempt + 1 < maxAttempts) {
        await wait(baseDelayMs * Math.pow(2, attempt));
        continue;
      }

      const msg =
        err instanceof DOMException && err.name === 'AbortError'
          ? 'Connection timed out (weak signal)'
          : 'Unable to reach server (offline or poor connection)';
      throw new NetworkError(msg);
    }
  }

  throw new NetworkError();
}

export async function registerUser(input: {
  email: string;
  password: string;
  confirmPassword: string;
}) {
  return resilientFetch<{
    user: { id: string; email: string; createdAt: string };
    wallet: { balanceCents: number; balance: string };
  }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
    retries: 0,
  });
}

export async function loginUser(input: { email: string; password: string }) {
  return resilientFetch<AuthSession>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
    retries: 0,
  });
}

export async function logoutUser(token: string) {
  return resilientFetch<{ ok: boolean }>('/api/auth/logout', {
    method: 'POST',
    token,
    retries: 0,
    timeoutMs: 3000,
  });
}

export async function pingActivity(token: string) {
  return resilientFetch<{ ok: boolean; lastActiveAt: string }>('/api/auth/ping', {
    method: 'POST',
    token,
    retries: 0,
    timeoutMs: 4000,
  });
}

export async function fetchProtectedWelcome(token: string) {
  return resilientFetch<{
    message: string;
    user: { id: string; email: string };
    inactivityTimeoutSeconds: number;
    lastActiveAt: string;
    serverTime: string;
  }>('/api/protected', {
    method: 'GET',
    token,
  });
}

export async function fetchWallet(token: string) {
  return resilientFetch<{
    wallet: WalletInfo;
    transactions: WalletTransaction[];
  }>('/api/wallet', {
    method: 'GET',
    token,
  });
}

export async function transferFunds(
  token: string,
  input: {
    recipient: string;
    amount: string;
    notes: string;
    idempotencyKey: string;
  }
) {
  return resilientFetch<{
    idempotentReplay: boolean;
    transaction: WalletTransaction;
    wallet: WalletInfo;
  }>('/api/wallet/transfer', {
    method: 'POST',
    token,
    headers: {
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify({
      recipient: input.recipient,
      amount: input.amount,
      notes: input.notes,
    }),
  });
}

