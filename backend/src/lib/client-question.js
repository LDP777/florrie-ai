import { dayPreferenceFrom } from './booking-rules.js';
import { isTrainingEnquiry } from './training-enquiry.js';
import { isUnavailableStoryContext } from './instagram-story-context.js';
import { hasExplicitBookingRequest } from './booking-request.js';
import { isBookingProblem } from './booking-problem.js';

const normalise = value => String(value || '').replace(/[’‘]/g, "'").toLowerCase().trim();
const TREATMENT = /\b(?:brows?|lami(?:nation)?|lamination|hybrid|stain|tint|lash(?:es)?|lift|wax|treatment)\b/i;
const SPACING = /\b(?:too (?:early|soon)|how often|how long.{0,35}\b(?:between|before|after|until|wait)|how many (?:days|weeks)|(?:long|gap|wait|waiting|time) between|safe (?:to|for)|(?:can|could|should) i (?:have|get|do).{0,55}\bagain|how soon)\b/i;
const DIARY = /\b(?:dates?|diary|calendar|appointments?|bookings?)\b.{0,65}\b(?:releas(?:e|ed|ing)|open(?:s|ed|ing)?|ahead|not (?:out|available)|greyed|grayed)\b|\b(?:how far (?:in advance|ahead)|dates just not)\b/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_PATTERNS = ['jan(?:uary)?', 'feb(?:ruary)?', 'mar(?:ch)?', 'apr(?:il)?', 'may(?!\\s+(?:i|we|you|they)\\b)', 'jun(?:e)?', 'jul(?:y)?', 'aug(?:ust)?', 'sep(?:t(?:ember)?)?', 'oct(?:ober)?', 'nov(?:ember)?', 'dec(?:ember)?'];

