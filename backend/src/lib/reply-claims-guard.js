/**
 * Stops Florrie sending a client something that is not true.
 *
 * On 28 Jul 2026 Florrie told one of Ellie's clients that "4.30 on Thursday" was
 * available. It was not, and the appointment was never moved. Neither could have
 * been otherwise: the reply prompts are given NO clock times and NO diary, and
 * nothing in the inbound-message path is able to move a booking at all.
 *
 * The prompts have since been told not to do this. That is not enough. A model
 * handed "can I do 4.30 Thursday instead?" will agree, because the client
 * supplied the time and nothing contradicts it. An instruction is a preference;
 * this file is the check.
 *
 * Five claims are refused. Four of them can be backed by evidence:
 *   1. Naming a clock time that is not on the verified list of free slots.
 *   2. Saying a booking has been moved, changed or made, when no such write
 *      happened in the same request.
 *   3. Saying something has been, or is about to be, SENT to the client, when
 *      no send happened in the same request.
 *   4. Telling somebody standing outside how to get in, where to park, where to
 *      wait or which door it is, when the salon's own arrival note does not say
 *      so. See ARRIVAL_FACETS.
 * The fifth cannot be backed by anything, ever:
 *   5. Claiming to be physically present, to be ready, or to perform a
 *      physical act. Florrie is not in the building. See PRESENCE_CLAIMS.
 *
 * The third was added on 26 Aug 2026. A client wrote "...don't think I got a
 * confirmation. Do you know what the email is called?" and Florrie answered
 * "Hey, i'll send you a new one now. should come through in a min xx". Nothing
 * was sent. Nothing COULD have been sent: notifyBookingConfirmed is never
 * called from this service, and Florrie has no tools, so she described the
 * action instead of taking it and a real client sat waiting for an email that
 * was never coming.
 *
 * Every pattern in ACTION_CLAIMS is about a booking CHANGE (moved,
 * rescheduled, booked, sorted). A promise to send is a different sentence and
 * it walked straight through. That is the lesson worth writing down: the guard
 * had been scoped to the last incident rather than to the problem, which is
 * Florrie narrating an action nobody performed.
 *
 * Refusing means the draft is thrown away and replaced with a holding reply.
 * A warm "let me check my book and come straight back to you" is always safe,
 * and is what the prompt was supposed to fall back to on its own.
 */

// "4.30", "4:30", "16:30", "4pm", "half four". Deliberately greedy: a false
// positive costs a holding reply, a false negative costs a client turning up
// to a locked door.
// The lookbehind on the second pattern is load bearing. Without it "3.15pm"
// matches TWICE: once in full as 15:15, and again as the fragment "15pm",
// which normalises to 15:00. A reply offering a genuinely free quarter past
// was therefore refused for naming a time nobody wrote, and quarter past is
// one slot in four. This narrows the token, it does not widen the check: the
// only matches it drops are ones already consumed whole by the pattern above,
// because no standalone time is ever preceded by a digit, a dot or a colon.
const DIGIT_TIME_TOKENS = [
  /\b\d{1,2}\s*[.:]\s*\d{2}\s*(?:am|pm)?\b/gi,
  /(?<![\d.:])\b\d{1,2}\s*(?:am|pm)\b/gi,
];

const SPOKEN_TIME_TOKENS = [
  /\b(?:half|quarter past|quarter to)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi,
];

// A number that is money or a duration is not a clock time. Without this,
// "It is £35.50 and lasts 90 minutes" reads as 35:50 and gets refused.
const NOT_A_TIME = [
  /[£$€]\s*\d/,
  /\d\s*(?:minutes|minute|mins|min|hours|hour|hrs|hr)\b/i,
  /\bpoints?\b/i,
];

function looksLikeMoneyOrDuration(text, index, token) {
  const before = text.slice(Math.max(0, index - 2), index + token.length);
  const after = text.slice(index, index + token.length + 12);
  return NOT_A_TIME.some(p => p.test(before) || p.test(after));
}

