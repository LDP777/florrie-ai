import { useEffect, useRef, useState } from 'react';
import { bookingAuth } from '../lib/booking-auth.js';
import { waitForBookingAuth } from '../lib/booking-auth-fetch.js';
import Button from './ui/Button.jsx';

const PENDING_KEY = 'florrie-booking-verification-pending';
const RESEND_WAIT_MS = 60_000;
const PENDING_LIFETIME_MS = 24 * 60 * 60 * 1000;
const normaliseEmail = value => String(value || '').trim().toLowerCase();
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normaliseEmail(value));

function savePending(pending) {
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch { /* Verification can continue if browser storage is unavailable. */ }
}

function readPending() {
  try {
    const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
    const now = Date.now();
    if (pending && typeof pending.email === 'string' && validEmail(pending.email)
      && Number.isFinite(pending.requestedAt) && Number.isFinite(pending.resendAfter)
      && pending.requestedAt <= now && now - pending.requestedAt < PENDING_LIFETIME_MS
      && pending.resendAfter >= pending.requestedAt && pending.resendAfter <= pending.requestedAt + RESEND_WAIT_MS) {
      return { email: normaliseEmail(pending.email), requestedAt: pending.requestedAt, resendAfter: pending.resendAfter };
    }
    savePending(null);
  } catch { /* Missing or malformed pending data never establishes identity. */ }
  return null;
}

function verifiedAddress(session) {
  const user = session?.user;
  // Phone confirmation is not proof of ownership of the email address.
  return user?.email_confirmed_at && user.email ? normaliseEmail(user.email) : '';
}

function uncertain(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError'
    || error?.name === 'AuthRetryableFetchError' || error?.status === 0 || error?.status >= 500
    || (!error?.status && /network|fetch|transport/i.test(String(error?.message || '')));
}

