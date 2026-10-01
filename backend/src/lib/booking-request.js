import { appointmentChangeIntent } from './appointment-message-scenario.js';
import { isBookingProblem } from './booking-problem.js';

const normalise = value => String(value || '').replace(/[’‘]/g, "'").toLowerCase().trim();

export function declinesBookingNow(message) {
  return /\b(?:don't|dont|do not|not ready to|not looking to|not trying to|no need to)\s+(?:\w+\s+){0,5}(?:book|rebook)\b/.test(normalise(message));
}

/** Evidence of a request to the salon, rather than a booking topic/keyword. */
export function hasExplicitBookingRequest(message) {
  const text = normalise(message);
  if (declinesBookingNow(text)) return false;
  return [
    /^(?:(?:hi|hiya|hey|hello)[,!\s]+)?(?:book|rebook)\b/,
    /\b(?:can|could|may)\s+i\s+(?:please\s+)?(?:book|rebook|get booked|come in)\b/,
    /\b(?:can|could|may)\s+i\s+(?:please\s+)?(?:get|have)\s+(?:an?\s+)?(?:appointment|slot|booking)\b/,
    /\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:book|rebook|fit|squeeze|pencil|get)\s+(?:me|us)\b/,
    /\b(?:please\s+)?(?:book|rebook|fit|squeeze|pencil)\s+(?:me|us)\b/,
    /\bplease\s+(?:book|rebook)\b/,
    /\b(?:i(?:'d| would) like|i want|i need|i was hoping|i'm hoping|im hoping)\s+to\s+(?:book|rebook|get booked)\b/,
    /\bi\s+(?:need|want|would like|'d like)\s+(?:an?\s+)?(?:appointment|booking|slot)\b/,
    /\b(?:let'?s|can we|could we)\s+(?:please\s+)?(?:book|rebook)\b/,
    /\b(?:are you|are there|do you have|have you got)\s+(?:(?:any|anything|still)\s+)?(?:free|available|availability|appointments?|slots?|spaces?|openings?)\b/,
    /\b(?:any|what)\s+(?:availability|appointments?|slots?|spaces?|openings?)\b/,
    /\bwhen\s+(?:are you|can i|could i)\s+(?:free|available|come in|book)\b/,
    /\bany chance\s+(?:you\s+(?:can|could)\s+)?(?:of\s+(?:an?\s+)?(?:appointment|slot|booking)|(?:fitting|squeezing|fit|squeeze|booking|book)\s+me)\b/,
  ].some(pattern => pattern.test(text));
}

/** A future plan/watch update does not request a reply or choose an offer. */
export function isPassiveBookingInterest(message) {
  const text = normalise(message);
  if (!text || hasExplicitBookingRequest(text) || appointmentChangeIntent(text) || isBookingProblem(text)) return false;
  // Mixed messages with a question, problem or request need normal review.
  if (/[?]|\b(?:when|where|why|how|which|please|help|unsure|not sure|wondering|speak|talk|human|person|nervous|worried|scared|anxious|cancel|reschedule|refund|charged|payment|deposit|confirmation|verification|email|code|reply|response|receipt|reaction|redness|swelling|pain|error|failed|broken|not working)\b/.test(text)) return false;
  if (/\b(?:can|could|would|will)\s+you\b|\b(?:is|are|does|do)\s+(?:it|that|this|there|your|the|you)\b|\blet me know\b/.test(text)) return false;
  const waitingForDates = /\b(?:book(?:ing)?|appointments?|slots?|dates?|diary|calendar|january|february|march|april|may|june|july|august|september|october|november|december|christmas|xmas|new year|\d{1,2}(?:st|nd|rd|th))\b/.test(text);
  return [
    /\b(?:keep(?:ing)?|i'?ll keep|will keep)\s+(?:an?\s+)?eye\s+(?:out|on)\b/,
    /\b(?:i'?ll|i will|i'm going to|im going to|i plan to)\s+(?:book|rebook)\b/,
    /\bwhat\s+i(?:'m| am|m)\s+(?:booking|going to book|planning to book)\b/,
    /\b(?:looking forward to|can'?t wait for)\s+(?:booking|the dates|your dates|december|christmas|xmas)\b/,
  ].some(pattern => pattern.test(text)) || (waitingForDates && /\b(?:watching|looking out)\s+(?:for|until|to see)\b/.test(text));
}
