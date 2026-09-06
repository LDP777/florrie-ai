import { useEffect, useState } from 'react';
import { bookingAuth } from '../lib/booking-auth.js';
import Button from './ui/Button.jsx';

export default function BookingEmailVerification({ onVerified }) {
  const [email, setEmail] = useState('');
  const [verified, setVerified] = useState(false);
  const [code, setCode] = useState('');
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    let active = true;
    const accept = session => {
      if (!active) return;
      const address = session?.user?.email_confirmed_at ? session.user.email : '';
      setVerified(!!address);
      if (address) setEmail(address);
      onVerified(address);
    };
    bookingAuth.auth.getSession().then(({ data }) => accept(data.session)).catch(() => { if (active) setError('Verification could not be loaded. Please try again.'); });
    const { data } = bookingAuth.auth.onAuthStateChange((_event, session) => accept(session));
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  async function requestCode() {
    setBusy(true); setError('');
    try {
      const { error } = await bookingAuth.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true, data: { account_type: 'booking_client' } } });
      if (error) throw error;
      setRequested(true); setCooldown(60);
    } catch { setError('The verification request failed. Check your email address and try again.'); }
    finally { setBusy(false); }
  }
  async function verify() {
    setBusy(true); setError('');
    try {
      const { data, error } = await bookingAuth.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: 'email' });
      if (error || !data.session?.user?.email_confirmed_at || data.session.user.email?.toLowerCase() !== email.trim().toLowerCase()) throw error || new Error('No verified session');
      setVerified(true); onVerified(data.session.user.email);
    } catch { setError('That code could not be verified. Check the code or request another.'); }
    finally { setBusy(false); }
  }
  async function changeEmail() {
    setBusy(true); setError('');
    try {
      const { error } = await bookingAuth.auth.signOut({ scope: 'local' });
      if (error) throw error;
      setVerified(false); setRequested(false); setCode(''); setCooldown(0); onVerified('');
    } catch { setError('Could not change email. Please try again.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Verify booking email" style={{ padding: 16, border: '1px solid #E8E4DF', borderRadius: 12, marginBottom: 16 }}>
    {verified ? <><p role="status">Email verified: {email}</p><Button variant="quiet" disabled={busy} onClick={changeEmail}>Use another email</Button></> : <>
      <label style={{ display: 'block' }}>Email for your booking<input type="email" autoComplete="email" value={email} disabled={busy || requested} onChange={event => setEmail(event.target.value)} style={{ display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 44, margin: '8px 0' }} /></label>
      <p style={{ fontSize: 13 }}>Verify your email to book and access your saved details or package sessions.</p>
      {requested && <><p role="status">Check your inbox for a verification code.</p><label>Verification code<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} style={{ display: 'block', minHeight: 44, margin: '8px 0' }} /></label><Button disabled={busy || code.trim().length < 6} onClick={verify}>Verify email</Button></>}
      <Button variant="secondary" disabled={busy || cooldown > 0 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)} onClick={requestCode}>{cooldown ? `Request another code in ${cooldown}s` : requested ? 'Resend code' : 'Get verification code'}</Button>
      {requested && <Button variant="quiet" disabled={busy} onClick={() => { setRequested(false); setCode(''); setError(''); }}>Change email address</Button>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
