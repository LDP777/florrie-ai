import { useEffect, useRef, useState } from 'react';
import Button from './ui/Button.jsx';

export function bookingHelpMessage({ businessName, treatments = [], startsAt }) {
  const treatment = treatments.map(item => item.name).filter(Boolean).join(' + ');
  // Booking slots contain salon wall time. Do not shift the client's choice
  // when their phone is set to another timezone.
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startsAt || '');
  const when = parts
    ? ` on ${new Date(Date.UTC(+parts[1], +parts[2] - 1, +parts[3])).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} at ${parts[4]}:${parts[5]}`
    : '';
  return `Hi ${businessName || 'there'}, I'm having trouble receiving my booking verification code. Could you help me book ${treatment || 'an appointment'}${when}? This is a booking request; please confirm availability.`;
}

export default function BookingVerificationHelp(props) {
  const message = bookingHelpMessage(props);
  const currentMessage = useRef(message);
  currentMessage.current = message;
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => { currentMessage.current = message; setCopyStatus(''); return () => { currentMessage.current = null; }; }, [message]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      if (currentMessage.current === message) setCopyStatus('Copied. Paste this into your usual conversation with the salon.');
    } catch {
      if (currentMessage.current === message) setCopyStatus('Select and copy the message below, then send it in your usual conversation with the salon.');
    }
  }
  return <details style={{ marginTop: 12, fontSize: 14, lineHeight: 1.5 }}>
    <summary style={{ cursor: 'pointer', padding: '10px 0', fontWeight: 600 }}>Still no code? Get help booking</summary>
    <p>Check your junk or spam folder for an email from Florrie, and check the address above. You can also use another email address.</p>
    <p>If you still cannot receive the code, send this request to {props.businessName || 'your salon'} in your usual chat. Your appointment is <strong>not confirmed</strong> and the time is <strong>not reserved</strong>.</p>
    <label style={{ display: 'block' }}>Booking request
      <textarea readOnly value={message} onFocus={event => event.currentTarget.select()} rows={6} style={{ display: 'block', minHeight: 132, width: '100%', boxSizing: 'border-box', margin: '8px 0', padding: 10, border: '1px solid var(--border, #E8E4DF)', borderRadius: 10, background: 'var(--surface, #fff)', color: 'var(--text, #241B17)', font: 'inherit', resize: 'vertical' }} />
    </label>
    <Button variant="secondary" onClick={copy}>Copy booking request</Button>
    {copyStatus && <p role="status">{copyStatus}</p>}
  </details>;
}
