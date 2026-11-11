import { useCallback, useEffect, useState } from 'react';
import { AuthView } from './components/AuthView';
import { DashboardView } from './components/DashboardView';
import { useInactivityLogout } from './hooks/useInactivityLogout';
import { logoutUser, pingActivity } from './lib/api';
import {
  clearSession,
  loadSession,
  saveLastActivityAt,
  saveSession,
} from './lib/storage';
import type { AuthSession } from './types';

export function App() {
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [logoutNotice, setLogoutNotice] = useState<string | null>(null);

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const performLogout = useCallback(
    (reason?: string) => {
      const activeToken = session?.token;
      clearSession();
      setSession(null);
      setLogoutNotice(reason ?? null);
      if (activeToken && navigator.onLine) {
        void logoutUser(activeToken).catch(() => undefined);
      }
    },
    [session?.token]
  );

  const handleInactivityTimeout = useCallback(() => {
    performLogout('You were logged out after 15 minutes of inactivity.');
  }, [performLogout]);

  const handleKeepAlive = useCallback(async () => {
    if (!session?.token) return;
    await pingActivity(session.token);
  }, [session?.token]);

  const { remainingSeconds, markServerSynced } = useInactivityLogout({
    enabled: Boolean(session),
    timeoutSeconds: session?.inactivityTimeoutSeconds ?? 900,
    isOnline,
    onTimeout: handleInactivityTimeout,
    onKeepAlive: handleKeepAlive,
  });

  const handleAuthenticated = useCallback((nextSession: AuthSession) => {
    saveSession(nextSession);
    saveLastActivityAt(Date.now());
    setLogoutNotice(null);
    setSession(nextSession);
  }, []);

  const handleSessionInvalidated = useCallback(
    (reason: string) => performLogout(reason),
    [performLogout]
  );

  const handleLogout = useCallback(
    () => performLogout('You have signed out.'),
    [performLogout]
  );

  if (!session) {
    return (
      <AuthView
        initialNotice={logoutNotice}
        isOnline={isOnline}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  return (
    <DashboardView
      session={session}
      isOnline={isOnline}
      remainingSeconds={remainingSeconds}
      onServerSynced={markServerSynced}
      onSessionInvalidated={handleSessionInvalidated}
      onLogout={handleLogout}
    />
  );
}

export default App;

