/**
 * Junk classifier for inbound messages.
 *
 * Ellie's Instagram inbox fills with outreach that has nothing to do with her
 * salon: cold service pitches ("I'm a beauty retoucher, I'll do one free test
 * photo"), follower selling, wingman messages ("my friend just moved here and
 * Tinder's been a disaster, here's her Snap"), crypto, and generic blast DMs.
 * Every one of those escalated like a real client and inflated the nav badge
 * until it read "99+" and meant nothing.
 *
 * The bias here is deliberate and one-directional: hiding a real client is far
 * worse than letting one spammer through. So:
 *   1. Anything that smells like salon business is NEVER junk, even if it also
 *      trips a spam signal. The booking guard wins over everything.
 *   2. A message from someone she already deals with is NEVER junk.
 *   3. Otherwise we need one unambiguous signal, or two weak ones. A single
 *      weak signal is never enough on its own.
 *
 * Junk is a display and notification decision only. The message is still
 * stored and still visible in the inbox; it just stops shouting.
 *
 * Pure functions, no database and no network, so this file is trivially
 * testable in isolation.
 */

/**
 * Salon vocabulary. A message containing any of this is treated as real
 * business and can never be flagged, no matter what else it says. Deliberately
 * generous: every entry here trades a possible missed spammer for the
 * certainty that a paying client is never hidden.
 */
const BOOKING_GUARD = [
  // Booking mechanics
  /\bappointment(s)?\b/, /\bappt\b/, /\bbook(ing|ed|s)?\b/, /\brebook\b/,
  /\bre-?schedul(e|ing|ed)\b/, /\bcancel(l(ing|ed|ation))?\b/,
  /\bavailabilit(y|ies)\b/, /\bslot(s)?\b/, /\bopening(s)?\b/,
  /\bwaiting list\b/, /\bwaitlist\b/, /\bfit me in\b/, /\bsqueeze me in\b/,
  /\bdo you (do|have|take)\b/, /\bare you (free|open|available|working)\b/,
  /\bcome in\b/, /\bpop in\b/, /\brunning late\b/, /\bon my way\b/,
  // Money and admin
  /\bdeposit(s)?\b/, /\bprice(s|list)?\b/, /\bpricing\b/, /\bcost(s)?\b/,
  /\bhow much\b/, /\bpay(ment|ing)?\b/, /\brefund\b/, /\binvoice\b/,
  // Treatments and salon nouns
  /\btreatment(s)?\b/, /\blash(es|ify)?\b/, /\bbrow(s)?\b/, /\bnail(s)?\b/,
  /\binfill(s)?\b/, /\brefill(s)?\b/, /\bextension(s)?\b/, /\bfacial(s)?\b/,
  /\bwax(ing)?\b/, /\btint(ing)?\b/, /\blamination\b/, /\blash lift\b/,
  /\bmanicure\b/, /\bpedicure\b/, /\bgel(s)?\b/, /\bacrylic(s)?\b/,
  /\bspray tan\b/, /\bmassage\b/, /\bthreading\b/, /\bmicroblading\b/,
  /\bhair\b/, /\bbalayage\b/, /\bcolour\b/, /\bhighlights\b/,
  /\bpatch test\b/, /\bconsultation\b/, /\baftercare\b/, /\ballerg(y|ic|ies)\b/,
  // Time talk, which almost always means someone is arranging a visit
  /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/, /\bweekend\b/,
  /\btomorrow\b/, /\btonight\b/, /\bnext week\b/, /\bthis week\b/,
  /\b\d{1,2}\s?(am|pm)\b/, /\b\d{1,2}[:.]\d{2}\b/,
];

/**
 * One of these on its own is enough. Each is something a client of a beauty
 * salon would essentially never write in a message to her.
 */
