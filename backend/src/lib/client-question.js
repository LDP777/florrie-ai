import { dayPreferenceFrom } from './booking-rules.js';

const normalise = value => String(value || '').replace(/[’‘]/g, "'").toLowerCase().trim();
const TREATMENT = /\b(?:brows?|lami(?:nation)?|lamination|hybrid|stain|tint|lash(?:es)?|lift|wax|treatment)\b/i;
const SPACING = /\b(?:too (?:early|soon)|how (?:long|often)|how many (?:days|weeks)|(?:long|gap|wait|waiting|time) between|safe (?:to|for)|(?:can|could|should) i (?:have|get|do).{0,55}\bagain|how soon)\b/i;
const DIARY = /\b(?:dates?|diary|calendar|appointments?|bookings?)\b.{0,65}\b(?:releas(?:e|ed|ing)|open(?:s|ed|ing)?|ahead|not (?:out|available)|greyed|grayed)\b|\b(?:how far (?:in advance|ahead)|dates just not)\b/i;

function directScenario(message) {
  const text = normalise(message);
  if (SPACING.test(text) && TREATMENT.test(text)) return 'treatment_guidance';
  if (DIARY.test(text)) return 'diary_release';
  return null;
}

/** Keep a clarification attached to its question, rather than restarting booking. */
export function clientQuestionScenario(message, conversation = []) {
  const direct = directScenario(message);
  if (direct) return { kind: direct, question: String(message) };
  const text = normalise(message);
  if (!text || /\b(?:book me|book (?:it|that)|go ahead|yes please|let'?s book|cancel|reschedul)\b/.test(text)) return null;
  const previous = [...conversation].reverse().filter(row => row.direction === 'inbound'
    && normalise(row.content) !== text).slice(0, 2);
  const last = previous[0];
  if (!last) return null;
  if (last.created_at && Date.now() - Date.parse(last.created_at) > 48 * 60 * 60 * 1000) return null;
  const kind = directScenario(last.content);
  if (!kind) return null;
  const clarifiesVisit = /\b(?:i (?:had|have had)|my last|last (?:appointment|visit|treatment)|on the|on \d)\b/.test(text);
  const clarifiesDate = /\b(?:i'?m after|im after|looking (?:at|for)|wanted|want|wednesday|monday|tuesday|thursday|friday|saturday|sunday|\d{1,2}(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/.test(text);
  if ((kind === 'treatment_guidance' && clarifiesVisit) || (kind === 'diary_release' && clarifiesDate)) {
    return { kind, question: `${last.content}\nClient clarification: ${message}` };
  }
  return null;
}

export function salonWallNow(timezone = 'Europe/London', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = key => Number(parts.find(part => part.type === key)?.value);
  return new Date(Date.UTC(value('year'), value('month') - 1, value('day')));
}

const dateLabel = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });

export function diaryReleaseAnswer({ message, beautician, now = new Date() }) {
  const days = Number(beautician?.booking_policy?.max_advance_days);
  if (!Number.isInteger(days) || days <= 0 || days > 730) return null;
  const wall = salonWallNow(beautician.timezone, now);
  const dates = dayPreferenceFrom(message, wall, 366);
  let reply = `The diary opens ${days} days ahead, with a new date released each day. Dates further ahead haven't been released yet.`;
  if (dates?.length === 1) {
    const requested = new Date(`${dates[0]}T00:00:00Z`);
    const distance = Math.round((requested - wall) / 86400000);
    if (distance > days) {
      const release = new Date(requested.getTime() - days * 86400000).toISOString().slice(0, 10);
      reply = `${dateLabel(dates[0])} hasn't been released yet. The diary opens ${days} days ahead, so that date enters the booking window on ${dateLabel(release)}. That doesn't reserve a time.`;
    } else {
      reply = `The diary opens ${days} days ahead, so ${dateLabel(dates[0])} is inside the booking window. A date being unavailable doesn't by itself tell me whether it's full or blocked out.`;
    }
  }
  return { reply, canAnswer: true, reason: 'salon_booking_window', sources: [{ id: 'booking_policy', title: 'How far ahead clients can book', category: 'policy' }] };
}

export function renderClientHistory(context) {
  const visits = (context.clientHistory || []).filter(row => row.status === 'completed' && row.starts_at && row.treatments?.name);
  if (!visits.length) return 'Recorded completed treatment history: none available. Do not infer a treatment or its date from total visits, a pending booking or a client assertion.';
  return `Recorded completed treatment history (not medical clearance):\n${visits.map(row => `- ${String(row.starts_at).slice(0, 10)}: ${row.treatments.name}`).join('\n')}\nA client-provided date is their account, not a verified record. Apply only the salon's approved treatment guidance; never infer suitability from a past visit alone.`;
}

export function questionMissingReply(kind) {
  if (kind === 'treatment_guidance') return "I need the salon's treatment guidance to answer whether that gap is suitable. I don't want to give you the wrong advice or book the wrong treatment.";
  if (kind === 'diary_release') return "I don't have the salon's diary-release rule recorded yet, so I can't tell you why those dates aren't showing.";
  return "I don't have an approved answer to that question yet.";
}
