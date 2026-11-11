import type { AuthSession, CachedDashboard, QueuedTransfer } from '../types';

const SESSION_KEY = 'trailwallet.session';
const LAST_ACTIVITY_KEY = 'trailwallet.lastActivityAt';

function dashboardKey(userId: string) {
  return `trailwallet.dashboard.${userId}`;
}

function outboxKey(userId: string) {
  return `trailwallet.outbox.${userId}`;
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function loadSession(): AuthSession | null {
  return safeJsonParse<AuthSession>(localStorage.getItem(SESSION_KEY));
}

export function saveSession(session: AuthSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(LAST_ACTIVITY_KEY);
}

export function loadLastActivityAt(): number | null {
  const raw = localStorage.getItem(LAST_ACTIVITY_KEY);
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

export function saveLastActivityAt(timestampMs: number): void {
  localStorage.setItem(LAST_ACTIVITY_KEY, String(timestampMs));
}

export function loadCachedDashboard(userId: string): CachedDashboard | null {
  return safeJsonParse<CachedDashboard>(localStorage.getItem(dashboardKey(userId)));
}

export function saveCachedDashboard(userId: string, data: CachedDashboard): void {
  localStorage.setItem(dashboardKey(userId), JSON.stringify(data));
}

export function loadOutbox(userId: string): QueuedTransfer[] {
  return safeJsonParse<QueuedTransfer[]>(localStorage.getItem(outboxKey(userId))) ?? [];
}

export function saveOutbox(userId: string, items: QueuedTransfer[]): void {
  localStorage.setItem(outboxKey(userId), JSON.stringify(items));
}

export const STORAGE_KEYS = {
  SESSION_KEY,
  LAST_ACTIVITY_KEY,
};

