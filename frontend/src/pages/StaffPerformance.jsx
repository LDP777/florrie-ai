import { Link } from 'react-router-dom';
import Icon from '../components/ui/Icon';
import Button from '../components/ui/Button.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';

export default function StaffPerformance() {
  return <div style={s.page}>
    <PageHeader title="Team performance" eyebrow="Team" subtitle="Review your business and manage your team." />
    <section style={s.card}>
      <span style={s.icon}><Icon name="chart" size={28} /></span>
      <h2 style={s.title}>Individual reports aren’t available yet.</h2>
      <p style={s.description}>Florrie doesn’t record revenue, bookings or client ratings against individual team members. You can review business totals in Analytics.</p>
      <Button as={Link} to="/analytics">Open business analytics</Button>
    </section>
    <div style={s.links}>
      <Button as={Link} to="/team" variant="secondary"><Icon name="users" size={19} />Manage team members</Button>
      <Button as={Link} to="/rota" variant="secondary"><Icon name="calendar" size={19} />View staff rota</Button>
    </div>
  </div>;
}
const s = {
  page: { maxWidth: 760, margin: '0 auto', padding: '20px 16px var(--scroll-pad-bottom,100px)', fontFamily: "'Plus Jakarta Sans',sans-serif", color: 'var(--text-primary)' },
  card: { borderRadius: 24, padding: 27, margin: '10px 0 20px', border: '1px solid var(--border)', background: 'var(--accent-wash,#FBF2F5)' },
  icon: { display: 'grid', placeItems: 'center', width: 56, height: 56, borderRadius: 18, color: 'var(--accent)', background: 'var(--bg-card,#FFFCF9)', marginBottom: 23 },
  title: { fontFamily: "'Playfair Display',Georgia,serif", fontSize: 27, fontWeight: 500, lineHeight: 1.3, margin: '0 0 14px' },
  description: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8, maxWidth: 490, marginBottom: 24 },
  links: { display: 'flex', gap: 12, flexWrap: 'wrap' },
};