const STRONG_SIGNALS = [
  {
    id: 'dating',
    // Naming a dating app, or playing wingman for a mate.
    pattern: /\b(tinder|hinge|bumble|grindr|badoo|plenty of fish)\b|\bwing\s?man\b|\bset (her|him) up\b|\b(are|r) (you|u) single\b|\blooking for (love|a (girl|guy|man|woman)friend)\b/,
    reason: 'dating or wingman message',
  },
  {
    id: 'crypto',
    pattern: /\b(bitcoin|btc|ethereum|crypto(currency)?|usdt|binance|forex|binary option(s)?|nft(s)?)\b|\btrading (signals?|account|platform)\b|\binvestment (plan|opportunity|scheme)\b/,
    reason: 'crypto or investment pitch',
  },
  {
    id: 'follower_selling',
    pattern: /\b(buy|sell|get|gain|grow|boost|increase)\b[^.!?]{0,40}\b(followers?|likes?|subscribers?|engagement|reach)\b|\b\d{3,}\s*\+?\s*(followers?|likes?)\b|\bblue\s?tick\b|\bverified badge\b|\b(instagram|ig|account) growth\b|\bgrowth service\b/,
    reason: 'follower or engagement selling',
  },
  {
    id: 'cold_pitch',
    // "I'm a <freelance trade>" is a pitch opener. A client introduces herself
    // by name, not by profession, and if she did mention her job she would
    // still be asking about a treatment, which the booking guard catches first.
    pattern: /\b(i'?m|i am|we'?re|we are)\s+(a|an)\s+(freelance\s+|professional\s+|certified\s+)?(retoucher|photo\s*retoucher|photo\s*editor|video\s*editor|videographer|graphic\s*designer|web\s*(designer|developer)|app\s*developer|software\s*(developer|engineer)|social\s*media\s*(manager|marketer|expert)|digital\s*marketer|marketing\s*(agency|consultant)|seo\s*(expert|specialist|consultant)|virtual\s*assistant|lead\s*generation)\b|\bretouch(er|ing)\b/,
    reason: 'cold service pitch',
  },
  {
    id: 'mass_outreach',
    pattern: /\bdear\s+(sir|madam|sir\s*\/\s*madam|business owner)\b|\bunsubscribe\b|\byou(?:'ve| have)? been (selected|chosen)\b|\bcongratulations\b[^.!?]{0,40}\b(won|winner|prize)\b|\bclaim your (prize|reward|gift)\b/,
    reason: 'generic mass outreach',
  },
];

/**
 * Weak signals. Any one of these turns up in honest messages often enough to
 * be untrustworthy alone, so we require two before flagging.
 */
const WEAK_SIGNALS = [
  { id: 'found_your_page', pattern: /\b(came across|stumbled (up)?on|noticed|found|been following)\b[^.!?]{0,30}\b(your|the)\s+(page|profile|account|instagram|business|work|content)\b/ },
  { id: 'no_obligation',   pattern: /\bno obligation\b|\bnothing to lose\b|\bno strings\b/ },
  { id: 'free_offer',      pattern: /\b(completely|totally|absolutely|100%)\s+free\b|\bfree\s+(sample|test|trial|edit|mockup|audit|demo|photo)\b|\bat no cost\b/ },
  { id: 'if_interested',   pattern: /\blet me know if (you'?re|you are|interested)\b|\bif (you'?re|you are) interested\b|\bwould you be interested\b/ },
  { id: 'portfolio',       pattern: /\bportfolio\b|\bsamples? of my work\b|\bmy previous (work|clients)\b|\bcase stud(y|ies)\b/ },
  { id: 'collab',          pattern: /\bcollab(oration|orate)?\b|\bpartnership\b|\bwork together\b|\bteam up\b/ },
  { id: 'bio_link',        pattern: /\bdm me\b|\bcheck (out )?my bio\b|\blink in (my )?bio\b|\bswipe up\b|\bclick the link\b/ },
  { id: 'boilerplate',     pattern: /\bhope (this (message|email) finds you|you'?re (doing )?well|you are (doing )?well)\b|\bi hope you'?re having a (great|good)\b/ },
  { id: 'guarantee',       pattern: /\bguarantee(d|s)?\b[^.!?]{0,40}\bresults?\b|\brisk[- ]free\b|\bdouble your\b/ },
  { id: 'more_clients',    pattern: /\b(more|new|extra)\s+(clients|customers|bookings|sales|leads)\b|\bgrow your business\b|\bscale your\b/ },
  { id: 'friend_moved',    pattern: /\b(my|a)\s+(friend|mate|sister|cousin)\b[^.!?]{0,40}\b(just )?(moved|relocated|is new)\b/ },
  { id: 'snap_handoff',    pattern: /\b(her|his|their)\s+snap\b|\badd (her|him|them) on\b|\bsnapchat\b/ },
  { id: 'link',            pattern: /https?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]{2,}/ },
];

// Below this length a message cannot carry a pitch, and short greetings are
// exactly what a nervous first-time client sends. Never flag them.
const MIN_LENGTH_TO_JUDGE = 25;

/**
 * Decide whether an inbound message is junk.
 *
 * @param {string} text            the message body as stored
 * @param {object} [opts]
 * @param {boolean} [opts.isKnownClient]  she already deals with this person
 * @returns {{ isJunk: boolean, reason: string|null, signals: string[] }}
 */
export function classifyInboundMessage(text, opts = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const lower = clean.toLowerCase();

  const none = { isJunk: false, reason: null, signals: [] };

  // Someone she already knows is never junk, whatever they typed.
  if (opts.isKnownClient) return none;

  // Media placeholders ("[Photo]", "[Voice note...]") carry no text to judge.
  if (!clean || /^\[[^\]]*\]$/.test(clean)) return none;

  if (clean.length < MIN_LENGTH_TO_JUDGE) return none;

  // Salon business beats every spam signal. This is the guard that keeps a
  // real client from ever being hidden.
  if (BOOKING_GUARD.some((re) => re.test(lower))) return none;

  const strong = STRONG_SIGNALS.filter((s) => s.pattern.test(lower));
  if (strong.length > 0) {
    return {
      isJunk: true,
      reason: strong.map((s) => s.reason).join(', '),
      signals: strong.map((s) => s.id),
    };
  }

  const weak = WEAK_SIGNALS.filter((s) => s.pattern.test(lower));
  if (weak.length >= 2) {
    return {
      isJunk: true,
      reason: 'unsolicited outreach',
      signals: weak.map((s) => s.id),
    };
  }

  return none;
}

