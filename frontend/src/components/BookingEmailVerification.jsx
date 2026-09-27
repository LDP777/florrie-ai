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
  const normaliseEmail = value => String(value || '').trim().toLowerCase();
  const verifiedAddress = session => {
    const user = session?.user;
    // Phone confirmation is not proof of ownership of the email address.
    const confirmed = user?.email_confirmed_at;
    return confirmed && user?.email ? normaliseEmail(user.email) : '';
  };
  useEffect(() => {
    let active = true;
    const accept = session => {
      if (!active) return;
      const address = verifiedAddress(session);
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
      const address = normaliseEmail(email);
      const { error } = await bookingAuth.auth.signInWithOtp({ email: address, options: { shouldCreateUser: true, data: { account_type: 'booking_client' } } });
      if (error) throw error;
      setRequested(true); setCooldown(60);
    } catch (err) {
      const message = String(err?.message || '').toLowerCase();
      setError(message.includes('rate') || message.includes('too many')
        ? 'Too many codes were requested. Wait a minute, then try again.'
        : 'The verification request failed. Check your email address and try again.');
    }
    finally { setBusy(false); }
  }
  async function verify() {
    setBusy(true); setError('');
    try {
      const address = normaliseEmail(email);
      const { data, error } = await bookingAuth.auth.verifyOtp({ email: address, token: code.trim(), type: 'email' });
      if (error) throw error;
      // Some Supabase responses deliver the session on the auth-state event a
      // moment after verifyOtp resolves. Reading it once closes that race,
      // which otherwise showed a valid code as “could not be verified”.
      const session = data?.session || (await bookingAuth.auth.getSession()).data?.session;
      const verified = verifiedAddress(session);
      if (!verified || verified !== address) throw new Error('No verified session');
      setVerified(true); setEmail(verified); onVerified(verified);
    } catch (err) {
      const message = String(err?.message || '').toLowerCase();
      setError(message.includes('expired') || message.includes('invalid')
        ? 'That code has expired or is incorrect. Request a new code and try again.'
        : 'That code could not be verified. Check the code or request another.');
    }
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
      {requested && <><p role="status">Check your inbox for the latest verification code. If you requested more than one, use the newest.</p><label>Verification code<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))} style={{ display: 'block', minHeight: 44, margin: '8px 0' }} /></label><Button disabled={busy || code.trim().length < 6} onClick={verify}>Verify email</Button></>}
      <Button variant="secondary" disabled={busy || cooldown > 0 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)} onClick={requestCode}>{cooldown ? `Request another code in ${cooldown}s` : requested ? 'Resend code' : 'Get verification code'}</Button>
      {requested && <Button variant="quiet" disabled={busy} onClick={() => { setRequested(false); setCode(''); setError(''); }}>Change email address</Button>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
