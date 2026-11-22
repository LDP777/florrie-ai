import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';
import { PrivateAmount, PrivateText } from '../contexts/ClientPrivacyContext.jsx';
import { formatMoney } from '../lib/money-view.js';

function MoneyComparison({ stats }) {
  if (!stats) return null;
  const direction = stats.changeCents > 0 ? 'up' : stats.changeCents < 0 ? 'down' : 'flat';
  const change = stats.changePct === null ? 'No previous total' : stats.changeCents === 0 ? 'No change' : `${direction === 'up' ? '↑' : '↓'} ${Math.abs(stats.changePct) < 0.1 ? '<0.1' : Math.abs(stats.changePct)}%`;
  return <PrivateText placeholder="Comparison hidden"><div className="money-comparison" aria-label="Income comparison"><span className={`money-change money-change--${stats.changePct === null ? 'flat' : direction}`}>{change}</span><span>vs {stats.compareLabel}</span></div></PrivateText>;
}

export function validDiarySummary(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(value.end || '')) return false;
  const counts = ['total_count', 'completed_count', 'remaining_count', 'missing_price_count', 'status_review_count'];
  if (!counts.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return false;
  if (!['total_cents', 'completed_cents', 'remaining_cents'].every(key => value[key] === null || (Number.isSafeInteger(value[key]) && value[key] >= 0))) return false;
  return value.total_cents === null || (value.completed_cents !== null && value.remaining_cents !== null && value.total_cents === value.completed_cents + value.remaining_cents);
}

export default function MoneyDiaryOverview({ summary, stats, automatic, loading, onRetry, onCalendar, onPayments }) {
  const diaryReady = validDiarySummary(summary);
  const amount = value => value === null ? <span className="money-diary-unknown">Needs review</span> : <PrivateAmount>{formatMoney(value)}</PrivateAmount>;
  return <>
    <section className="money-diary-card" aria-label="Money received">
      <div className="money-diary-top"><span>Money received</span><button onClick={onPayments} aria-label="View payments"><Icon name="receipt" size={19}/></button></div>
      <h2>{amount(stats?.income ?? 0)}</h2>
      <MoneyComparison stats={stats}/>
      <div className="money-diary-split">
        <div><span>Expenses</span><strong>{amount(stats?.expenses ?? 0)}</strong></div>
        <div><span>After costs</span><strong>{amount(stats?.profit ?? 0)}</strong></div>
      </div>
      <details><summary>How this adds up<Icon name="chevron-down" size={14}/></summary><p>{automatic ? 'Completed visits count as paid. Mark any unpaid balance in Income. Deposits count once, refunds come off, and future visits are not included. This does not charge a card.' : 'Recorded card, cash and bank payments, less refunds. Future appointments are not included.'}</p></details>
    </section>
    {diaryReady ? <button className="money-received-summary" onClick={() => onCalendar(summary.start)} aria-label="View upcoming appointments"><span>Still booked · {summary.remaining_count}</span><strong>{amount(summary.remaining_cents)}</strong><Icon name="chevron-right" size={16}/></button>
      : loading ? <p className="money-helper" role="status">Checking upcoming appointments…</p> : <Button variant="quiet" size="sm" onClick={onRetry}>Retry upcoming appointments</Button>}
  </>;
}
