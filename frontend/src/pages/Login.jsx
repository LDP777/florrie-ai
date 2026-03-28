import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';

/**
 * Login / Signup — clean, single-screen auth.
 * Supports email+password with Supabase Auth.
 * Dev mode fallback when Supabase isn't configured.
 */

export default function Login({ supabase }) {
  const [mode, setMode] = useState('login'); // login | signup | confirm
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
        // Dev mode — no Supabase, just redirect
        navigate('/');
        return;
      }

      if (mode === 'login') {
        const { error: authError } = await supabase.auth.signInWithPassword({
          email, password
        });
        if (authError) throw authError;
      } else {
        // Signup directly with Supabase Auth
        const { data, error: signupError } = await supabase.auth.signUp({
          email, password
        });
        if (signupError) throw signupError;

        // If email confirmation is required, tell the user
        if (data?.user?.identities?.length === 0) {
          throw new Error('An account with this email already exists');
        }

        // Check if email confirmation is required (user exists but no session)
        if (data?.user && !data?.session) {
          setError('');
          setMode('confirm');
          return;
        }

        // If Supabase auto-confirms (default for new projects), we're logged in
        // New user → onboarding
        navigate('/onboarding');
        return;
      }

      navigate('/');
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.logoSection}>
        <h1 style={styles.logo}>florrie.ai</h1>
        <p style={styles.tagline}>Your AI team, sorted</p>
      </div>

      {mode === 'confirm' ? (
        <div style={styles.form}>
          <h2 style={styles.formTitle}>Check your email</h2>
          <p style={{ fontSize: 14, color: '#666', lineHeight: 1.5, marginBottom: 20 }}>
            We've sent a confirmation link to <strong>{email}</strong>. Click it to confirm your account, then come back and sign in.
          </p>
          <button
            type="button"
            onClick={() => { setMode('login'); setEmail(''); setPassword(''); setError(''); }}
            style={styles.submitBtn}
          >
            Back to Sign In
          </button>
        </div>
      ) : (
      <form onSubmit={handleSubmit} style={styles.form}>
        <h2 style={styles.formTitle}>
          {mode === 'login' ? 'Welcome back' : 'Create your account'}
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
        </div>

        {error && <p style={styles.error}>{error}</p>}

        <button type="submit" disabled={loading} style={styles.submitBtn}>
          {loading ? 'Please wait...' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        {/* Divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0' }}>
          <div style={{ flex: 1, height: 1, background: '#E8E4E0' }} />
          <span style={{ fontSize: 12, color: '#AAA5A0' }}>or</span>
          <div style={{ flex: 1, height: 1, background: '#E8E4E0' }} />
        </div>

        {/* Google Sign In */}
        <button
          type="button"
          onClick={async () => {
            if (!supabase) { navigate('/'); return; }
            const { error } = await supabase.auth.signInWithOAuth({
              provider: 'google',
              options: { redirectTo: window.location.origin }
            });
            if (error) setError(error.message);
          }}
          style={{
            width: '100%', padding: '12px 0', borderRadius: 12,
            border: '1.5px solid #E8E4E0', background: '#fff',
            fontSize: 14, fontWeight: 500, cursor: 'pointer',
            fontFamily: 'inherit', color: '#2D2A26',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          Continue with Google
        </button>

        <button
          type="button"
          onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); }}
          style={styles.switchBtn}
        >
          {mode === 'login'
            ? "Don't have an account? Sign up"
            : 'Already have an account? Sign in'}
        </button>
      </form>
      )}

      {mode === 'signup' && (
        <p style={styles.trialNote}>14-day free trial. No card required.</p>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: '#FAF8F5',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
    padding: '0 24px',
    maxWidth: 400,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center'
  },
  logoSection: {
    textAlign: 'center',
    marginBottom: 32
  },
  logo: {
    fontSize: 36,
    fontWeight: 700,
    color: '#C76B8A',
    margin: '0 0 4px',
    letterSpacing: '-0.03em'
  },
  tagline: {
    fontSize: 14,
    color: '#AAA5A0',
    margin: 0
  },
  form: {
    background: '#fff',
    borderRadius: 16,
    padding: 24,
    boxShadow: '0 2px 8px rgba(0,0,0,0.04)'
  },
  formTitle: {
    fontSize: 18,
    fontWeight: 600,
    margin: '0 0 20px',
    color: '#2D2A26'
  },
  formGroup: { marginBottom: 14 },
  label: {
    display: 'block',
    fontSize: 12,
    color: '#AAA5A0',
    marginBottom: 4,
    fontWeight: 500
  },
  input: {
    width: '100%',
    padding: '12px 14px',
    borderRadius: 10,
    border: '1.5px solid #F0ECE8',
    fontSize: 15,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.2s'
  },
  error: {
    fontSize: 13,
    color: '#E57373',
    margin: '0 0 10px',
    padding: '8px 12px',
    background: '#FEF2F2',
    borderRadius: 8
  },
  submitBtn: {
    width: '100%',
    padding: '14px 0',
    borderRadius: 12,
    border: 'none',
    background: '#C76B8A',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    marginBottom: 10
  },
  switchBtn: {
    width: '100%',
    padding: '10px 0',
    background: 'none',
    border: 'none',
    color: '#C76B8A',
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  trialNote: {
    textAlign: 'center',
    fontSize: 12,
    color: '#C4BDB6',
    marginTop: 16
  }
};
