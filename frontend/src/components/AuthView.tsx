import { useState, type FormEvent } from 'react';
import { ApiError, NetworkError, loginUser, registerUser } from '../lib/api';
import type { AuthSession } from '../types';

interface AuthViewProps {
  initialNotice?: string | null;
  isOnline: boolean;
  onAuthenticated: (session: AuthSession) => void;
}

export function AuthView({ initialNotice, isOnline, onAuthenticated }: AuthViewProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  const switchMode = (nextMode: 'login' | 'register') => {
    setMode(nextMode);
    setError(null);
    setSuccessNotice(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessNotice(null);

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setError('Please enter a valid email address.');
      return;
    }

    if (mode === 'register') {
      if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        setError('Password must be at least 8 characters and include a letter and a number.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    } else if (!password) {
      setError('Password is required.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'register') {
        const registered = await registerUser({
          email: normalizedEmail,
          password,
          confirmPassword,
        });
        setSuccessNotice(
          `Account created for ${registered.user.email} with $${registered.wallet.balance} starting balance. You can sign in now.`
        );
        setMode('login');
        setConfirmPassword('');
      } else {
        const session = await loginUser({ email: normalizedEmail, password });
        onAuthenticated(session);
      }
    } catch (err) {
      if (err instanceof ApiError || err instanceof NetworkError) {
        setError(err.message);
      } else {
        setError('Unexpected error occurred. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="brand-header">
        <span className="brand-badge">TrailWallet</span>
        <span className={`conn-pill ${isOnline ? 'online' : 'offline'}`}>
          {isOnline ? 'Online' : 'Offline — Signal Lost'}
        </span>
      </div>

      <div className="card auth-card">
        <h1>{mode === 'login' ? 'Sign In' : 'Create Account'}</h1>
        <p className="muted">
          Lightweight JWT Auth &amp; Wallet built for low-connectivity environments.
        </p>

        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={`tab-btn ${mode === 'login' ? 'active' : ''}`}
            onClick={() => switchMode('login')}
          >
            Login
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            className={`tab-btn ${mode === 'register' ? 'active' : ''}`}
            onClick={() => switchMode('register')}
          >
            Register
          </button>
        </div>

        {initialNotice && !error && !successNotice && (
          <div className="alert alert-warning" role="status">
            {initialNotice}
          </div>
        )}
        {successNotice && (
          <div className="alert alert-success" role="status">
            {successNotice}
          </div>
        )}
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="stack">
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="explorer@example.com"
              autoComplete="email"
              required
            />
          </label>

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'Min 8 chars, letters & numbers' : 'Enter password'}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
            />
          </label>

          {mode === 'register' && (
            <label className="field">
              <span>Confirm Password</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                autoComplete="new-password"
                required
              />
            </label>
          )}

          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting
              ? 'Please wait...'
              : mode === 'login'
                ? 'Login'
                : 'Register'}
          </button>
        </form>
      </div>
    </div>
  );
}

