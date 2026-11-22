import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';
import { PrivateAmount } from '../contexts/ClientPrivacyContext.jsx';
import { formatMoney } from '../lib/money-view.js';

export function validDiarySummary(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(value.end || '')) return false;
  const counts = ['total_count', 'completed_count', 'remaining_count', 'missing_price_count', 'status_review_count'];
  if (!counts.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return false;
  if (!['total_cents', 'completed_cents', 'remaining_cents'].every(key => value[key] === null || (Number.isSafeInteger(value[key]) && value[key] >= 0))) return false;
  return value.total_cents === null || (value.completed_cents !== null && value.remaining_cents !== null && value.total_cents === value.completed_cents + value.remaining_cents);
}

export default function MoneyDiaryOverview({ summary, loading, onRetry, onCalendar }) {
  if (loading) return <section className="money-diary-loading" aria-label="Appointment value"><p role="status">Checking your diary…</p></section>;
  if (!validDiarySummary(summary)) return <section className="money-diary-loading" aria-label="Appointment value"><p role="alert">Couldn’t load your diary totals.</p><Button variant="quiet" onClick={onRetry}>Retry diary totals</Button></section>;
  const amount = value => value === null ? <span className="money-diary-unknown">Needs review</span> : <PrivateAmount>{formatMoney(value)}</PrivateAmount>;
  return <section className="money-diary-card" aria-label="Appointment value">
    <div className="money-diary-top"><span>Booked value</span><button onClick={() => onCalendar(summary.start)} aria-label="Open appointments in calendar"><Icon name="calendar" size={19}/></button></div>
    <h2>{amount(summary.total_cents)}</h2>
    <div className="money-diary-split">
      <div><span>Completed · {summary.completed_count}</span><strong>{amount(summary.completed_cents)}</strong></div>
      <div><span>Still booked · {summary.remaining_count}</span><strong>{amount(summary.remaining_cents)}</strong></div>
    </div>
    {(summary.missing_price_count > 0 || summary.status_review_count > 0) && <button className="money-diary-review" onClick={() => onCalendar(summary.start)}>Check {summary.missing_price_count > 0 ? 'missing prices' : 'appointment statuses'}<Icon name="chevron-right" size={15}/></button>}
    <details><summary>How this adds up<Icon name="chevron-down" size={14}/></summary><p>Appointment prices include add-ons and discounts. Deposits and prepaid sessions are already included. Cancelled appointments and no-shows are excluded.</p></details>
  </section>;
}
