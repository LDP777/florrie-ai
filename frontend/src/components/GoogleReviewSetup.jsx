import { useState } from 'react';
import { updateRow } from '../lib/supabase.js';
import { googleReviewLink, normaliseGoogleReviewLink } from '../../../backend/src/lib/google-review-link.mjs';
import Button from './ui/Button.jsx';
import Icon from './ui/Icon.jsx';

export default function GoogleReviewSetup({ beautician, onSaved }) {
  const [saved, setSaved] = useState(() => googleReviewLink(beautician));
  const [value, setValue] = useState(() => googleReviewLink(beautician) || '');
  const [editing, setEditing] = useState(!saved);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    const link = normaliseGoogleReviewLink(value);
    if (!link) { setError('Paste the full review link from Google Business Profile, usually g.page/r/…/review.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await updateRow('beauticians', beautician.id, { google_review_link: link });
      setSaved(link); setValue(link); setEditing(false);
      setNotice('Review link saved. Future requests will use this link.');
      onSaved?.();
    } catch { setError('Could not confirm the save. Your link is still here; refresh to check before trying again.'); }
    finally { setBusy(false); }
  }
  return <section className="fl-google-review" aria-labelledby="google-review-heading">
    <div className="fl-google-review-heading"><span className="fl-studio-icon"><Icon name="star" size={22} /></span><div><span className="fl-workspace-eyebrow">Word of mouth, made easier</span><h2 id="google-review-heading">Ask clients for a review</h2></div></div>
    <p>Give clients a direct link to review your salon after their visit.</p>
    {saved && !editing ? <>
      <div className="fl-review-link-state"><Icon name="check-circle" size={17} /><span>Review link saved</span></div>
      <div className="fl-studio-actions"><a className="fl-studio-link" href={saved} target="_blank" rel="noopener noreferrer">Check your link ↗</a><Button variant="quiet" onClick={() => { setEditing(true); setNotice(''); }}>Change link</Button><Button variant="quiet" onClick={async () => { try { await navigator.clipboard.writeText(saved); setNotice('Review link copied.'); } catch { setError('Could not copy. Open your link to copy it from the address bar.'); } }}>Copy link</Button></div>
    </> : <form onSubmit={save}>
      <label className="fl-studio-field">Google review link<input type="url" value={value} onChange={e => { setValue(e.target.value); setError(''); }} placeholder="https://g.page/r/…/review" required disabled={busy} /></label>
      <p className="fl-studio-note">In your Google Business Profile, choose “Ask for reviews”, then copy the link.</p>
      <div className="fl-studio-actions"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save review link'}</Button>{saved && <Button variant="quiet" disabled={busy} onClick={() => { setEditing(false); setValue(saved); setError(''); }}>Cancel</Button>}<a className="fl-studio-link" href="https://business.google.com/" target="_blank" rel="noopener noreferrer">Open Google Business Profile ↗</a></div>
    </form>}
    {notice && <p role="status" className="fl-studio-note">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    <p className="fl-studio-note">Requests follow your existing sending preferences. Check your Business Profile connection in the Google reviews section above.</p>
  </section>;
}
