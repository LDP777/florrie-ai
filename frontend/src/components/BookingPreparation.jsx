import { useEffect, useState } from 'react';
import { API_BASE } from '../lib/config.js';
import Button from './ui/Button.jsx';
import ConsultationFormPublic from '../pages/ConsultationFormPublic.jsx';

export const preparationTime = (value, wall = false, timezone = 'Europe/London') => value ? new Date(value).toLocaleString('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: wall ? 'UTC' : timezone,
}) : '';
export function patchPreparationCopy(patch) {
  switch (patch?.state) {
    case 'needed': return ['Book your patch test', 'Choose a time at least 48 hours before your treatment.'];
    case 'check_record': return ['Check your patch-test record', 'Your tech needs to confirm which treatment your previous test covers. Contact them before booking another test.'];
    case 'booked': return ['Patch test booked', `${preparationTime(patch.booked_at, true)}. Finish your consultation after your patch test and its 48-hour waiting period.`];
    case 'waiting': return ['Your 48-hour waiting period', `Complete your consultation from ${preparationTime(patch.ready_at, false, patch.timezone)} (salon time).${patch.evidence?.some(p => p.date_only) ? ' Only the test date is recorded, so this allows 48 hours from the end of that day. Your tech can record the actual time.' : ''}`];
    case 'ready': return ['Patch-test waiting period finished', 'Tell your tech the outcome in your consultation.'];
    case 'timing_review': return ['Check your patch-test timing', 'Your patch test does not leave the full 48 hours before treatment. Please contact your tech to arrange what happens next.'];
    case 'review': return ['Speak to your tech', 'A reaction is recorded. Please contact your tech before treatment. You can save any new information in your consultation.'];
    default: return ['Patch test', 'No patch test required for this booking.'];
  }
}
export function PreparationChecklist({ preparation, onPatch, onForm, busy = false, owner = false }) {
  const [title, detail] = patchPreparationCopy(preparation.patch);
  if (!preparation.confirmed) return <p>Your preparation checklist will appear once your booking is confirmed.</p>;
  const allReceived = preparation.forms.length > 0 && preparation.forms.every(f => f.status === 'received');
  return <div>
    <h2 style={S.title}>Before {owner ? 'their' : 'your'} appointment</h2>
    <p style={S.hint}>{owner ? 'Booking confirmed. ' : 'Your booking is confirmed. '}{allReceived ? 'Consultation received.' : 'Keep these steps together here.'}</p>
    {preparation.patch.required && <div style={S.step}>
      <span style={S.number}>1</span><div style={{ minWidth: 0 }}><h3 style={S.label}>{title}</h3><p style={S.copy}>{detail}</p>
        {onPatch && preparation.patch.state === 'needed' && <Button disabled={busy} onClick={onPatch}>Book your patch test</Button>}
      </div>
    </div>}
    {preparation.forms.map((form, index) => <div key={form.id} style={S.step}>
      <span style={S.number}>{index + (preparation.patch.required ? 2 : 1)}</span>
      <div style={{ minWidth: 0 }}><h3 style={S.label}>{form.status === 'received' ? 'Consultation received' : preparation.patch.can_complete ? 'Complete your consultation' : 'Finish your consultation after your patch test'}</h3>
        <p style={S.copy}>{form.name}{form.status === 'received' && form.completed_at ? ` · Received ${preparationTime(form.completed_at)}` : ''}</p>
        {form.review_required && <p style={{ ...S.copy, color: 'var(--accent)' }}>{owner ? 'Needs your review before treatment.' : 'Your tech has been asked to review your answers before treatment.'}</p>}
        {form.status !== 'received' && !preparation.patch.can_complete && <p style={S.copy}>You can save your answers now. Add the patch-test outcome and sign once the waiting period is complete.</p>}
        {form.status !== 'received' && onForm && form.available && <Button disabled={busy} variant={preparation.patch.can_complete ? 'primary' : 'secondary'} onClick={() => onForm(form.id)}>{busy ? 'Opening…' : preparation.patch.can_complete ? 'Complete consultation' : 'Save answers or report a concern'}</Button>}
        {!form.available && <p style={S.copy}>This form needs your tech’s attention. Please contact them.</p>}
      </div>
    </div>)}
    {preparation.missing_template && <p role="status" style={S.copy}>Your tech needs to set up the consultation for this treatment. Please contact them before your appointment.</p>}
    {!preparation.required && <p style={S.copy}>There are no preparation forms or patch tests required for this booking.</p>}
  </div>;
}
export default function BookingPreparation({ slug, token, refreshKey, onPatch, onStatus }) {
  const [prep, setPrep] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [formToken, setFormToken] = useState(null);
  const [openingError, setOpeningError] = useState('');
  useEffect(() => { setPrep(null); setFormToken(null); setError(''); }, [slug, token]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    setError('');
    fetch(`${API_BASE}/api/booking/${slug}/manage/${token}/preparation`, { signal: controller.signal })
      .then(async res => { const body = await res.json(); if (!res.ok || !body.preparation) throw new Error(body.error || 'Preparation could not be checked.'); return body.preparation; })
      .then(value => { if (active) { setPrep(value); onStatus?.(value); } })
      .catch(err => { if (active) setError(controller.signal.aborted ? 'Preparation took too long to load. Your booking details are still available.' : err.message); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [slug, token, refreshKey, attempt]);
  useEffect(() => {
    const refresh = () => setAttempt(n => n + 1);
    window.addEventListener('focus', refresh);
    const delay = Date.parse(prep?.patch?.ready_at) - Date.now();
    const timer = delay > 0 && delay < 2147483000 ? setTimeout(refresh, delay + 500) : null;
    return () => { window.removeEventListener('focus', refresh); if (timer) clearTimeout(timer); };
  }, [prep?.patch?.ready_at]);
  async function openForm(formId) {
    setBusy(true); setOpeningError('');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${API_BASE}/api/booking/${slug}/manage/${token}/consultations/${formId}/start`, { method: 'POST', signal: controller.signal });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not open the consultation.');
      if (body.completed) setAttempt(n => n + 1); else if (body.token) setFormToken(body.token); else throw new Error('Could not open the consultation.');
    } catch (err) { setOpeningError(controller.signal.aborted ? 'Opening the form took too long. Please try again.' : err.message); }
    finally { clearTimeout(timer); setBusy(false); }
  }
  const back = () => { setFormToken(null); setAttempt(n => n + 1); };
  return <section aria-label="Before your appointment" style={S.card}>
    {formToken ? <ConsultationFormPublic key={formToken} formToken={formToken} embedded onBack={back} onComplete={() => setAttempt(n => n + 1)} /> : <>
      {error ? <div role="alert"><h2 style={S.title}>Before your appointment</h2><p style={S.copy}>{error}</p><Button variant="secondary" onClick={() => setAttempt(n => n + 1)}>Retry checklist</Button></div>
        : prep ? <PreparationChecklist preparation={prep} onPatch={onPatch} onForm={openForm} busy={busy} /> : <p role="status">Checking your preparation steps…</p>}
      {openingError && <p role="alert" style={S.copy}>{openingError}</p>}
    </>}
  </section>;
}
const S = {
  card: { margin: '18px 0', padding: 22, background: 'var(--bg-card, #FFFCF9)', border: '1px solid var(--border, #E8DDD4)', borderRadius: 22, color: 'var(--text-primary, #2D2523)' },
  title: { fontFamily: 'var(--font-display, Georgia, serif)', fontSize: 25, lineHeight: 1.2, margin: '0 0 8px', fontWeight: 500 },
  hint: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: '0 0 18px' },
  step: { display: 'flex', gap: 12, padding: '16px 0', borderTop: '1px solid var(--border-light, #E8DDD4)' },
  number: { flexShrink: 0, width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--bg-subtle, #F5E9DE)', color: 'var(--accent, #92405E)', fontWeight: 600, fontSize: 13 },
  label: { fontSize: 15, margin: '3px 0 6px', lineHeight: 1.4 },
  copy: { fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary, #71665F)', margin: '0 0 12px' },
};
