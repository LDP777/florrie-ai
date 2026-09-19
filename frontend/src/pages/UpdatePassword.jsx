import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { startAuthStartup } from '../lib/auth-startup.js';
import Button from '../components/ui/Button';

function bounded(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Auth response timed out')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * UpdatePassword - handles the Supabase password reset callback.
 *
 * User lands here after clicking the reset link in their email.
 * Supabase sets a recovery session via the URL hash fragment automatically.
 * We just need to call supabase.auth.updateUser({ password }) with the
 * new password once the recovery session is active.
 *
 * Security:
 *   - Generic error messages only
 *   - Minimum 8 character password enforced client-side + Supabase-side
 *   - Returns to login only after a confirmed sign-out
 */

export default function UpdatePassword({ supabase }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [signOutState, setSignOutState] = useState('working');
  const mounted = useRef(false);
  const mutationStarted = useRef(false);
  const [sessionState, setSessionState] = useState({ status: 'loading', session: null, error: null });
  const sessionCheck = useRef(null);
  const sessionReady = sessionState.status === 'ready' && !!sessionState.session;
  const navigate = useNavigate();

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // The same bounded reader used at app startup also handles a recovery event
  // arriving after this page mounts. A failed read is unknown, not an expired link.
  useEffect(() => {
    const check = startAuthStartup({ auth: supabase?.auth, onChange: setSessionState });
    sessionCheck.current = check;
    return () => { check.dispose(); sessionCheck.current = null; };
  }, [supabase]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!sessionReady || mutationStarted.current || uncertain) return;

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    if (password !== confirm) {
      setError('Passwords don\'t match.');
      return;
    }

    setLoading(true);
    mutationStarted.current = true;
    try {
      const { error: updateError } = await bounded(supabase.auth.updateUser({ password }), 15000);
      if (!mounted.current) return;

      if (updateError) {
        mutationStarted.current = false;
        setError('Something went wrong. Please request a new reset link.');
        return;
      }

      setSuccess(true);
      // Keep the existing scope and storage. A failed sign-out must not falsely
      // promise the login screen: App redirects an authenticated /login to Today.
      try {
        const result = await bounded(supabase.auth.signOut(), 8000);
        if (!result || !Object.hasOwn(result, 'error') || result.error) throw new Error('Sign-out not confirmed');
        // SIGNED_OUT can remount this route before signOut resolves. Finish the
        // return only if the user is still on the recovery URL.
        if (window.location.pathname === '/update-password') navigate('/login', { replace: true });
      } catch {
        if (mounted.current) setSignOutState('unavailable');
      }
    } catch {
      // The provider may have accepted the password before its response was
      // lost. Do not permit another mutation or claim it failed.
      if (mounted.current) setUncertain(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  if (success || uncertain) {
    return (
      <div style={styles.page}>
        <div style={styles.logoSection}>
          <h1 style={styles.logo}>florrie.ai</h1>
          <div style={styles.goldBar} />
        </div>
        <div style={styles.form}>
          <h2 style={styles.formTitle}>{uncertain ? 'Change not confirmed' : 'Password updated'}</h2>
          <p style={styles.hint}>
            {uncertain
              ? 'We could not confirm whether your password changed. It may have succeeded. Try the new password next time you sign in, or request a fresh reset link before changing it again.'
              : signOutState === 'unavailable'
                ? 'Your password has changed. We could not finish signing out. You can return to Florrie and use your new password next time you sign in.'
                : 'Your password has changed. Finishing sign-out...'}
          </p>
          {(uncertain || signOutState === 'unavailable') && <Button variant="secondary" onClick={() => navigate('/')}>Return to Florrie</Button>}
        </div>
      </div>
    );
  }

  if (!sessionReady) {
    return (
      <div style={styles.page}>
        <div style={styles.logoSection}>
          <h1 style={styles.logo}>florrie.ai</h1>
          <div style={styles.goldBar} />
        </div>
        <div style={styles.form}>
          <h2 style={styles.formTitle}>Reset your password</h2>
          <p style={styles.hint}>
            {sessionState.status === 'loading'
              ? 'Checking your reset link...'
              : sessionState.status === 'error'
                ? 'Could not check your reset link. Check your connection and try again.'
                : 'This reset link is unavailable or has expired.'}{' '}
            <button
              type="button"
              onClick={() => navigate('/login')}
              style={styles.inlineLink}
            >
              Request a new one
            </button>
          </p>
          {sessionState.status === 'error' && <Button variant="secondary" onClick={() => sessionCheck.current?.retry()}>Try again</Button>}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.logoSection}>
        <h1 style={styles.logo}>florrie.ai</h1>
        <div style={styles.goldBar} />
      </div>

      <form onSubmit={handleSubmit} style={styles.form}>
        <h2 style={styles.formTitle}>Choose a new password</h2>

        <div style={styles.formGroup}>
          <label htmlFor="recovery-password" style={styles.label}>New password</label>
          <input
            id="recovery-password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            required
            minLength={8}
            autoComplete="new-password"
            autoFocus
            style={styles.input}
          />
        </div>

        <div style={styles.formGroup}>
          <label htmlFor="recovery-confirm" style={styles.label}>Confirm password</label>
          <input
            id="recovery-confirm"
            type="password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            placeholder="Type it again"
            required
            minLength={8}
            autoComplete="new-password"
            style={styles.input}
          />
        </div>

        {error && <p style={styles.error} role="alert">{error}</p>}

        <button type="submit" disabled={loading} style={styles.submitBtn}>
          {loading ? 'Updating...' : 'Update password'}
        </button>
      </form>
    </div>
  );
}

const styles = {
  page: {
    minHeight: 'var(--shell-viewport)', background: 'var(--bg)',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', -apple-system, sans-serif)",
    padding: '0 24px', maxWidth: 400, margin: '0 auto',
    display: 'flex', flexDirection: 'column', justifyContent: 'center',
    animation: 'fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  logoSection: { textAlign: 'center', marginBottom: 32 },
  logo: {
    fontSize: 36, fontWeight: 700, color: 'var(--accent)',
    margin: '0 0 4px', letterSpacing: '-0.03em',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  goldBar: { width: 40, height: 2, background: 'var(--gold, #79581C)', margin: '12px auto 0', borderRadius: 'var(--radius-xs)' },
  form: {
    background: 'var(--bg-card)', borderRadius: 22, padding: 24,
    boxShadow: 'var(--shadow-lg)',
  },
  formTitle: {
    fontSize: 18, fontWeight: 600, margin: '0 0 20px',
    color: 'var(--text-primary)',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    letterSpacing: '-0.02em',
  },
  formGroup: { marginBottom: 14 },
  label: { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 500 },
  input: {
    width: '100%', padding: '12px 14px', borderRadius: 10,
    border: '1.5px solid var(--border)', fontSize: 15, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box',
  },
  error: {
    fontSize: 13, color: 'var(--danger)', margin: '0 0 10px',
    padding: '8px 12px', background: 'var(--danger-bg)', borderRadius: 10,
  },
  submitBtn: {
    width: '100%', padding: '14px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent)', color: 'var(--bg-card)', fontSize: 15,
    fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    boxShadow: 'var(--elev-2)',
  },
  hint: { fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.5 },
  inlineLink: {
    background: 'none', border: 'none', color: 'var(--accent)',
    fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
    padding: 0, textDecoration: 'underline',
  },
};
