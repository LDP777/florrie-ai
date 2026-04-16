import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';

/**
 * Login / Signup / Forgot Password — single-screen auth.
 *
 * Security hardening:
 *   - All error messages are generic — never reveals whether an email exists
 *   - Signup + forgot password show the same "check your email" message
 *     regardless of whether the account exists (prevents enumeration)
 *   - Rate limiting handled server-side via authLimiter middleware
 */

// Generic messages that never leak account existence
const GENERIC_AUTH_ERROR = 'Invalid email or password. Please try again.';
const GENERIC_SIGNUP_ERROR = 'Something went wrong. Please try again.';
const RESET_SENT_MESSAGE = "If an account exists with that email, you'll receive a password reset link shortly. Check your inbox (and spam).";

export default function Login({ supabase }) {
  const [mode, setMode] = useState('login'); // login | signup | confirm | forgot | reset-sent
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (!supabase) {
        navigate('/');
        return;
      }

      if (mode === 'login') {
        const { error: authError } = await supabase.auth.signInWithPassword({
          email, password
        });
        if (authError) {
          // Never forward the raw Supabase error — always use generic message
          setError(GENERIC_AUTH_ERROR);
          return;
        }
        navigate('/');

      } else if (mode === 'signup') {
        const { data, error: signupError } = await supabase.auth.signUp({
          email, password
        });

        if (signupError) {
          // Supabase may say "User already registered" — never expose that
          setError(GENERIC_SIGNUP_ERROR);
          return;
        }

        // Whether the email exists or not, show the same confirmation screen.
        // Supabase returns identities=[] for existing accounts — we treat it
        // identically to a real signup to prevent enumeration.
        if (data?.user && !data?.session) {
          setMode('confirm');
          return;
        }

        // Auto-confirmed (Supabase setting) → go to onboarding
        navigate('/onboarding');

      } else if (mode === 'forgot') {
        await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/update-password`,
        });
        // Always show success — even if email doesn't exist
        setMode('reset-sent');
      }
    } catch {
      setError(GENERIC_AUTH_ERROR);
    } finally {
      setLoading(false);
    }
  }

  function switchMode(newMode) {
    setMode(newMode);
    setError('');
    if (newMode !== 'forgot') setPassword('');
  }

  // Confirmation screen (shared for signup + reset)
  if (mode === 'confirm') {
    return (
      <div style={styles.page}>
        <div style={styles.logoSection}>
          <h1 style={styles.logo}>florrie.ai</h1>
          <div style={styles.goldBar} />
        </div>
        <div style={styles.form}>
          <h2 style={styles.formTitle}>Check your email</h2>
          <p style={styles.confirmText}>
            We've sent a confirmation link to <strong>{email}</strong>. Click it to confirm your account, then come back and sign in.
          </p>
          <button
            type="button"
            onClick={() => switchMode('login')}
            style={styles.submitBtn}
          >
            Back to Sign In
          </button>
        </div>
      </div>
    );
  }

  // Reset email sent screen
  if (mode === 'reset-sent') {
    return (
      <div style={styles.page}>
        <div style={styles.logoSection}>
          <h1 style={styles.logo}>florrie.ai</h1>
          <div style={styles.goldBar} />
        </div>
        <div style={styles.form}>
          <h2 style={styles.formTitle}>Check your email</h2>
          <p style={styles.confirmText}>{RESET_SENT_MESSAGE}</p>
          <button
            type="button"
            onClick={() => switchMode('login')}
            style={styles.submitBtn}
          >
            Back to Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.logoSection}>
        <h1 style={styles.logo}>florrie.ai</h1>
        <div style={styles.goldBar} />
        <p style={styles.tagline}>Your AI team, sorted</p>
      </div>

      <form onSubmit={handleSubmit} style={styles.form}>
        <h2 style={styles.formTitle}>
          {mode === 'login' ? 'Welcome back' : mode === 'signup' ? 'Create your account' : 'Reset your password'}
        </h2>

        <div style={styles.formGroup}>
          <label style={styles.label}>Email</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoFocus
            style={styles.input}
          />
        </div>

        {mode !== 'forgot' && (
          <div style={styles.formGroup}>
            <label style={styles.label}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={mode === 'signup' ? 'At least 8 characters' : ''}
              required
              minLength={mode === 'signup' ? 8 : undefined}
              style={styles.input}
            />
            {mode === 'login' && (
              <button
                type="button"
                onClick={() => switchMode('forgot')}
                style={styles.forgotLink}
              >
                Forgot password?
              </button>
            )}
          </div>
        )}

        {mode === 'forgot' && (
          <p style={styles.forgotHint}>
            Enter the email you signed up with and we'll send you a reset link.
          </p>
        )}

        {error && <p style={styles.error}>{error}</p>}

        <button type="submit" disabled={loading} style={styles.submitBtn}>
          {loading
            ? 'Please wait...'
            : mode === 'login' ? 'Sign in'
            : mode === 'signup' ? 'Create account'
            : 'Send reset link'}
        </button>

        {mode !== 'forgot' && (
          <>
            {/* Divider */}
            <div style={styles.divider}>
              <div style={styles.dividerLine} />
              <span style={styles.dividerText}>or</span>
              <div style={styles.dividerLine} />
            </div>

            {/* Google Sign In */}
            <button
              type="button"
              onClick={async () => {
                if (!supabase) { navigate('/'); return; }
                const { error: oauthErr } = await supabase.auth.signInWithOAuth({
                  provider: 'google',
                  options: { redirectTo: window.location.origin }
                });
                if (oauthErr) setError(GENERIC_AUTH_ERROR);
              }}
              style={styles.googleBtn}
            >
              <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
              Continue with Google
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
          style={styles.switchBtn}
        >
          {mode === 'forgot'
            ? 'Back to Sign In'
            : mode === 'login'
            ? "Don't have an account? Sign up"
            : 'Already have an account? Sign in'}
        </button>
      </form>

      {mode === 'signup' && (
        <p style={styles.trialNote}>14-day free trial. No card required.</p>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg)',
    fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)",
    padding: '0 24px',
    maxWidth: 400,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    animation: 'fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)'
  },
  logoSection: { textAlign: 'center', marginBottom: 32 },
  logo: {
    fontSize: 36, fontWeight: 700, color: 'var(--accent)',
    margin: '0 0 4px', letterSpacing: '-0.03em',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)"
  },
  goldBar: { width: 40, height: 2, background: 'var(--gold, #C9A96E)', margin: '12px auto 0', borderRadius: 1 },
  tagline: { fontSize: 14, color: 'var(--text-muted)', margin: 0 },
  form: {
    background: 'var(--bg-card)', borderRadius: 20, padding: 24,
    boxShadow: 'var(--shadow-lg)', position: 'relative'
  },
  formTitle: {
    fontSize: 18, fontWeight: 600, margin: '0 0 20px',
    color: 'var(--text-primary)',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    letterSpacing: '-0.02em'
  },
  formGroup: { marginBottom: 14 },
  label: {
    display: 'block', fontSize: 12, color: 'var(--text-muted)',
    marginBottom: 4, fontWeight: 500
  },
  input: {
    width: '100%', padding: '12px 14px', borderRadius: 10,
    border: '1.5px solid var(--border)', fontSize: 15, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease'
  },
  forgotLink: {
    display: 'block', marginTop: 6, padding: 0, background: 'none',
    border: 'none', color: 'var(--accent)', fontSize: 12, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'right',
  },
  forgotHint: {
    fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5,
    margin: '0 0 14px',
  },
  error: {
    fontSize: 13, color: 'var(--danger)', margin: '0 0 10px',
    padding: '8px 12px', background: 'var(--danger-bg)', borderRadius: 8
  },
  submitBtn: {
    width: '100%', padding: '14px 0', borderRadius: 12, border: 'none',
    background: 'var(--accent)', color: 'var(--bg-card)', fontSize: 15,
    fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 10,
    boxShadow: '0 2px 8px rgba(199, 107, 138, 0.25)',
    transition: 'all 0.15s ease'
  },
  divider: { display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0' },
  dividerLine: { flex: 1, height: 1, background: 'var(--border)' },
  dividerText: { fontSize: 12, color: 'var(--text-muted)' },
  googleBtn: {
    width: '100%', padding: '12px 0', borderRadius: 12,
    border: '1.5px solid var(--border)', background: 'var(--bg-card)',
    fontSize: 14, fontWeight: 500, cursor: 'pointer',
    fontFamily: 'inherit', color: 'var(--text-primary)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  switchBtn: {
    width: '100%', padding: '10px 0', background: 'none', border: 'none',
    color: 'var(--accent)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit'
  },
  trialNote: { textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', marginTop: 16 },
  confirmText: {
    fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 20,
  },
};
