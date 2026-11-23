import { googleReviewLink } from './google-review-link.mjs';

// Appointment dates hold salon wall time in the UTC slot.
export function reviewWallTime(timezone, now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'Europe/London', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(new Date(now));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
}

export function completedReviewVisit(appt, now = Date.now()) {
  return appt?.status === 'completed'
    && Number.isFinite(Date.parse(appt.starts_at))
    && Date.parse(appt.starts_at) <= reviewWallTime(appt.beauticians?.timezone, now)
    && !/\bpatch[ _-]?test\b/i.test(`${appt.treatments?.name || ''} ${appt.treatments?.category || ''}`);
}

export function completedVisitReviewLink(appt, now = Date.now()) {
  return completedReviewVisit(appt, now) ? googleReviewLink(appt.beauticians) : null;
}
