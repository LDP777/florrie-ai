import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';
import { isIOSNative } from '../lib/platform.js';

/**
 * Login / Signup / Forgot Password, single-screen auth.
 *
 * iOS App Store compliance (Guideline 3.1.3(b) Multiplatform Services):
 *   - On native iOS, the signup mode is hidden entirely. Sign-in only.
 *   - No "create your account" copy, no link to florrie.ai, no trial pitch.
 *   - Existing users can still sign in. New users go to florrie.ai on the web.
 *
 * Apple Guideline 4.8 Sign in with Apple:
 *   - Because Google sign-in is offered, Sign in with Apple is mandatory and
 *     at-least-equal in prominence. We render the Apple button above Google.
 *   - On native iOS we use the @capacitor-community/apple-sign-in plugin so the
 *     user gets the native Apple ID sheet (not a Safari View Controller).
 *   - On web we fall back to supabase.auth.signInWithOAuth({ provider: 'apple' }).
 *
 * Configuration required outside this file (see commit message for details):
 *   1. Apple Developer Portal: register a Services ID for florrie.ai, enable
 *      Sign In with Apple, generate a .p8 Sign In Key.
 *   2. Supabase Dashboard: Authentication > Providers > Apple, enable and add
 *      the Services ID, Team ID, Key ID, and .p8 contents.
 *
 * Security hardening:
 *   - All error messages are generic, never reveals whether an email exists
 *   - Signup + forgot password show the same "check your email" message
 *     regardless of whether the account exists (prevents enumeration)
 *   - Rate limiting handled server-side via authLimiter middleware
 */

// Generic messages that never leak account existence
const GENERIC_AUTH_ERROR = 'Invalid email or password. Please try again.';
const GENERIC_SIGNUP_ERROR = 'Something went wrong. Please try again.';
const RESET_SENT_MESSAGE = "If an account exists with that email, you'll receive a password reset link shortly. Check your inbox (and spam).";
const APPLE_NOT_CONFIGURED_MESSAGE = 'Apple sign-in coming soon. Use email or Google for now.';

