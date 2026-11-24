import { Link } from 'react-router-dom';
import Icon from './ui/Icon';
import { mixOver, readableOnAll } from '../lib/brand-colour.js';

export function trainingTheme(owner) {
  const raw = owner?.brand_color;
  const brand = /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(raw || '') ? raw : '#92405e';
  return {
    '--training-accent': readableOnAll(brand, ['#FBF6F1', '#FFFCF9', '#FFFFFF']),
    '--training-tint': mixOver(brand, '#FFFCF9', 0.07),
  };
}

export function TrainingHeader({ owner, to, label }) {
  const name = owner?.business_name || owner?.first_name;
  return <header className="training-header">
    <Link className="training-back" to={to}><Icon name="chevron-left" size={16} />{label}</Link>
    {name && <div className="training-brand">
      {(owner.logo_url || owner.avatar_url) && <img src={owner.logo_url || owner.avatar_url} alt={`${name} logo`} />}
      <span>{name}</span>
    </div>}
  </header>;
}

export function TrainingFooter() {
  return <footer className="training-footer"><img src="/florrie-petal.svg" alt="" width="18" height="18" />Powered by <strong>florrie.ai</strong></footer>;
}

export function TrainingDateStamp({ date }) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? new Date(`${date}T12:00:00`) : null;
  return <span className="training-date-stamp" aria-hidden="true">
    {day && !Number.isNaN(day.getTime()) ? <><span>{day.toLocaleDateString('en-GB', { month: 'short' })}</span><strong>{day.getDate()}</strong></> : <Icon name="calendar" size={24} />}
  </span>;
}
