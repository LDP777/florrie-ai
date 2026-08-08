import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

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
 *   - Auto-redirects to login after success (clears recovery session)
 */

export default function UpdatePassword({ supabase }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const navigate = useNavigate();

  // Listen for the PASSWORD_RECOVERY event - Supabase fires this when the
  // recovery token in the URL hash is consumed and a temporary session is set.
  useEffect(() => {
    if (!supabase) return;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setSessionReady(true);
      }
    });

    // Also check if there's already a session (user refreshed the page)
    supabase.auth.getSession().then(({ data }) => {
      if (data?.session) setSessionReady(true);
    });

    return () => subscription?.unsubscribe();
  }, [supabase]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    if (password !== confirm) {
      setError('Passwords don\'t match.');
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });

      if (updateError) {
        setError('Something went wrong. Please request a new reset link.');
        return;
      }

      setSuccess(true);
      // Sign out the recovery session so they log in fresh
      await supabase.auth.signOut();
      setTimeout(() => navigate('/login'), 2500);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div style={styles.page}>
        <div style={styles.logoSection}>
          <h1 style={styles.logo}>florrie.ai</h1>
          <div style={styles.goldBar} />
        </div>
        <div style={styles.form}>
          <h2 style={styles.formTitle}>Password updated</h2>
          <p style={styles.hint}>Your password has been changed. Redirecting you to sign in...</p>
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
            Loading your reset session... If nothing happens, your link may have expired.{' '}
            <button
              type="button"
              onClick={() => navigate('/login')}
              style={styles.inlineLink}
            >
              Request a new one
            </button>
          </p>
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
          <label style={styles.label}>New password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            required
            minLength={8}
            autoFocus
            style={styles.input}
          />
        </div>

        <div style={styles.formGroup}>
          <label style={styles.label}>Confirm password</label>
          <input
            type="password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            placeholder="Type it again"
            required
            minLength={8}
            style={styles.input}
          />
        </div>

        {error && <p style={styles.error}>{error}</p>}

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
  goldBar: { width: 40, height: 2, background: 'var(--gold, #79581C)', margin: '12px auto 0', borderRadius: 6 },
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