/**
 * Cheap "does she already deal with this person" test, from a clients row.
 * Deliberately loose: any recorded visit or any contact detail she did not
 * just receive counts, because the cost of getting this wrong is hiding a
 * real client.
 *
 * @param {object} client        a row from `clients`
 * @param {object} [opts]
 * @param {string} [opts.channel] the channel this message arrived on
 */
export function looksLikeKnownClient(client, opts = {}) {
  if (!client) return false;

  // History is proof on any channel.
  if (Number(client.total_visits) > 0) return true;
  if (client.last_visit_at) return true;
  if (client.status && client.status !== 'new') return true;
  if (client.email) return true;

  // A phone number only means something if it did NOT arrive with this
  // message. Every WhatsApp and SMS sender has one by construction, so
  // treating it as evidence there would exempt the whole channel and the
  // classifier would never fire.
  const phoneCameWithTheMessage = opts.channel === 'whatsapp' || opts.channel === 'sms';
  if (!phoneCameWithTheMessage && (client.phone || client.whatsapp_id)) return true;

  return false;
}

/**
 * The junk columns and clients.instagram_username arrive in migration 016,
 * which Levi runs by hand. Until it has been applied (and Railway restarted,
 * because PgBouncer caches the schema), a select naming those columns fails
 * with Postgres 42703. Callers use this to fall back to the old shape rather
 * than 500 the inbox.
 */
export function isMissingColumnError(error) {
  if (!error) return false;
  if (error.code === '42703') return true;
  return /column .* does not exist/i.test(error.message || '');
}
