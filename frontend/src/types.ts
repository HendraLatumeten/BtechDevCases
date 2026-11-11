export interface User {
  id: string;
  email: string;
}

export interface AuthSession {
  token: string;
  user: User;
  inactivityTimeoutSeconds: number;
}

export interface WalletInfo {
  id: string;
  balanceCents: number;
  balance: string;
  updatedAt: string;
}

export interface WalletTransaction {
  id: string;
  direction: 'IN' | 'OUT';
  senderEmail: string;
  recipientEmail: string;
  counterpartyEmail: string;
  amountCents: number;
  amount: string;
  notes: string;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface CachedDashboard {
  welcomeMessage: string;
  wallet: WalletInfo;
  transactions: WalletTransaction[];
  lastSyncedAt: string;
}

export interface QueuedTransfer {
  idempotencyKey: string;
  recipient: string;
  amount: string;
  notes: string;
  createdAt: string;
  status: 'PENDING_SYNC' | 'FAILED';
  attempts: number;
  lastError?: string;
}

