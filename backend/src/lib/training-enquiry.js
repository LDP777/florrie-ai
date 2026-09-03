/**
 * Is this message about TRAINING, not treatment.
 *
 * Ellie, 1 September 2026, on why she wanted Florrie switched off: "it's
 * messing up me trying to get the training people enrolled". The front desk
 * knew the treatment menu and the diary and nothing else, so "how much is
 * your beginner course?" was answered from the price list, with slot times,
 * to somebody who wanted to spend seven hundred and fifty pounds learning
 * the trade from her. A course sale is a conversation Ellie has herself. It
 * is also, per student, the most valuable message her inbox ever receives.
 *
 * So: a training enquiry is never auto-answered. Florrie still writes the
 * draft, and the draft is given the real course list so it says the right
 * date and price and includes the enrol link, but Ellie presses send. If she
 * replies herself the thread is hers for a week anyway (owner-in-thread.js),
 * which is the second half of what she asked for.
 *
 * The one hard case is the word "course" itself. "Yes of course girl" is in
 * this codebase as an example of how Ellie talks, and clients say it back:
 * "of course", "in due course", "course you can". The bare word only counts
 * when it is not one of those, and the surer phrases do not need it at all.
 */

const TRAINING_PHRASES = new RegExp('\\b(?:' + [
  // The nouns of the trade.
  String.raw`training(?:\s+(?:course|day|dates?|session|academy|price|cost))?`,
  String.raw`masterclass(?:es)?`,
  String.raw`academy`,
  String.raw`accredit(?:ed|ation)`,
  String.raw`certificate(?:d|s)?|certified|certification`,
  String.raw`(?:beginner'?s?|beginners|foundation|advanced|conversion|refresher|1[\s-]?2[\s-]?1|one[\s-]to[\s-]one)\s+(?:lash|brow|nail|course|training|class)`,
  String.raw`(?:lash|brow|nail|lamination|extension|lift|volume|classic|russian|hybrid)\s+(?:course|training|class|masterclass|tutor|tutorial|academy)`,
  String.raw`(?:your|any|next|the|a)\s+courses?\b`,
  String.raw`courses?\s+(?:dates?|price|cost|fee|deposit|kit|manual|spaces?|spots?|places?|available|availability)`,
  // The verbs of somebody who wants to learn, not be treated.
  String.raw`(?:do you|do u|d'?you|would you|could you|can you|can u)\s+(?:teach|train|run (?:any )?(?:courses?|training|classes)|offer (?:any )?(?:courses?|training|classes)|do (?:any )?(?:courses?|training|classes))`,
  String.raw`(?:learn|learning)\s+(?:to do|how to do|to be a|lashes|brows|nails|lash|brow|extensions|lifts?|lamination)`,
  String.raw`(?:become|be|train as)\s+(?:a|an)\s+(?:lash|brow|nail|beauty)\s+(?:tech(?:nician)?|artist|therapist)`,
  String.raw`teach me`,
  String.raw`enrol(?:l|led|ling|ment)?|enroll(?:ed|ing|ment)?`,
  String.raw`(?:kit|model)\s+(?:for|on)\s+(?:the|your|my)\s+(?:course|training|class)`,
  String.raw`(?:want|wanting|looking|thinking)\s+(?:to|about|of)\s+(?:train(?:ing)?|learn(?:ing)?|get(?:ting)? (?:trained|qualified|certified))`,
  String.raw`get(?:ting)?\s+(?:trained|qualified|certified|into (?:lashes|brows|nails))`,
  String.raw`student\s+(?:discount|rate|price|kit)|as a student`,
].join('|') + ')\\b', 'i');

/**
 * The bare word "course", minus the idioms. Matched separately so the idioms
 * can be stripped first without weakening the phrases above.
 */
const BARE_COURSE = /\bcourses?\b/i;
const COURSE_IDIOMS = /\b(?:of|in due|on|par for the|stay the|run its|change of|crash|main|first|golf|race|the course of)\s+course\b|\bcourse\s+(?:you|we|i|she|he|they)\s+(?:can|will|do|did|could|would|are|is)\b|\bcourse (?:that'?s|it'?s|thats|its) fine\b|\bcourse (?:not|hun|lovely|babe|girl)\b|\bcourse[!.]/i;

/**
 * @param {string} message the client's own words
 * @returns {{yes: boolean, reason: string|null}}
 */
export function isTrainingEnquiry(message) {
  const body = String(message || '');
  if (!body.trim()) return { yes: false, reason: null };

  if (TRAINING_PHRASES.test(body)) return { yes: true, reason: 'training_enquiry' };

  const stripped = body.replace(COURSE_IDIOMS, ' ');
  if (BARE_COURSE.test(stripped)) return { yes: true, reason: 'training_enquiry' };

  return { yes: false, reason: null };
}

/**
 * One line per course for a prompt. Only what a student would be told, and
 * nothing the model could turn into an offer that is not real: no spaces
 * count when it is zero (the course is simply "full"), no invented times.
 *
 * @param {Array<object>} courses rows from the courses table, active only
 * @param {string} bookingSlug the salon's slug, for the enrol link
 * @returns {string}
 */
export function renderCoursesBlock(courses, bookingSlug) {
  const rows = (courses || []).filter(c => c && c.name);
  if (!rows.length) {
    return 'TRAINING COURSES: none are open for booking right now. If the client asks about training, say you will come back to them about dates, and do not quote a price or offer treatment appointment times instead.';
  }
  const lines = rows.map(c => {
    const spots = Math.max(0, Number(c.max_students || 0) - Number(c.enrolled || 0));
    const parts = [
      c.name,
      c.date ? `on ${formatCourseDate(c.date)}` : 'date to be confirmed',
      c.start_time ? `starting ${String(c.start_time).slice(0, 5)}` : null,
      c.duration || null,
      c.location ? `at ${c.location}` : null,
      `£${Number(c.price || 0).toFixed(0)}`,
      Number(c.deposit) > 0 ? `(£${Number(c.deposit).toFixed(0)} deposit to book)` : null,
      spots > 0 ? `${spots} place${spots === 1 ? '' : 's'} left` : 'FULL',
      `enrol: florrie.ai/training/${bookingSlug || 'book'}/${c.id}`,
    ].filter(Boolean);
    return `- ${parts.join(', ')}`;
  });
  return [
    'TRAINING COURSES (this is training for other beauticians, NOT a treatment; never offer appointment times in reply to a training question):',
    ...lines,
    'Only state facts from this list. A course marked FULL cannot be booked; say so and offer to let them know about the next one.',
  ].join('\n');
}

export function formatCourseDate(d) {
  if (!d) return '';
  const dt = new Date(`${String(d).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(/^(\w+),/, '$1');
}