export default function BookingEmailVerification({ onVerified, recoveryHelp }) {
  const [pending, setPending] = useState(readPending);
  const [email, setEmail] = useState(() => pending?.email || '');
  const [verified, setVerified] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestState, setRequestState] = useState(pending ? 'restored' : 'idle');
  const [now, setNow] = useState(Date.now);
  const pendingRef = useRef(pending);
  // null permits initial session restoration; an explicit address change sets
  // a new intent, including '' while editing, that old auth events cannot undo.
  const addressIntent = useRef(pending?.email ?? null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const verifiedCallback = useRef(onVerified);
  verifiedCallback.current = onVerified;
  const cooldown = Math.max(0, Math.ceil(((pending?.resendAfter || 0) - now) / 1000));

  function updatePending(value) {
    pendingRef.current = value;
    setPending(value);
    savePending(value);
  }

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let authRevision = 0;
    const readGeneration = generation.current;
    const accept = session => {
      if (!active) return;
      const address = verifiedAddress(session);
      // An older request or another booking tab must not change the address
      // currently being verified. The backend also checks the signed identity.
      if (address && addressIntent.current !== null && address !== addressIntent.current) {
        // Supabase may now hold this other token. Never leave the page claiming
        // the old address is verified while bookingHeaders would send it.
        generation.current++;
        setVerified(false); setBusy(false); setRequestState('restored');
        setError('Your verification changed. Verify the email shown here again to continue.');
        verifiedCallback.current('');
        return;
      }
      setVerified(!!address);
      if (address) {
        addressIntent.current = address;
        generation.current++;
        updatePending(null);
        setEmail(address); setCode(''); setError(''); setBusy(false);
      }
      verifiedCallback.current(address);
    };
    waitForBookingAuth(() => bookingAuth.auth.getSession())
      .then(({ data, error: readError }) => {
        if (!active || authRevision || generation.current !== readGeneration) return;
        if (readError) throw readError;
        accept(data?.session);
      })
      .catch(() => {
        if (active && !authRevision && generation.current === readGeneration) {
          setError('Saved verification could not be checked. You can still request or enter your email code.');
        }
      });
    const { data } = bookingAuth.auth.onAuthStateChange((_event, session) => {
      authRevision++;
      accept(session);
    });
    return () => {
      active = false; mounted.current = false; generation.current++;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [cooldown, pending]);

  function begin() {
    const operation = ++generation.current;
    setBusy(true); setError('');
    return () => mounted.current && generation.current === operation;
  }

  async function requestCode() {
    const address = normaliseEmail(email);
    if (busy || cooldown || !validEmail(address)) return;
    const current = begin();
    const requestedAt = Date.now();
    addressIntent.current = address;
    setEmail(address); setNow(requestedAt); setRequestState('requesting');
    // Persist intent before the request. A dropped response or a page reload
    // cannot prove no email was sent, so the code field must remain available.
    updatePending({ email: address, requestedAt, resendAfter: requestedAt + RESEND_WAIT_MS });
    try {
      const { error: sendError } = await waitForBookingAuth(() => bookingAuth.auth.signInWithOtp({
        email: address, options: { shouldCreateUser: true, data: { account_type: 'booking_client' } },
      }));
      if (!current()) return;
      if (sendError) throw sendError;
      setRequestState('accepted');
    } catch (err) {
      if (!current()) return;
      const rateLimited = err?.status === 429 || /rate|too many/i.test(String(err?.message || ''));
      setRequestState(uncertain(err) ? 'uncertain' : 'failed');
      setError(rateLimited
        ? 'Please wait before requesting another code. If a code already arrives, enter it below.'
        : uncertain(err)
          ? 'We couldn’t confirm the email request. If a code arrives, you can enter it below. Wait before requesting another.'
          : 'The code request was not accepted. Check the email address, then try again. Any code you already received can still be entered below.');
    } finally { if (current()) setBusy(false); }
  }

  async function verify() {
    const address = pendingRef.current?.email;
    if (busy || !address || code.trim().length < 6) return;
    const current = begin();
    try {
      const { data, error: verifyError } = await waitForBookingAuth(() => bookingAuth.auth.verifyOtp({ email: address, token: code.trim(), type: 'email' }));
      if (!current()) return;
      if (verifyError) throw verifyError;
      const session = data?.session || (await waitForBookingAuth(() => bookingAuth.auth.getSession())).data?.session;
      if (!current()) return;
      const addressFromSession = verifiedAddress(session);
      if (!addressFromSession || addressFromSession !== address) throw new Error('No matching verified session');
      updatePending(null); setVerified(true); setEmail(addressFromSession); setCode('');
      verifiedCallback.current(addressFromSession);
    } catch (err) {
      if (!current()) return;
      const message = String(err?.message || '').toLowerCase();
      setError(uncertain(err)
        ? 'Verification could not be confirmed yet. Your code is still here. Try verifying it again before requesting another.'
        : message.includes('expired') || message.includes('invalid')
          ? 'That code has expired or is incorrect. Check the latest email or request another code.'
          : 'That code could not be verified. Check the code and email address, then try again.');
    } finally { if (current()) setBusy(false); }
  }

  async function changeEmail() {
    if (busy) return;
    const current = begin();
    const previousIntent = addressIntent.current;
    addressIntent.current = '';
    try {
      const { error: signOutError } = await waitForBookingAuth(() => bookingAuth.auth.signOut({ scope: 'local' }));
      if (!current()) return;
      if (signOutError) throw signOutError;
      updatePending(null); setVerified(false); setCode(''); setRequestState('idle');
      verifiedCallback.current('');
    } catch { if (current()) { addressIntent.current = previousIntent; setError('Could not change email. Please try again.'); } }
    finally { if (current()) setBusy(false); }
  }

  return <section aria-label="Verify booking email" style={{ padding: 16, border: '1px solid #E8E4DF', borderRadius: 12, marginBottom: 16 }}>
    {verified ? <><p role="status">Email verified: {email}</p><Button variant="quiet" disabled={busy} onClick={changeEmail}>Use another email</Button></> : <>
      <label style={{ display: 'block' }}>Email for your booking<input type="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={email} disabled={busy || !!pending} onChange={event => { generation.current++; addressIntent.current = normaliseEmail(event.target.value); setEmail(event.target.value); setError(''); }} style={{ display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 44, margin: '8px 0' }} /></label>
      <p style={{ fontSize: 13 }}>Verify your email to book and access your saved details or package sessions.</p>
      {pending && <>
        <p role="status">{requestState === 'accepted' ? 'Code requested. ' : requestState === 'requesting' ? 'Requesting your code. ' : ''}Check the inbox and junk or spam folder for {pending.email}. If you have a code, enter it here. If you requested more than one, use the latest email.</p>
        <p style={{ fontSize: 13 }}>Search your email for “Florrie” or “Confirm Your Signup”. The booking code is inside that email.</p>
        <label>Verification code<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))} style={{ display: 'block', minHeight: 44, margin: '8px 0' }} /></label>
        <Button disabled={busy || code.trim().length < 6} onClick={verify}>{busy && requestState !== 'requesting' ? 'Please wait…' : 'Verify email'}</Button>
      </>}
      <Button variant="secondary" disabled={busy || cooldown > 0 || !validEmail(email)} onClick={requestCode}>{cooldown ? `Request another code in ${cooldown}s` : pending ? 'Resend code' : 'Get verification code'}</Button>
      {pending && <Button variant="quiet" disabled={busy} onClick={changeEmail}>Change email address</Button>}
      {recoveryHelp}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