export default function Login({ supabase }) {
  const iosNative = isIOSNative();
  // On iOS the only allowed modes are login + forgot + reset-sent. Signup is suppressed.
  const [mode, setMode] = useState('login'); // login | signup | confirm | forgot | reset-sent
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setInfo('');
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
          // Never forward the raw Supabase error, always use generic message
          setError(GENERIC_AUTH_ERROR);
          return;
        }
        navigate('/');

      } else if (mode === 'signup') {
        // Signup mode never renders on iOS native (see render guard below),
        // but the handler stays defensive in case someone toggles state.
        if (iosNative) {
          setError(GENERIC_SIGNUP_ERROR);
          return;
        }
        const { data, error: signupError } = await supabase.auth.signUp({
          email, password
        });

        if (signupError) {
          // Supabase may say "User already registered", never expose that
          setError(GENERIC_SIGNUP_ERROR);
          return;
        }

        // Whether the email exists or not, show the same confirmation screen.
        // Supabase returns identities=[] for existing accounts, we treat it
        // identically to a real signup to prevent enumeration.
        if (data?.user && !data?.session) {
          setMode('confirm');
          return;
        }

        // Auto-confirmed (Supabase setting), go to onboarding
        navigate('/onboarding');

      } else if (mode === 'forgot') {
        await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/update-password`,
        });
        // Always show success, even if email doesn't exist
        setMode('reset-sent');
      }
    } catch {
      setError(GENERIC_AUTH_ERROR);
    } finally {
      setLoading(false);
    }
  }

  function switchMode(newMode) {
    // Defensive: never allow a switch into signup mode on iOS native.
    if (iosNative && newMode === 'signup') return;
    setMode(newMode);
    setError('');
    setInfo('');
    if (newMode !== 'forgot') setPassword('');
  }

  async function handleGoogle() {
    if (!supabase) { navigate('/'); return; }
    try {
      const { error: oauthErr } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin }
      });
      if (oauthErr) setError(GENERIC_AUTH_ERROR);
    } catch {
      setError(GENERIC_AUTH_ERROR);
    }
  }

  async function handleApple() {
    if (!supabase) { navigate('/'); return; }
    setError('');
    setInfo('');
    setAppleLoading(true);
    try {
      if (iosNative) {
        // Native iOS path: use the Capacitor plugin to show the Apple ID sheet,
        // get an identity token, then exchange it with Supabase.
        let SignInWithApple;
        try {
          ({ SignInWithApple } = await import('@capacitor-community/apple-sign-in'));
        } catch {
          // Plugin not installed yet (cap sync pending), fail gracefully.
          setInfo(APPLE_NOT_CONFIGURED_MESSAGE);
          return;
        }

        const options = {
          clientId: 'ai.florrie.app',
          redirectURI: `${window.location.origin}/login`,
          scopes: 'email name',
          state: '',
          nonce: cryptoNonce(),
        };

        const result = await SignInWithApple.authorize(options);
        const idToken = result?.response?.identityToken;
        if (!idToken) {
          setError('Apple sign-in was cancelled.');
          return;
        }

        const { error: sbErr } = await supabase.auth.signInWithIdToken({
          provider: 'apple',
          token: idToken,
          nonce: options.nonce,
        });
        if (sbErr) {
          // Most common cause: Apple provider not configured in Supabase yet.
          setInfo(APPLE_NOT_CONFIGURED_MESSAGE);
          return;
        }
        navigate('/');
      } else {
        // Web path: standard OAuth redirect to Apple.
        const { error: oauthErr } = await supabase.auth.signInWithOAuth({
          provider: 'apple',
          options: { redirectTo: window.location.origin }
        });
        if (oauthErr) {
          setInfo(APPLE_NOT_CONFIGURED_MESSAGE);
        }
      }
    } catch (err) {
      // User-cancelled flows on iOS throw with code 1001, treat as silent dismiss.
      const code = err?.code || err?.error;
      if (code === 'ERR_CANCELED' || code === '1001' || code === 1001) {
        // silent
      } else {
        setInfo(APPLE_NOT_CONFIGURED_MESSAGE);
      }
    } finally {
      setAppleLoading(false);
    }
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

  // On iOS native, force login mode regardless of what state says.
  const effectiveMode = iosNative && mode === 'signup' ? 'login' : mode;

  return (
    <div style={styles.page}>
      <div style={styles.logoSection}>
        <h1 style={styles.logo}>florrie.ai</h1>
        <div style={styles.goldBar} />
        <p style={styles.tagline}>
          {iosNative ? 'Sign in to continue' : 'Your AI team, sorted'}
        </p>
      </div>

      <form onSubmit={handleSubmit} style={styles.form}>
        <h2 style={styles.formTitle}>
          {effectiveMode === 'login' ? 'Welcome back' : effectiveMode === 'signup' ? 'Create your account' : 'Reset your password'}
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

        {effectiveMode !== 'forgot' && (
          <div style={styles.formGroup}>
            <label style={styles.label}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={effectiveMode === 'signup' ? 'At least 8 characters' : ''}
              required
              minLength={effectiveMode === 'signup' ? 8 : undefined}
              style={styles.input}
            />
            {effectiveMode === 'login' && (
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

        {effectiveMode === 'forgot' && (
          <p style={styles.forgotHint}>
            Enter the email you signed up with and we'll send you a reset link.
          </p>
        )}

        {error && <p style={styles.error}>{error}</p>}
        {info && <p style={styles.info}>{info}</p>}

        <button type="submit" disabled={loading} style={styles.submitBtn}>
          {loading
            ? 'Please wait...'
            : effectiveMode === 'login' ? 'Sign in'
            : effectiveMode === 'signup' ? 'Create account'
            : 'Send reset link'}
        </button>

        {effectiveMode !== 'forgot' && (
          <>
            {/* Divider */}
            <div style={styles.divider}>
              <div style={styles.dividerLine} />
              <span style={styles.dividerText}>or</span>
              <div style={styles.dividerLine} />
            </div>

            {/* Sign in with Apple, must be at least as prominent as Google
                per Apple HIG. Placed above Google to satisfy that requirement. */}
            <button
              type="button"
              onClick={handleApple}
              disabled={appleLoading}
              style={{ ...styles.appleBtn, opacity: appleLoading ? 0.7 : 1 }}
              aria-label="Continue with Apple"
            >
              <svg width="16" height="18" viewBox="0 0 384 512" aria-hidden="true">
                <path
                  fill="#ffffff"
                  d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"
                />
              </svg>
              Continue with Apple
            </button>

            {/* Google Sign In */}
            <button
              type="button"
              onClick={handleGoogle}
              style={styles.googleBtn}
            >
              <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
              Continue with Google
            </button>
          </>
        )}

        {/* Mode switcher: hide signup toggle entirely on iOS native */}
        {!iosNative && (
          <button
            type="button"
            onClick={() => switchMode(effectiveMode === 'login' ? 'signup' : 'login')}
            style={styles.switchBtn}
          >
            {effectiveMode === 'forgot'
              ? 'Back to Sign In'
              : effectiveMode === 'login'
              ? "Don't have an account? Sign up"
              : 'Already have an account? Sign in'}
          </button>
        )}
        {iosNative && effectiveMode === 'forgot' && (
          <button
            type="button"
            onClick={() => switchMode('login')}
            style={styles.switchBtn}
          >
            Back to Sign In
          </button>
        )}
      </form>

      {effectiveMode === 'signup' && !iosNative && (
        <p style={styles.trialNote}>14-day free trial. No card required.</p>
      )}
    </div>
  );
}

/**
 * Generate a cryptographic nonce for the Apple Sign-In flow.
 * Apple requires the nonce to be present in the identity token claim and
 * Supabase verifies it on the exchange.
 */
function cryptoNonce() {
  try {
    const arr = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return String(Date.now()) + Math.random().toString(36).slice(2);
  }
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
  info: {
    fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px',
    padding: '8px 12px', background: 'var(--bg-subtle, #F5F2EF)', borderRadius: 8
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
  // Apple button per HIG: black background, white text and logo, system font,
  // corner radius matching other buttons (12px). Sits ABOVE Google to meet
  // the at-least-equal-prominence requirement.
  appleBtn: {
    width: '100%', padding: '12px 0', borderRadius: 12,
    border: '1px solid #000', background: '#000',
    fontSize: 14, fontWeight: 600, cursor: 'pointer',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif',
    color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginBottom: 10,
    letterSpacing: '-0.01em',
  },
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
