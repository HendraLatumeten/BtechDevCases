import { useCallback, useEffect, useRef, useState } from 'react';
import {
  STORAGE_KEYS,
  loadLastActivityAt,
  saveLastActivityAt,
} from '../lib/storage';

interface UseInactivityLogoutOptions {
  enabled: boolean;
  timeoutSeconds: number;
  isOnline: boolean;
  onTimeout: () => void;
  onKeepAlive?: () => Promise<void>;
}

export function useInactivityLogout({
  enabled,
  timeoutSeconds,
  isOnline,
  onTimeout,
  onKeepAlive,
}: UseInactivityLogoutOptions) {
  const timeoutMs = Math.max(1000, timeoutSeconds * 1000);
  const [remainingSeconds, setRemainingSeconds] = useState(timeoutSeconds);

  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const onKeepAliveRef = useRef(onKeepAlive);
  onKeepAliveRef.current = onKeepAlive;

  const lastActivityRef = useRef<number>(Date.now());
  const lastServerSyncRef = useRef<number>(Date.now());
  const timedOutRef = useRef(false);

  const markActivity = useCallback(() => {
    if (!enabled || timedOutRef.current) return;
    const now = Date.now();
    // Throttle writes to once per second to keep CPU/battery usage minimal.
    if (now - lastActivityRef.current < 1000) return;
    lastActivityRef.current = now;
    saveLastActivityAt(now);
    setRemainingSeconds(timeoutSeconds);
  }, [enabled, timeoutSeconds]);

  const markServerSynced = useCallback(() => {
    const now = Date.now();
    lastServerSyncRef.current = now;
    lastActivityRef.current = now;
    saveLastActivityAt(now);
    setRemainingSeconds(timeoutSeconds);
  }, [timeoutSeconds]);

  useEffect(() => {
    if (!enabled) {
      timedOutRef.current = false;
      setRemainingSeconds(timeoutSeconds);
      return;
    }

    const stored = loadLastActivityAt();
    const now = Date.now();
    if (stored && now - stored >= timeoutMs) {
      timedOutRef.current = true;
      setRemainingSeconds(0);
      onTimeoutRef.current();
      return;
    }

    const initialActivity = stored ?? now;
    lastActivityRef.current = initialActivity;
    lastServerSyncRef.current = initialActivity;
    if (!stored) {
      saveLastActivityAt(initialActivity);
    }

    const events: (keyof WindowEventMap)[] = [
      'pointerdown',
      'keydown',
      'mousemove',
      'scroll',
      'touchstart',
    ];
    const handleActivity = () => markActivity();

    for (const evt of events) {
      window.addEventListener(evt, handleActivity, { passive: true });
    }

    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.LAST_ACTIVITY_KEY && e.newValue) {
        const synced = Number(e.newValue);
        if (Number.isFinite(synced) && synced > lastActivityRef.current) {
          lastActivityRef.current = synced;
        }
      } else if (e.key === STORAGE_KEYS.SESSION_KEY && e.newValue === null) {
        timedOutRef.current = true;
        onTimeoutRef.current();
      }
    };
    window.addEventListener('storage', handleStorage);

    const heartbeatIntervalMs = Math.min(240_000, Math.floor(timeoutMs / 3));

    const timer = window.setInterval(() => {
      const tickNow = Date.now();
      const elapsed = tickNow - lastActivityRef.current;
      const left = Math.max(0, Math.ceil((timeoutMs - elapsed) / 1000));
      setRemainingSeconds(left);

      if (elapsed >= timeoutMs && !timedOutRef.current) {
        timedOutRef.current = true;
        onTimeoutRef.current();
        return;
      }

      if (
        isOnline &&
        onKeepAliveRef.current &&
        lastActivityRef.current > lastServerSyncRef.current &&
        tickNow - lastServerSyncRef.current >= heartbeatIntervalMs
      ) {
        lastServerSyncRef.current = tickNow;
        void onKeepAliveRef.current().catch(() => {
          // If network drops mid-ping in a cave, keep local session until timeout or reconnect.
        });
      }
    }, 1000);

    return () => {
      for (const evt of events) {
        window.removeEventListener(evt, handleActivity);
      }
      window.removeEventListener('storage', handleStorage);
      window.clearInterval(timer);
    };
  }, [enabled, isOnline, markActivity, timeoutMs, timeoutSeconds]);

  return {
    remainingSeconds,
    markServerSynced,
  };
}

