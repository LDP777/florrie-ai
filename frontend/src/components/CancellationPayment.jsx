import Button from './ui/Button.jsx';
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import { API_BASE } from '../lib/config.js';
import { PrivateAmount, PrivateText } from '../contexts/ClientPrivacyContext.jsx';

export function CancellationPaymentReceipt({ payment, publicReceipt = false }) {
  if (!payment) return null;
  const amount = payment.amountCents != null ? `£${(payment.amountCents / 100).toFixed(2)}` : null;
  const date = payment.collectedAt && Number.isFinite(Date.parse(payment.collectedAt))
    ? new Date(payment.collectedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }) : null;
  return <div role="status" aria-label="Cancellation payment" style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 14, marginBlock: 10, background: 'var(--surface, #FFFCF9)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <strong>Cancellation fee · {payment.label}</strong>
      {amount && (publicReceipt ? <span>{amount}</span> : <PrivateAmount>{amount}</PrivateAmount>)}
    </div>
    {date && <p style={{ margin: '6px 0', fontSize: 13 }}>Collected on {date}</p>}
    <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: 1.5 }}>{payment.message}</p>
  </div>;
}

export default function CancellationPayments({ appointmentId = null }) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ loading: true, rows: [], error: false });
  useEffect(() => {
    let active = true;
    setState({ loading: true, rows: [], error: false });
    (async () => {
      try {
        const path = appointmentId ? `${encodeURIComponent(appointmentId)}/cancellation-payment` : 'cancellation-payments';
        const data = await readAuthenticatedJson({ auth: supabase.auth, url: `${API_BASE}/api/appointments/${path}` });
        if (active) setState({ loading: false, error: false,
          rows: appointmentId ? (data.payment ? [{ appointmentId, payment: data.payment }] : []) : data.payments || [] });
      } catch {
        if (active) setState({ loading: false, error: true, rows: [] });
      }
    })();
    return () => { active = false; };
  }, [appointmentId, revision]);

  return <section aria-label="Cancellation fees" style={{ marginBottom: 16 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <strong>Cancellation fees</strong>
      <Button variant="quiet" onClick={() => setRevision(v => v + 1)} disabled={state.loading}>Refresh</Button>
    </div>
    {state.loading ? <p role="status">Checking payment status…</p>
      : state.error ? <p role="alert">Couldn’t check cancellation payments. Tap Refresh to try again.</p>
        : state.rows.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>No cancellation fee recorded{appointmentId ? ' for this booking' : ' on the most recent bookings'}.</p>
          : state.rows.map(row => <div key={row.appointmentId}>
            {!appointmentId && <p style={{ margin: '12px 0 0' }}><PrivateText placeholder="Client">{row.clientName}</PrivateText>
              {row.startsAt && <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}> · Appointment {new Date(row.startsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</span>}
            </p>}
            <CancellationPaymentReceipt payment={row.payment} />
          </div>)}
  </section>;
}
