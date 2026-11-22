import { useNavigate } from 'react-router-dom';
import Icon from './ui/Icon.jsx';
import { PrivateAmount, PrivateText } from '../contexts/ClientPrivacyContext.jsx';
import { formatMoney, paymentDateLabel } from '../lib/money-view.js';
import { paymentLabel } from './MoneyPayments.jsx';

export default function MoneyRecentPayments({ payments, timezone, onAll, onReview, needsReview }) {
  const navigate = useNavigate();
  return <section className="money-recent" aria-label="Recent payments">
    <div className="money-recent-heading"><h3>Recent payments</h3><button onClick={onAll}>See all</button></div>
    {!payments.length && <p className="money-empty">No payments recorded yet.</p>}
    {payments.map(tx => {
      const client = tx.appointments?.clients;
      const name = client ? [client.first_name, client.last_name].filter(Boolean).join(' ') : tx.description || paymentLabel(tx);
      return <article className="money-recent-row" key={tx.id}>
        <div className="money-recent-avatar"><Icon name={tx.type === 'refund' ? 'arrow-left' : 'receipt'} size={18}/></div>
        <div className="money-recent-main">
          {tx.appointments?.client_id ? <button className="money-recent-client" onClick={() => navigate('/clients', { state: { clientId: tx.appointments.client_id } })}><PrivateText placeholder="Client">{name}</PrivateText></button> : <strong><PrivateText placeholder="Client">{name}</PrivateText></strong>}
          <span>{paymentLabel(tx)}</span><time dateTime={tx.created_at}>{paymentDateLabel(tx.created_at, timezone)}</time>
        </div>
        <strong className={tx.amount_cents < 0 ? 'money-recent-out' : 'money-recent-in'}><PrivateAmount>{formatMoney(tx.amount_cents)}</PrivateAmount></strong>
      </article>;
    })}
    {needsReview && <button className="money-review-link" onClick={onReview}><Icon name="receipt" size={17}/><span>Check unpaid payments</span><Icon name="chevron-right" size={16}/></button>}
  </section>;
}
