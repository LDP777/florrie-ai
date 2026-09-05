import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import PageLoader from '../components/PageLoader.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import Icon from '../components/ui/Icon';
import Button from '../components/ui/Button.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';

export default function ClientPortal() {
  const { beautician, loading } = useBeautician();
  const [copyState, setCopyState] = useState('idle');
  const [error, setError] = useState(null);
  if (loading) return <PageLoader />;
  const slug = beautician?.booking_slug;
  const bookingUrl = slug ? `https://florrie.ai/book/${encodeURIComponent(slug)}` : null;
  async function copyLink() {
    setCopyState('copying'); setError(null);
    try {
      await navigator.clipboard.writeText(bookingUrl);
      setCopyState('copied');
    } catch { setCopyState('idle'); setError('Could not copy the link. Select the address below and copy it.'); }
  }
  return <div className="booking-tools" style={s.page}>
    <style>{`.booking-tools a:focus-visible,.booking-tools input:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.booking-tools .booking-tool:hover{background:var(--tone-1,#fbf1ea)}.booking-tools a{text-decoration:none}.booking-tools *{box-sizing:border-box}`}</style>
    <PageHeader title="Booking page" eyebrow="Business setup" subtitle="Share your link and keep your booking details up to date." />
    {!beautician ? <ErrorCard message="Your business profile is unavailable. Reload to try again." /> : <>
      <section style={s.hero}>
        <span style={s.eyebrow}>Your public page</span>
        <h2 style={s.title}>{beautician.business_name || beautician.first_name || 'Your business'}</h2>
        {bookingUrl ? <>
          <label htmlFor="public-booking-link" style={s.label}>Booking link</label>
          <input id="public-booking-link" readOnly value={bookingUrl} onFocus={event => event.target.select()} style={s.input} />
          <div style={s.actions}>
            <Button onClick={copyLink} disabled={copyState === 'copying'}>{copyState === 'copied' ? 'Copied' : copyState === 'copying' ? 'Copying…' : 'Copy link'}</Button>
            <Button as="a" href={bookingUrl} target="_blank" rel="noopener noreferrer" variant="secondary">Open booking page <Icon name="external-link" size={15} /></Button>
          </div>
          {copyState === 'copied' && <p role="status" style={s.note}>Booking link copied.</p>}
          {error && <div role="alert" style={{ marginTop: 14 }}><ErrorCard message={error} /></div>}
          <div style={s.share}>
            <Button as="a" variant="quiet" size="sm" href={`https://wa.me/?text=${encodeURIComponent(`Book your next appointment here: ${bookingUrl}`)}`} target="_blank" rel="noopener noreferrer">WhatsApp</Button>
            <Button as="a" variant="quiet" size="sm" href={`mailto:?subject=Book%20an%20appointment&body=${encodeURIComponent(`You can book your next appointment here:\n${bookingUrl}`)}`}>Email</Button>
            <Button as="a" variant="quiet" size="sm" href={`https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(bookingUrl)}&size=300x300`} target="_blank" rel="noopener noreferrer">Open QR code</Button>
          </div>
        </> : <><p style={s.note}>Set up your booking link before you share it with clients.</p><Button as={Link} to="/setup" variant="secondary">Open setup guide</Button></>}
      </section>
      <h2 style={s.sectionTitle}>Prepare your page</h2>
      <p style={s.note}>Manage the details clients use when they book.</p>
      <div style={s.list}>{[
        ['/treatments', 'flower', 'Treatments & prices', 'Choose the services clients can book.'],
        ['/settings?section=hours', 'clock', 'Regular opening hours', 'Set your usual weekly availability.'],
        ['/hours', 'calendar', 'Holidays & closures', 'Add dates when your usual hours change.'],
        ['/settings?section=policy', 'shield', 'Booking policies', 'Set notice periods, deposits and cancellation rules.'],
        ['/settings', 'settings', 'Business details', 'Update your business name and contact details.'],
      ].map(([path, icon, title, description]) => <Link key={path} to={path} className="booking-tool" style={s.row}><span style={s.icon}><Icon name={icon} size={21} /></span><span style={{ flex: 1, minWidth: 0 }}><span style={s.rowTitle}>{title}</span><span style={s.rowDescription}>{description}</span></span><Icon name="chevron-right" size={19} /></Link>)}</div>
    </>}
  </div>;
}
const s = {
  page: { maxWidth: 760, margin: '0 auto', padding: '20px 16px var(--scroll-pad-bottom,100px)', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif" },
  hero: { background: 'var(--accent-wash,#FBF2F5)', border: '1px solid var(--border)', borderRadius: 24, padding: 23, margin: '8px 0 28px' },
  eyebrow: { fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--accent)' },
  title: { fontFamily: "'Playfair Display',Georgia,serif", fontSize: 27, fontWeight: 500, margin: '9px 0 22px' },
  label: { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 8 },
  input: { width: '100%', minHeight: 48, border: '1px solid var(--border)', borderRadius: 12, padding: 12, fontFamily: 'inherit', fontSize: 13, color: 'var(--text-primary)', background: 'var(--bg-card,#FFFCF9)' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  share: { display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 8 },
  note: { fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '8px 0 16px' },
  sectionTitle: { fontSize: 17, margin: 0 },
  list: { border: '1px solid var(--border)', borderRadius: 20, overflow: 'hidden', background: 'var(--bg-card,#FFFCF9)' },
  row: { display: 'flex', alignItems: 'center', gap: 14, padding: 18, borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' },
  icon: { width: 42, height: 42, flexShrink: 0, borderRadius: 13, background: 'var(--tone-1,#fbf1ea)', color: 'var(--accent)', display: 'grid', placeItems: 'center' },
  rowTitle: { display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 5 },
  rowDescription: { display: 'block', fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' },
};
