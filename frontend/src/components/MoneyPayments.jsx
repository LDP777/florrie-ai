import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';
import CancellationPayments from './CancellationPayment.jsx';
import { PrivateAmount, PrivateText, useClientPrivacy } from '../contexts/ClientPrivacyContext.jsx';
import { formatMoney } from '../lib/money-view.js';

const labels = { deposit: 'Deposit', full_payment: 'Paid in full', payment_link: 'Payment link', no_show_fee: 'No-show fee', late_cancel_fee: 'Cancellation fee', tip: 'Tip', product_sale: 'Product sale', refund: 'Refund', payment: 'Payment' };
const methods = { cash: 'Cash', bank_transfer: 'Bank transfer', card_terminal: 'Card machine', card_online: 'Card', tap_to_pay: 'Tap to Pay' };
const shortDate = date => date ? new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

export function paymentLabel(tx) {
  if (tx.reporting_status === 'assumed') return 'Receipt not recorded';
  if (tx.reporting_status === 'review') return 'Check payment records';
  if (tx.reporting_status === 'duplicate') return 'Duplicate · not counted';
  if (tx.reporting_status !== 'received') return `${tx.status === 'failed' ? 'Failed' : tx.status === 'pending' ? 'Pending' : 'Not counted'}`;
  return [labels[tx.type] || 'Payment', methods[tx.payment_method] || (tx.stripe_payment_intent_id ? 'Card' : null)].filter(Boolean).join(' · ');
}

export default function MoneyPayments({ transactions, filter, onFilter, visible, onMore, today, onSave, onRecorded }) {
  const { hidden } = useClientPrivacy();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [method, setMethod] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const needsRecording = transactions.filter(t => ['assumed', 'review'].includes(t.reporting_status));
  const shown = transactions.filter(t => filter === 'review' ? ['assumed', 'review'].includes(t.reporting_status) : filter === 'all' || t.reporting_status === 'received')
    .filter(t => !search || hidden || [t.appointments?.clients?.first_name, t.appointments?.clients?.last_name, t.appointments?.treatments?.name, t.description, shortDate(t.created_at)].join(' ').toLowerCase().includes(search.toLowerCase()));
  function open(tx) { setSelected(tx.id); setMethod(''); setDate(''); setError(''); }
  async function save(tx, event) {
    event.preventDefault();
    if (saving.current || hidden) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const result = await onSave(tx.id, { payment_method: method, received_on: date, expected_amount_cents: tx.amount_cents });
      if (result.transaction?.id !== tx.id || result.transaction?.payment_method !== method) throw new Error('Save not confirmed. Refresh your records before trying again.');
      if (!active.current) return;
      onRecorded(result.transaction); setSelected(null);
    } catch (e) { if (active.current) setError(e.message || 'Save not confirmed. Your details are still here.'); }
    finally { saving.current = false; if (active.current) setBusy(false); }
  }
  return <section className="money-payments" aria-label="Income payments">
    <div className="money-income-toolbar">
      <h2>{filter === 'review' ? 'To record' : filter === 'all' ? 'All records' : 'Received'}</h2>
      <select aria-label="Income records" value={filter} onChange={e => onFilter(e.target.value)}>
        <option value="received">Received</option><option value="review">To record ({needsRecording.length})</option><option value="all">All records</option>
      </select>
    </div>
    {filter === 'review' ? <p className="money-helper">Check how you were paid, then add the receipt. These amounts are not counted as received.</p> : filter === 'all' ? <p className="money-helper">Includes failed and duplicate records. Only received payments count in your totals.</p> : needsRecording.length > 0 && <button className="money-review-link" onClick={() => onFilter('review')}><Icon name="receipt" size={17}/><span>Record cash &amp; bank payments</span><Icon name="chevron-right" size={16}/></button>}
    <PrivateText placeholder="Search hidden"><label className="money-search"><Icon name="search" size={17}/><input aria-label="Search payments" placeholder="Find a client or date" value={search} onChange={e => setSearch(e.target.value)}/></label></PrivateText>
    {!shown.length && <p className="money-empty">{search ? 'No matching payments.' : filter === 'review' ? 'No payments waiting to be recorded.' : 'No received payments recorded yet.'}</p>}
    <div className="money-payment-list">{shown.slice(0, visible).map(tx => {
      const client = tx.appointments?.clients;
      const name = client ? [client.first_name, client.last_name].filter(Boolean).join(' ') : tx.description || labels[tx.type] || 'Payment';
      const assumed = tx.reporting_status === 'assumed';
      return <article key={tx.id} className="money-payment-row" data-payment-status={tx.reporting_status}>
        <div className="money-payment-top"><div><h3><PrivateText placeholder="Client">{name}</PrivateText></h3><p>{shortDate(tx.created_at)}{tx.appointments?.treatments?.name && <> · <PrivateText>{tx.appointments.treatments.name}</PrivateText></>}</p></div><strong><PrivateAmount>{formatMoney(tx.amount_cents)}</PrivateAmount></strong></div>
        <div className="money-payment-status"><span>{paymentLabel(tx)}</span>{assumed && tx.appointment_id && selected !== tx.id && <Button variant="quiet" size="sm" disabled={hidden || busy} onClick={() => open(tx)}>Record payment</Button>}</div>
        {selected === tx.id && !hidden && <form className="money-receipt-form" aria-label="Record a payment" onSubmit={e => save(tx, e)}>
          <h4>Record {formatMoney(tx.amount_cents)} received</h4>
          <p>Adds a receipt. No money is taken from the client.</p>
          <label>Paid by<select aria-label="Paid by" required value={method} onChange={e => setMethod(e.target.value)} disabled={busy}><option value="">Choose a method</option><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="card_terminal">Separate card machine</option></select></label>
          <label>Received on<input aria-label="Received on" type="date" required min="2000-01-01" max={today} value={date} onChange={e => setDate(e.target.value)} disabled={busy}/></label>
          {error && <p role="alert">{error}</p>}
          <div className="money-receipt-actions"><Button type="submit" disabled={busy || !method || !date}>{busy ? 'Saving…' : 'Record receipt'}</Button><Button type="button" variant="quiet" disabled={busy} onClick={() => setSelected(null)}>Cancel</Button></div>
        </form>}
        {tx.reporting_status === 'review' && tx.appointment_id && <Button variant="quiet" size="sm" disabled={hidden} onClick={() => navigate(`/calendar?appt=${encodeURIComponent(tx.appointment_id)}&date=${encodeURIComponent(tx.appointments?.starts_at?.slice(0,10) || '')}`)}>Open appointment</Button>}
      </article>;
    })}</div>
    {visible < shown.length && <Button variant="secondary" fullWidth onClick={onMore}>Show more records ({visible} of {shown.length})</Button>}
    <details className="money-details"><summary>Cancellation fees<Icon name="chevron-down" size={16}/></summary><CancellationPayments /></details>
  </section>;
}