// Phrases that assert a booking changed. Present tense included, because
// "you're moved to Thursday" is the same lie as "I have moved you".
const ACTION_CLAIMS = [
  /\b(?:i(?:'ve| have)?\s+)?(?:moved|rescheduled|changed|switched|shifted)\s+(?:you|your|it|that|the appointment)/i,
  /\byou(?:'re| are)\s+(?:now\s+)?(?:moved|rescheduled|booked|down|in)\b/i,
  /\b(?:that(?:'s| is)|it(?:'s| is)|all)\s+(?:sorted|done|booked|confirmed|changed|moved)\b/i,
  /\bi(?:'ve| have)\s+(?:put|got|booked)\s+you\b/i,
  /\bappointment\s+(?:has been|is now|)\s*(?:moved|changed|rescheduled|booked)/i,
  /\bsee you (?:on|at)\b.*\binstead\b/i,
  // Bare past-tense claims with no subject: "Appointment moved!", "Booking
  // changed", "Moved!". A full stop or exclamation is still a promise.
  /(?:^|[.!?]\s*)(?:appointment|booking|it)?\s*(?:moved|rescheduled|swapped|switched|changed)\b/i,
  /\bchanged\s+(?:it|that|your appointment|the booking)\b/i,
];

/* -------------------------------------------------------------- send claims --
 * Phrases that assert something has been, or is about to be, dispatched to the
 * client: a confirmation, an email, a text, a link, a receipt.
 *
 * WHAT IS DELIBERATELY NOT HERE, because over-blocking is its own failure:
 *
 *   "I'll check my book and come straight back to you" is the sanctioned
 *   holding reply. It promises attention, not a dispatch, and it is the one
 *   sentence the prompts are told to fall back to. It must always pass.
 *
 *   "Ellie will send that over" / "she'll pop it over" is a claim about a
 *   HUMAN, not about the machine. That is a different fact with a different
 *   owner: the draft goes to Ellie, who reads it and knows she has to do it.
 *   lib/grounded-reply.js already owns third-party promises
 *   (promisesAHumanAction), so duplicating them here would ban a legitimate
 *   handover. See the report note: that verb list is missing "send".
 *
 * Idiomatic verbs (pop, ping, text, whizz, fire, chuck) only count when they
 * carry something somewhere. "Pop onto the link" and "I'll pop you in the
 * diary" are ordinary salon English and must not be read as a send.
 */
const SEND_VERB_CORE =
  '(?:re-?)?(?:send|sends|sending|sent|email|emails|emailing|emailed|forward|forwards|forwarding|forwarded)';
const SEND_VERB_IDIOM =
  '(?:pop|popping|ping|pinging|text|texting|whizz|whizzing|fire|firing|shoot|shooting|chuck|chucking)';
// Where the thing is going. Without one of these an idiom verb is not a send.
const SEND_DIRECTION = '(?:over|across|through|out|round|to you|your way)';
// The -ing forms only, for the subjectless "popping that over now" shape.
const SEND_IDIOM_PARTICIPLE =
  '(?:popping|pinging|texting|whizzing|firing|shooting|chucking)';
// First person, present or future. Florrie writes AS the beautician, so "we"
// is her too. No third-person subject on purpose (see the note above).
const I_WILL = "(?:i'll|i will|i'm going to|i am going to|i'm|i am|we'll|we will|we're|we are)";
const I_HAVE = "(?:i've|i have|we've|we have|just|i just|i've just|i have just)";

const SEND_CLAIMS = [
  // "I'll send you a new one now", "I'll email that across", "I'm sending it
  // over", "we'll resend it". THE 26 AUGUST SENTENCE.
  new RegExp(`\\b${I_WILL}\\s+(?:just\\s+|now\\s+|quickly\\s+|get\\s+)?${SEND_VERB_CORE}\\b`, 'i'),
  new RegExp(`\\b${I_WILL}\\s+(?:just\\s+|now\\s+|quickly\\s+)?${SEND_VERB_IDIOM}\\s+(?:\\w+\\s+){0,3}?${SEND_DIRECTION}\\b`, 'i'),

  // Already gone: "just sent you a new one", "I've resent it", "I have
  // emailed it over".
  new RegExp(`\\b${I_HAVE}\\s+(?:just\\s+)?(?:re-?)?(?:sent|emailed|forwarded|texted|popped|pinged)\\b`, 'i'),

  // Bare participle, no subject: "sending it over now", "popping that over",
  // "emailing it across". The existing list already bothers with the bare
  // forms ("Appointment moved!") because a model writes them constantly.
  /(?:^|[.!?,]\s*|\band\s+|\bso\s+)(?:just\s+|now\s+)?(?:re-?)?(?:sending|emailing|forwarding)\b/i,
  new RegExp(`(?:^|[.!?,]\\s*|\\band\\s+|\\bso\\s+)(?:just\\s+|now\\s+)?${SEND_IDIOM_PARTICIPLE}\\s+(?:\\w+\\s+){0,3}?${SEND_DIRECTION}\\b`, 'i'),

  // Bare past tense with no subject: "Sent!", "Resent it", "All sent".
  /(?:^|[.!?]\s*)(?:all\s+)?(?:re-?)?sent\b/i,
  // Bare subject forms: "Confirmation sent", "the email has been resent",
  // "your link is on the way".
  /\b(?:confirmation|email|e-?mail|text|link|receipt|invoice|reminder|it|that|one)\s+(?:has been|have been|is|was|been)?\s*(?:re-?)?sent\b/i,

  // The delivery promise with no verb of sending in it at all, which is the
  // half of the 26 August reply that would have survived on its own:
  // "should come through in a min xx".
  //
  // A SUBJECT OR A MODAL IS REQUIRED, and that is the 27 August correction to
  // this line. It used to be a bare /\bcomes?\s+through\b/, which also matched
  // "Come through when you get here", the sentence Ellie herself sent to a
  // client on her doorstep at 11:33 that morning. That is not an email
  // arriving, it is an instruction to a person, and once the salon has written
  // an arrival note it is the owner's own words and hers to send. It belongs to
  // ARRIVAL_FACETS below, which evidences it against the note. Everything that
  // genuinely reads as delivery still has something in front of it.
  /\bcomes\s+through\b/i,
  /\b(?:should|shall|will|would|may|might|must|to|it|that|this|they|one|email|e-?mail|text|link|receipt|invoice|reminder|reminders|confirmation|confirmations)(?:'?ll)?\s+(?:just\s+|all\s+|still\s+|soon\s+)?come\s+through\b/i,
  /\bcoming\s+through\b/i,
  /\bon\s+(?:its|it's|the)\s+way\b/i,
  /\bin\s+your\s+inbox\b/i,
  /\b(?:should|will|shall)\s+be\s+with\s+you\s+(?:shortly|in\b|any\b)/i,
  /\b(?:arrive|arrives|arriving|land|lands|landing)\s+(?:shortly|in\s+a\b|in\s+your\b|any\s+(?:minute|second|moment))/i,
];

/* ------------------------------------------------- the doorstep, 27 August --
 * 27 August 2026, 11:32, to a client who was standing outside the door.
 *
 *   11:32  in   client  "Im 60 seconds away!"
 *   11:32  out  ai      "Oh I'm ready! I'll come get you xx"
 *   11:33  out  human   "Come through when you're here! It's a bit hecgiv"
 *   11:33  out  human   "Hectic with the festival staff**"
 *
 * escalated: false. Nothing held it. One minute later Ellie had to contradict
 * her own assistant to a client already on the step.
 *
 * READ ELLIE'S LINE AGAIN, because it is the whole design. "Come through when
 * you're here" is a correct answer to a doorstep message, said by the person
 * who owns the fact, and it is sayable in nine words. So speaking was not the
 * mistake. Speaking FROM NOTHING was. Florrie said she was ready, when only the
 * person in the room knows that and the person in the room was dealing with
 * festival staff. And she said she would come and get her, which is a physical
 * act performed by a body in a building, promised by software running
 * somewhere else, and immediately contradicted.
 *
 * A first pass at this banned the whole category: never answer a message about
 * the physical present moment. That leaves a client standing outside in silence
 * until the owner picks up her phone, which is a worse product than the bug.
 *
 * So the category splits in two, and the split is the same one this file has
 * made four times already: what can be evidenced, and what cannot.
 *
 *   PRESENCE_CLAIMS   refused always, no flag, because no note anybody can
 *                     write makes software able to do these.
 *   ARRIVAL_FACETS    refused only when the salon's own arrival note does not
 *                     cover them. Ellie writes "Come through when you get here,
 *                     no need to knock" once, and Florrie may then say it.
 */

// Getting a body to a person, and the person being fetched.
const MOTION_VERB = '(?:come|comes|coming|comin|nip|nipping|pop|popping|head|heading|run|running|dash|dashing)';
const FETCH_VERB = '(?:get|grab|collect|fetch|meet|greet)';
// "get you booked in" and "get you sorted" are ordinary salon English about
// admin, not about walking to a door, so the fetch only counts when nothing
// like that follows.
const NOT_A_FETCH = '(?!\\s+(?:sorted|booked|in\\b|down\\b|scheduled|penciled|pencilled|fixed|set\\s+up|started))';

// First person, present or future. Florrie writes AS the beautician, so "we"
// is her too. No third person subject on purpose (see the note below).
const ME = "(?:i'?ll|i will|i'?m going to|i am going to|i'?m|im|i am|we'?ll|we will|we'?re|we are)";

/* ---------------------------------------------------------- presence claims --
 * NEVER TRUE, AND UNLIKE EVERY OTHER LIST IN THIS FILE THERE IS NO EVIDENCE
 * FLAG. actionPerformed and sendPerformed exist because a booking write and a
 * message dispatch are things this software can really do, so those sentences
 * can become true. arrivalNote exists because the owner really can have written
 * down where to park. There is nothing anybody can write that makes Florrie
 * able to walk to a door, look at a room, or know she is ready.
 *
 * Both halves of the 27 August reply are in here, so the note cannot rescue it:
 * a salon whose arrival note says "come through" still may not be told "I'm
 * ready! I'll come get you", because that is a different claim about a
 * different fact and the note does not hold it.
 *
 * WHAT IS DELIBERATELY LET THROUGH, because over-blocking is its own failure:
 *
 *   "I'll check my book and come straight back to you" is the sanctioned
 *   holding reply and it contains the word "come". Every pattern below that
 *   involves coming requires a person as the thing being fetched ("come get
 *   YOU"), so the holding reply passes. There is a test that says so.
 *
 *   "Ellie will come and get you", "she's just finishing up" and anything else
 *   in the THIRD person is not here. Reporting what the owner said or will do
 *   is a different fact with a different owner, the draft goes to her, and she
 *   reads it knowing she has to do it. lib/grounded-reply.js owns third party
 *   promises (promisesAHumanAction) and its verb list was widened for this
 *   incident instead. Duplicating it here would ban a legitimate handover.
 *
 *   "I'm here to help" / "I'm here if you need anything" is a figure of
 *   speech, not a location, and is excluded by lookahead.
 */
const PRESENCE_CLAIMS = [
  // "I'll come get you", "I'll come and get you", "I'm coming down to grab
  // you", "I'll just nip out and meet you". HALF OF THE 27 AUGUST SENTENCE.
  new RegExp(`\\b${ME}\\s+(?:just\\s+|quickly\\s+|now\\s+)?(?:be\\s+)?${MOTION_VERB}(?:\\s+\\w+){0,2}?\\s+${FETCH_VERB}\\s+(?:you|ya|u)\\b${NOT_A_FETCH}`, 'i'),
  // Bare participle at the start of a sentence: "Coming to get you now!".
  // Anchored, so "she is coming to get you" is left to grounded-reply.js.
  new RegExp(`(?:^|[.!?]\\s*)(?:just\\s+)?(?:coming|comin|popping|nipping|heading|running)\\s+(?:\\w+\\s+){0,2}?${FETCH_VERB}\\s+(?:you|ya|u)\\b${NOT_A_FETCH}`, 'i'),

  // On the way. "I'm on my way", "I'm coming out", "I'm just coming".
  new RegExp(`\\b${ME}\\s+(?:just\\s+|now\\s+)?(?:on\\s+(?:my|our|the)\\s+way|coming\\s+(?:out|down|now|round|over|through|up)|coming\\b)`, 'i'),
  // "I'll be right out", "I'll be with you in a moment", "I'll be there".
  // "out of" excluded: "I'm out of that shade" is stock, not a doorway.
  new RegExp(`\\b${ME}\\s+(?:just\\s+)?(?:be\\s+)?(?:right\\s+|straight\\s+|just\\s+)?(?:out(?!\\s+of\\b)|there|with\\s+you)\\b`, 'i'),
  new RegExp(`\\b${ME}\\s+be\\s+(?:right\\s+|straight\\s+)?(?:down|over|through|round|up)\\b`, 'i'),

  // Readiness. Only the person in the room knows this, and on 27 August she
  // was not ready. THE OTHER HALF OF THE 27 AUGUST SENTENCE. "ready to" is
  // excluded: "ready to get you booked in" is about admin, not about a door.
  new RegExp(`\\b${ME}\\s+(?:all\\s+|just\\s+|nearly\\s+|almost\\s+|not\\s+quite\\s+|not\\s+)?(?:about\\s+)?ready\\b(?!\\s+to\\b)`, 'i'),
  /(?:^|[.!?]\s*)(?:all\s+)?ready\s+(?:for\s+you|when\s+you)\b/i,

  // Still with someone, nearly done. Same problem: she cannot see the room.
  /\b(?:just\s+)?(?:finishing|wrapping)\s+(?:up|off|with\b|my\b|this\b)/i,
  new RegExp(`\\b${ME}\\s+(?:just\\s+|currently\\s+)?(?:with|in\\s+with)\\s+(?:a|another|my|the)\\s+(?:client|customer|lady|girl)\\b`, 'i'),

  // Working a door. She has no hands. Note that the DOOR'S STATE is a fact the
  // owner can write down and lives in ARRIVAL_FACETS below; this is the act of
  // operating it, which she cannot do however well documented the door is.
  /\b(?:let|letting|buzz|buzzing|wave|waving)\s+you\s+(?:in|through|up)\b/i,
  new RegExp(`\\b${ME}\\s+(?:come\\s+(?:and\\s+)?)?(?:open|unlock|prop|answer)\\s+(?:the\\s+)?door\\b`, 'i'),

  // Seeing them. Software has no eyes on the street.
  /\bi\s+can(?:'?t|not)?\s+see\s+you\b(?!\s*'|\s+(?:have|had|are|were|being|being))/i,
  new RegExp(`\\b${ME}\\s+(?:just\\s+|right\\s+)?(?:here(?!\\s+(?:to|if|for|all|whenever|any))|outside|out\\s+the\\s+front|out\\s+front|at\\s+the\\s+door|in\\s+the\\s+(?:salon|studio|shop|room)|downstairs|upstairs)\\b`, 'i'),

  // The kettle. There is no kettle. Any sentence about one from software is a
  // claim to be standing in a room with a kettle in it.
  /\bkettle\b/i,
];

/* ----------------------------------------------------------- arrival facets --
 * TRUE IF SHE WROTE IT DOWN. These are the sentences Ellie herself sent at
 * 11:33, and a salon that has written an arrival note is entitled to have
 * Florrie say them in one second instead of five minutes.
 *
 * GATED BY FACET, NOT BY PHRASE, and that is the load bearing decision here.
 * The obvious implementation is to check Florrie's wording against the note's
 * wording, and it is too brittle to ship: "come on up" and "head up" mean the
 * same thing to a person on a step, and Ellie will only ever have written one
 * of them. Worse, the failure is silent and one-sided, so the salon that took
 * the trouble to write a note is the one whose client gets nothing.
 *
 * So each facet is a small pair of pattern lists: what Florrie is CLAIMING, and
 * what the note has to SAY for that claim to be hers. Florrie may make a claim
 * in facet F only if the note also matches facet F. The facets are independent,
 * which is the point:
 *
 *   note "Parking is on Mill Street"       -> may answer about parking
 *                                          -> still refused "come through"
 *   note "Come through when you get here"  -> may say come through
 *                                          -> still refused "it's on the latch"
 *
 * FIVE FACETS, NOT ONE. Every one of these is a separate fact about a separate
 * physical thing, and any coarser grouping licenses a sentence the owner never
 * wrote. "Which buzzer" is deliberately its own facet rather than part of
 * entry, because "come through when you get here" says nothing whatsoever about
 * there being a buzzer, let alone which one.
 *
 * The claim patterns are kept tight on purpose. This guard runs on EVERY reply
 * that leaves the building, not just doorstep ones (routes/escalations.js,
 * routes/outbound.js, services/conversational-booking.js), so a loose pattern
 * here refuses ordinary salon English on a message that had nothing to do with
 * a door. Where they had to choose, they choose to miss rather than to over
 * block: PRESENCE_CLAIMS above is the fence that has to be tight.
 */

// Where a clause can start, which is where an imperative lives. Anchored, so
// the delivery sense of "it should come through in a min" (an email, owned by
// SEND_CLAIMS above and evidenced there) is untouched by the entry patterns.
const CLAUSE_OPEN = '(?:^|[.!?]\\s*|,\\s*|\\bso\\s+|\\band\\s+|\\bthen\\s+)(?:please\\s+|just\\s+|do\\s+)?';

const ARRIVAL_FACETS = [
  {
    facet: 'entry',
    what: 'how to get in',
    // "Come through", "come on up", "head straight through", "walk right in".
    claims: [
      new RegExp(`${CLAUSE_OPEN}come\\s+(?:on\\s+|right\\s+|straight\\s+)?(?:through|in\\b|inside|up\\b|round\\b|on\\s+up)\\b`, 'i'),
      // "pop", "head" and "walk" get THROUGH for free and everything else only
      // with an adverb. "Pop in and we will get you sorted" and "walk in
      // appointments" are ordinary salon English about visiting at some point;
      // "pop through" and "walk straight in" are only ever said to somebody
      // already on the step. There is a test for the difference.
      new RegExp(`${CLAUSE_OPEN}(?:pop|head|walk|make\\s+your\\s+way)\\s+(?:on\\s+|right\\s+|straight\\s+)?through\\b`, 'i'),
      new RegExp(`${CLAUSE_OPEN}(?:pop|head|walk|make\\s+your\\s+way)\\s+(?:right\\s+|straight\\s+)(?:in\\b|inside|up\\b)`, 'i'),
      /\b(?:let|show)\s+yourself\s+in\b/i,
      /\bno\s+need\s+to\s+(?:knock|buzz|ring|wait)\b/i,
    ],
    // Her own instruction, in any of the ways she might have phrased it.
    note: [
      /\b(?:come|pop|head|walk|make\s+your\s+way)\s+(?:on\s+|right\s+|straight\s+)?(?:through|in\b|inside|up\b|round\b|on\s+up)\b/i,
      /\b(?:let|show)\s+yourself\s+in\b/i,
      /\bstraight\s+(?:in|through|up)\b/i,
      /\bno\s+need\s+to\s+(?:knock|buzz|ring)\b/i,
      /\bdon'?t\s+(?:knock|buzz|ring)\b/i,
    ],
  },
  {
    facet: 'door_state',
    what: 'whether the door is open',
    claims: [
      /\bdoor(?:'?s)?\s*(?:is|will\s+be|should\s+be|s)?\s*(?:open|unlocked|on\s+the\s+latch)\b/i,
      // "it's open" is left out on purpose: it is far more often about opening
      // hours ("are you open Saturday?" / "yes it's open till five") than about
      // a door, and refusing that would be this guard leaking into a question
      // it has nothing to do with. "unlocked" and "latch" are door words only.
      /\b(?:it'?s|its)\s+(?:unlocked|on\s+the\s+latch)\b/i,
      /\bon\s+the\s+latch\b/i,
    ],
    note: [
      /\bdoor\b[^.!?]*\b(?:open|unlocked|latch|push)\b/i,
      /\b(?:open|unlocked|on\s+the\s+latch)\b[^.!?]*\bdoor\b/i,
      /\bon\s+the\s+latch\b/i,
    ],
  },
  {
    facet: 'parking',
    what: 'where to park',
    claims: [
      /\bpark(?:ing)?\s+(?:is\s+|it\s+)?(?:on|in|at|outside|opposite|behind|round\s+the\s+back|out\s+(?:the\s+)?(?:front|back)|anywhere|free)\b/i,
      /\b(?:you\s+can|feel\s+free\s+to|happy\s+for\s+you\s+to)\s+park\b/i,
      /\bcar\s?park\b/i,
      // Qualified, because the bare verb is a different word: "we do not permit
      // refunds after 48 hours" is a policy sentence, not a parking one.
      /\b(?:parking|resident'?s?|visitor'?s?)\s+permit\b/i,
    ],
    note: [/\bpark(?:ing|ed)?\b/i, /\bcar\s?park\b/i, /\bpermit\b/i],
  },
  {
    facet: 'waiting',
    what: 'where to wait',
    claims: [
      /\b(?:take|have|grab)\s+a\s+(?:seat|pew)\b/i,
      /\bwait\s+(?:in|at|by|out|on)\s+(?:the\s+)?(?:reception|waiting\s+(?:area|room)|hall(?:way)?|lobby|front|car|sofa|chairs?)\b/i,
      /\bmake\s+yourself\s+(?:comfortable|at\s+home)\b/i,
      /\bhelp\s+yourself\s+to\b/i,
    ],
    note: [
      /\bwait(?:ing)?\b/i,
      /\b(?:seat|pew|sofa|reception|lobby|waiting\s+(?:area|room))\b/i,
      /\bmake\s+yourself\s+(?:comfortable|at\s+home)\b/i,
      /\bhelp\s+yourself\b/i,
    ],
  },
  {
    facet: 'directions',
    what: 'which door, buzzer or floor it is',
    claims: [
      /\b(?:buzzer|intercom|door\s?bell)\b/i,
      /\b(?:ring|press|push)\s+(?:the\s+)?(?:bell|buzzer|number|flat)\b/i,
      /\b(?:first|second|third|ground|top|upper|lower)\s+floor\b/i,
      /\b(?:flat|unit|studio|suite)\s+(?:number\s+)?\d+/i,
      /\b(?:blue|red|green|black|white|side|back|rear|left|right|middle|glass)\s+door\b/i,
      /\bdoor\s+(?:on\s+the\s+)?(?:left|right)\b/i,
    ],
    note: [
      /\b(?:buzzer|intercom|door\s?bell|bell)\b/i,
      /\b(?:first|second|third|ground|top|upper|lower)\s+floor\b/i,
      /\b(?:flat|unit|studio|suite)\s+(?:number\s+)?\d+/i,
      /\b(?:blue|red|green|black|white|side|back|rear|left|right|middle|glass)\s+door\b/i,
      /\bdoor\s+(?:on\s+the\s+)?(?:left|right)\b/i,
      /\bupstairs\b|\bdownstairs\b/i,
    ],
  },
];

/**
 * Normalise a time so "4.30", "4:30" and "16:30" compare equal.
 * Returns null for anything that is not a real time of day, so junk can never
 * accidentally match an allowed slot.
 */
const WORD_HOURS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function normaliseTime(raw) {
  const spoken = String(raw).toLowerCase().trim()
    .match(/^(half|quarter past|quarter to)\s+(\w+)$/);
  if (spoken) {
    const base = WORD_HOURS[spoken[2]];
    if (!base) return null;
    // Salon hours, so "half four" is the afternoon. "half four" = 16:30,
    // "quarter to five" = 16:45 (the hour BEFORE the one named).
    const pm = base < 8 ? base + 12 : base;
    if (spoken[1] === 'half') return `${String(pm).padStart(2, '0')}:30`;
    if (spoken[1] === 'quarter past') return `${String(pm).padStart(2, '0')}:15`;
    return `${String(pm - 1).padStart(2, '0')}:45`;
  }

  const text = String(raw).toLowerCase().replace(/\s+/g, '');
  const withMinutes = text.match(/^(\d{1,2})[.:](\d{2})(am|pm)?$/);
  const hourOnly = text.match(/^(\d{1,2})(am|pm)$/);

  let hour;
  let minute;
  let suffix;

  if (withMinutes) {
    [, hour, minute, suffix] = withMinutes;
  } else if (hourOnly) {
    [, hour, suffix] = hourOnly;
    minute = '00';
  } else {
    return null;
  }

  hour = parseInt(hour, 10);
  minute = parseInt(minute, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute > 59) return null;

  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;

  // Without am/pm, a salon time under 8 is an afternoon appointment: "4.30"
  // means half four, never half four in the morning. This is why the allow-list
  // must hold 24h strings, so the comparison is unambiguous.
  if (!suffix && hour < 8) hour += 12;

  if (hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Every time-like token in a piece of text, normalised. Junk tokens dropped. */
export function timesMentionedIn(text) {
  const body = String(text || '');
  const found = new Set();

  for (const pattern of DIGIT_TIME_TOKENS) {
    for (const match of body.matchAll(pattern)) {
      if (looksLikeMoneyOrDuration(body, match.index, match[0])) continue;
      const normalised = normaliseTime(match[0]);
      // A digit token that will not parse as a clock time (35:50, 90:00) is
      // not a time at all, so it is dropped rather than counted against her.
      if (normalised) found.add(normalised);
    }
  }

  for (const pattern of SPOKEN_TIME_TOKENS) {
    for (const match of body.matchAll(pattern)) {
      const normalised = normaliseTime(match[0]);
      // A SPOKEN token that will not parse genuinely is an unverifiable time,
      // so it must count. Dropping these is how "half four Thursday" got out.
      found.add(normalised || `unparsed:${match[0].trim().toLowerCase()}`);
    }
  }

  return Array.from(found);
}

/**
 * @param {string} text            the draft about to go to a client
 * @param {object} opts
 * @param {string[]} opts.allowedTimes  free slots VERIFIED against the diary,
 *                                      as 24h "HH:MM". Empty means the reply
 *                                      may not name any time at all.
 * @param {boolean} opts.actionPerformed  true only if a booking really was
 *                                      written in this same request.
 * @param {boolean} opts.sendPerformed   true only if something really was SENT
 *                                      to this client in this same request,
 *                                      and the send reported success.
 * @param {string} opts.arrivalNote      the salon's own written words about
 *                                      arriving, from the Knowledge page.
 *                                      Evidence for ARRIVAL_FACETS, and read
 *                                      facet by facet: a note about parking
 *                                      does not license "come through".
 *                                      Callers pass everything she has written
 *                                      that could back one of these facets, not
 *                                      only the 'arrival' entry: a parking FAQ
 *                                      she wrote in March is her word too, and
 *                                      narrowing this to one category refuses
 *                                      "free parking on Mill Road" on an
 *                                      ordinary question about parking. See
 *                                      writtenNotesFrom in lib/knowledge.js.
 * @returns {{ok: boolean, reason?: string, offending?: string[], facet?: string}}
 */
/*
 * WHY THREE FLAGS AND NOT ONE.
 *
 * They are different facts about different machinery, and a single flag would
 * launder one into the other. A request that genuinely resent a confirmation
 * would set the one flag, and the same reply could then say "you're all moved
 * to Thursday" and pass -- which is the 28 July incident, waved through by the
 * fix for the 26 August one. A booking write, a message dispatch and a written
 * arrival note have to be evidenced separately because they are evidenced by
 * separate code, and the note goes further still: it is evidenced facet by
 * facet within itself, because one sentence about parking is not permission to
 * talk about a door.
 */
export function checkReplyClaims(text, { allowedTimes = [], actionPerformed = false, sendPerformed = false, arrivalNote = '' } = {}) {
  const body = String(text || '');

  // FIRST, and with no flag that can switch it off. Florrie is not in the
  // building. Everything below this can in principle become true and is
  // therefore gated on evidence; this cannot, so it is gated on nothing. Both
  // halves of the 27 August reply are refused here, so a salon that HAS written
  // an arrival note still never gets "I'm ready! I'll come get you".
  for (const pattern of PRESENCE_CLAIMS) {
    const hit = body.match(pattern);
    if (hit) {
      return {
        ok: false,
        reason: 'claimed to be present or to do something physical',
        offending: [hit[0].trim()],
      };
    }
  }

  // Then the things Ellie's own note CAN make true. Kept here, above the time
  // and action checks, so the doorstep verdicts stay together and read in the
  // order the 27 August reply fails them.
  const note = String(arrivalNote || '');
  for (const { facet, what, claims, note: noteSays } of ARRIVAL_FACETS) {
    let hit = null;
    for (const pattern of claims) {
      hit = body.match(pattern);
      if (hit) break;
    }
    if (!hit) continue;
    if (note && noteSays.some(p => p.test(note))) continue;
    return {
      ok: false,
      // Names the facet, so the log explains itself rather than sending
      // whoever reads it looking for a note that would not have helped.
      reason: `said ${what}, and the salon's arrival note does not cover ${facet}`,
      offending: [hit[0].trim()],
      facet,
    };
  }

  const allowed = new Set(
    allowedTimes.map(normaliseTime).filter(Boolean),
  );
  const unverified = timesMentionedIn(body).filter(t => !allowed.has(t));
  if (unverified.length) {
    return {
      ok: false,
      reason: 'named a time that was not verified against the diary',
      offending: unverified,
    };
  }

  if (!actionPerformed) {
    for (const pattern of ACTION_CLAIMS) {
      const hit = body.match(pattern);
      if (hit) {
        return {
          ok: false,
          reason: 'claimed a booking change that never happened',
          offending: [hit[0]],
        };
      }
    }
  }

  // A promise to send is allowed the moment it is TRUE. The point of giving
  // Florrie the capability (services/ai-front-desk.js, resendConfirmation) is
  // that this sentence stops being a lie, so the gate is evidence of a real
  // send in this same request, never a ban on the words.
  if (!sendPerformed) {
    for (const pattern of SEND_CLAIMS) {
      const hit = body.match(pattern);
      if (hit) {
        return {
          ok: false,
          reason: 'claimed something was sent when nothing was sent',
          offending: [hit[0].trim()],
        };
      }
    }
  }

  return { ok: true };
}

// Always true, always sendable, and the thing the prompts were meant to fall
// back to unprompted. Ellie picks it up from her inbox either way.
export const HOLDING_REPLY = 'Let me check my book and come straight back to you.';

/**
 * The wrapper to use at every point a generated reply leaves the building.
 * Returns safe text, plus what was rejected so it can be logged and counted.
 */
export function safeReply(text, opts = {}) {
  const verdict = checkReplyClaims(text, opts);
  if (verdict.ok) return { text, rejected: false };
  return { text: HOLDING_REPLY, rejected: true, ...verdict };
}
