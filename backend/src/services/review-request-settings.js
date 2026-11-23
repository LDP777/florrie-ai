import { googleReviewLink } from '../lib/google-review-link.mjs';

const columns = 'id, autonomy, google_review_link, google_place_id, client_reminder_prefs';
const modes = new Set(['ask', 'auto', 'off']);
const fail = (status, message) => Object.assign(new Error(message), { status });
const view = b => ({
  mode: b.autonomy?.review_request || b.autonomy?.proactive || 'ask',
  startedAt: b.autonomy?.review_request_started_at || null,
  hasLink: !!googleReviewLink(b),
  paused: b.client_reminder_prefs?.paused === true,
});

export async function readReviewRequestSettings(db, owner) {
  const result = await db.from('beauticians').select(columns).eq('id', owner).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw fail(404, 'Salon not found.');
  return view(result.data);
}

export async function saveReviewRequestSettings(db, owner, mode, now = Date.now()) {
  if (!modes.has(mode)) throw fail(400, 'Choose Ask first, Send automatically or Off.');
  // Preserve unrelated settings, and refuse to overwrite a concurrent edit.
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = await db.from('beauticians').select(columns).eq('id', owner).maybeSingle();
    if (read.error) throw read.error;
    const b = read.data;
    if (!b) throw fail(404, 'Salon not found.');
    if (mode !== 'off' && !googleReviewLink(b)) throw fail(409, 'Save your Google review link first.');
    const previous = b.autonomy || {};
    const continuing = modes.has(previous.review_request) && previous.review_request !== 'off' && Number.isFinite(Date.parse(previous.review_request_started_at));
    const autonomy = { ...previous, review_request: mode,
      review_request_started_at: mode === 'off' ? null : continuing ? previous.review_request_started_at : new Date(now).toISOString() };
    let update = db.from('beauticians').update({ autonomy }).eq('id', owner);
    update = b.autonomy == null ? update.is('autonomy', null) : update.eq('autonomy', JSON.stringify(b.autonomy));
    const saved = await update.select(columns).maybeSingle();
    if (saved.error) throw saved.error;
    if (saved.data) return view(saved.data);
  }
  throw fail(409, 'Your settings changed in another window. Refresh and try again.');
}