/** A named campaign/month is not evidence that its diary has been announced. */
export function diaryReleaseScope(message) {
  const text = normalise(message);
  if (/\b(?:christmas|xmas|festive)\b/.test(text)) return 'christmas';
  if (/\bnew year'?s?\b/.test(text)) return 'new year';
  const monthIndex = MONTH_PATTERNS.findIndex(pattern => new RegExp(`\\b${pattern}\\b`).test(text));
  return MONTHS[monthIndex] || null;
}

export function diaryScopeMentioned(text, scope) {
  if (scope === 'christmas') return /\b(?:christmas|xmas|festive)\b/i.test(text);
  if (scope === 'new year') return /\bnew year'?s?\b/i.test(text);
  const index = MONTHS.indexOf(scope);
  return index >= 0 && new RegExp(`\\b${MONTH_PATTERNS[index]}\\b`, 'i').test(text);
}

/** Only a current, explicit announcement can answer a named-period release. */
export function usableDiaryReleaseNote(note, question, beautician, now = new Date()) {
  const content = String(note.content || '');
  const scope = diaryReleaseScope(question);
  if (scope && !diaryScopeMentioned(`${note.title || ''} ${content}`, scope)) return false;
  if (!/\b(?:open(?:s|ed|ing)?|releas(?:e|es|ed|ing)|roll(?:ing)?\s+out|(?:can|able to)\s+book|book(?:ings?)?\s+(?:from|on|now)|available\s+(?:to book|from|on)|bookable)\b/i.test(content)) return false;
  // An active note is not a timestamp for "tomorrow". Require an actual date
  // or a reusable rule instead of replaying a temporary announcement forever.
  if (/\b(?:today|tomorrow|tonight|next (?:week|month))\b/i.test(content)) return false;
  const wall = salonWallNow(beautician?.timezone, now);
  const questionYears = [...String(question).matchAll(/\b20\d{2}\b/g)].map(match => Number(match[0]));
  if (new Set(questionYears).size > 1) return false;
  const month = scope === 'christmas' ? 11 : scope === 'new year' ? 0 : MONTHS.indexOf(scope);
  const targetYear = questionYears[0] || (wall.getUTCFullYear() + (month >= 0 && month < wall.getUTCMonth() ? 1 : 0));
  const noteYears = [...`${note.title || ''} ${content}`.matchAll(/\b20\d{2}\b/g)].map(match => Number(match[0]));
  return !noteYears.length || noteYears.includes(targetYear);
}

function diaryReleaseQuestion(text) {
  if (DIARY.test(text)) return true;
  // People ask when dates are "out" as often as when they are "released".
  // Recognise both word orders before the booking classifier sees the request.
  if (/\b(?:dates?|diary|calendar|appointments?|bookings?|slots?)\s+(?:(?:are|is|be|been|coming|come|not|already|going|to)\s+){0,4}out\b/.test(text)) return true;
  if (/\b(?:releas(?:e|ed|ing)|open(?:s|ed|ing)?|launch(?:ed|ing)?)\b.{0,65}\b(?:dates?|diary|calendar|appointments?|bookings?|slots?)\b/.test(text)) return true;
  const scope = diaryReleaseScope(text);
  return !!scope && /\b(?:when|are|is|have|has|will|do)\b/.test(text)
    && /\b(?:open(?:s|ed|ing)?|releas(?:e|ed|ing)|out|bookable)\b/.test(text);
}

// Appointment duration and treatment longevity are different facts. Only the
// former exists in the menu; aftercare, suitability and repeat intervals need
// approved guidance even when the same message also asks about the price.
export function treatmentMenuFields(message) {
  const text = normalise(message);
  if (!TREATMENT.test(text) && !/\b(?:services?|treatments?)\b/.test(text)) return [];
  // Leave requests for a visit in the appointment workflow. A menu answer is
  // not a complete response to a question that also asks for a time or booking.
  if (/\b(?:book|booking|cancel|reschedul\w*|slots?|spaces?|today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next (?:week|month)|this (?:week|month))\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.test(text)) return [];
  if (SPACING.test(text) || /\b(?:aftercare|mascara|pregnan\w*|allerg\w*|reaction|irritat\w*|lasts?|maintenance|safe|suitable|recommend|heal\w*)\b/.test(text)) return [];
  const fields = [];
  if (/\b(?:how much|price|cost|prices)\b/.test(text)) fields.push('price');
  if (/\b(?:duration|how long.{0,65}\b(?:take|appointment)|how much time)\b/.test(text)) fields.push('duration');
  if (/\b(?:do you (?:do|offer|provide)|what (?:services?|treatments?).{0,30}\b(?:offer|do you do|available)|which (?:services?|treatments?).{0,30}\b(?:offer|available))\b/.test(text)) fields.push('offering');
  return fields;
}

function directScenario(message) {
  const text = normalise(message);
  if (isBookingProblem(text)) return 'booking_problem';
  const maintenanceChoice = /\b(?:maintenance.{0,45}\b(?:right|need)|(?:should|do) i.{0,45}\bmaintenance)\b/.test(text);
  if ((SPACING.test(text) || maintenanceChoice) && TREATMENT.test(text)) return 'treatment_guidance';
  if (diaryReleaseQuestion(text)) return 'diary_release';
  if (treatmentMenuFields(text).length) return 'treatment_menu';
  return null;
}

function dependsOnStory(message) {
  // "This Friday" supplies its own date; "is it too soon for lamination"
  // asks a treatment question. Neither pronoun points to missing story media.
  let text = normalise(message)
    .replace(/\bthis\s+(?:morning|afternoon|evening|week(?:end)?|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, '')
    .replace(/\bis it(?=\s+(?:too (?:early|soon)|safe|suitable)\b)/g, 'is');
  const namedTreatment = TREATMENT.exec(text);
  if (namedTreatment && namedTreatment[0] !== 'treatment') {
    const afterSubject = namedTreatment.index + namedTreatment[0].length;
    // "A brow tint, how much is it?" names its own subject. Conversely,
    // "book it with a brow tint" still depends on an unnamed earlier subject.
    text = text.slice(0, afterSubject) + text.slice(afterSubject).replace(/\bit\b/g, '');
  }
  return /\b(?:that|this|it|these|those|story|stories|offer|promotion)\b/.test(text);
}

function selfContainedBookingRequest(message) {
  if (dependsOnStory(message)) return false;
  if (hasExplicitBookingRequest(message)) return true;
  const text = normalise(message);
  const treatment = TREATMENT.exec(text);
  if (treatment && treatment[0] !== 'treatment'
    && /\b(?:can|could|may)\s+i\s+(?:please\s+)?(?:get|have)\s+(?:(?:a|an|some|my|full|signature|classic|korean)\s+){0,3}$/.test(text.slice(0, treatment.index))) return true;
  // A named choice such as "Brow tint please" can start the engine too. Keep
  // its subsequent slot choices attached to it without treating bare treatment
  // mentions or price/suitability questions as new booking instructions.
  return !!treatment && treatment[0] !== 'treatment' && /\bplease\b/.test(text)
    && !/\b(?:when|where|why|how|what|which|not|don'?t|can'?t|is|are|does|do)\b/.test(text);
}

function priorContextBefore(message, conversation, matches) {
  const text = normalise(message);
  const previous = [...conversation];
  // gatherContext includes the row currently being processed. Exclude that
  // one row, not every older message which happens to repeat the same words.
  if (previous.at(-1)?.direction === 'inbound' && normalise(previous.at(-1)?.content) === text) previous.pop();
  for (const row of previous.reverse()) {
    if (row.direction === 'outbound' && ['human', 'ai_edited'].includes(row.authored_by)) return null;
    if (row.direction !== 'inbound') continue;
    if (row.created_at && Date.now() - Date.parse(row.created_at) > 48 * 60 * 60 * 1000) continue;
    if (matches(row)) return row;
    // An actual new request starts a different subject. Its later "that one"
    // or date choice belongs to that booking, not a story from earlier on.
    if (selfContainedBookingRequest(row.content)) return null;
  }
  return null;
}

/** Keep a clarification attached to its question, rather than restarting booking. */
export function clientQuestionScenario(message, conversation = []) {
  if (isUnavailableStoryContext(message)) return { kind: 'story_context', question: String(message) };
  const text = normalise(message);
  // "How much is that?" cannot be detached from an unseen story. Stop carrying
  // the uncertainty once the owner answers, or when the next request supplies
  // its own details instead of referring back to the missing content.
  const storyDependent = dependsOnStory(message);
  const explicitNewRequest = selfContainedBookingRequest(message);
  const hasDate = !!diaryReleaseScope(message)
    || /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|next week|next month)\b/.test(text);
  const dateClarification = hasDate && (/^(?:what|how) about\b/.test(text)
    || (!text.includes('?') && !/^(?:can|could|would|will|do|does|have|has|is|are|when|where|why|what|which|how)\b/.test(text)));
  if (!explicitNewRequest && (storyDependent || dateClarification)
    && priorContextBefore(message, conversation, isUnavailableStoryContext)) {
    return { kind: 'story_context', question: String(message) };
  }
  const training = isTrainingEnquiry(message, conversation);
  if (training.yes) return { kind: 'training_enquiry', question: training.sourceQuestion ? `${training.sourceQuestion}\nStudent follow-up: ${message}` : String(message) };
  const direct = directScenario(message);
  if (direct) return { kind: direct, question: String(message) };
  if (!text || explicitNewRequest || /\b(?:book me|book (?:it|that)|go ahead|yes please|let'?s book|cancel|reschedul)\b/.test(text)) return null;
  const clarifiesDate = /\b(?:i'?m after|im after|looking (?:at|for)|wanted|want|wednesday|monday|tuesday|thursday|friday|saturday|sunday|\d{1,2}(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/.test(text) || !!diaryReleaseScope(text);
  if (clarifiesDate) {
    // Older Instagram messages have no story marker. A declared diary-release
    // question still survives intervening comments; retain its actual wording
    // so a date fragment cannot become a fresh request for treatment choices.
    const releaseQuestion = priorContextBefore(message, conversation, row => directScenario(row.content) === 'diary_release');
    if (releaseQuestion) return { kind: 'diary_release', question: `${releaseQuestion.content}\nClient clarification: ${message}` };
  }
  const previous = [...conversation].reverse().filter(row => row.direction === 'inbound'
    && normalise(row.content) !== text).slice(0, 2);
  const last = previous[0];
  if (!last) return null;
  if (last.created_at && Date.now() - Date.parse(last.created_at) > 48 * 60 * 60 * 1000) return null;
  const kind = directScenario(last.content);
  if (!kind) return null;
  const clarifiesVisit = /\b(?:i (?:had|have had)|my last|last (?:appointment|visit|treatment)|on the|on \d)\b/.test(text);
  if (kind === 'treatment_guidance' && clarifiesVisit) {
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
  // max_advance_days limits booking; it does not describe a Christmas launch,
  // a whole month's release, or a promotion the owner has posted elsewhere.
  if ((diaryReleaseScope(message) && dates?.length !== 1)
    || /\b(?:christmas|xmas|festive|new year|story|stories|promo(?:tion)?|launch|batch|whole month|all (?:of )?(?:the )?dates)\b/i.test(message)) return null;
  let reply = `Online booking is limited to ${days} days ahead. That limit alone doesn't confirm when the salon will release dates or whether a time is available.`;
  if (dates?.length === 1) {
    const requested = new Date(`${dates[0]}T00:00:00Z`);
    const distance = Math.round((requested - wall) / 86400000);
    if (distance > days) {
      const release = new Date(requested.getTime() - days * 86400000).toISOString().slice(0, 10);
      reply = `${dateLabel(dates[0])} is outside the current ${days}-day online booking window. It enters that window on ${dateLabel(release)}, but that doesn't confirm the salon will open it or that a time will be available.`;
    } else {
      reply = `Online booking is limited to ${days} days ahead, so ${dateLabel(dates[0])} is inside the booking window. A date being unavailable doesn't by itself tell me whether it's full, blocked out or awaiting release.`;
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
  if (kind === 'story_context') return "I need the salon to check the story before I can answer that.";
  if (kind === 'booking_problem') return 'Please check the email address entered on the booking page and your junk or spam folder. If booking still fails, send a screenshot of the error with any verification codes or payment details hidden.';
  if (kind === 'training_enquiry') return 'I don’t have confirmed training dates and course details to answer that yet.';
  if (kind === 'treatment_guidance') return "I need the salon's treatment guidance to answer whether that gap is suitable. I don't want to give you the wrong advice or book the wrong treatment.";
  if (kind === 'diary_release') return "I don't have a confirmed release date for those appointments yet.";
  return "I don't have an approved answer to that question yet.";
}
