import { isIOSNative } from '../lib/platform.js';
import Button from './ui/Button.jsx';

export default function SalonAccessClosed({ onSignOut }) {
  return <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg)' }}>
    <section style={{ maxWidth: 400, textAlign: 'center', color: 'var(--text-primary)' }}>
      <img src="/florrie-petal.svg" alt="" width="48" height="48" />
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 30 }}>Salon access is invite only</h1>
      <p style={{ lineHeight: 1.6, color: 'var(--text-secondary)' }}>Booking a treatment or course? Open the link your salon shared. You don’t need to set up a business account.</p>
      {onSignOut ? <Button onClick={onSignOut}>Sign out</Button> : <Button as="a" href="/login">Salon sign in</Button>}
      {!isIOSNative() && <p><a href="/landing.html#waitlist" style={{ color: 'var(--accent)' }}>Join the Florrie waitlist</a></p>}
    </section>
  </main>;
}
