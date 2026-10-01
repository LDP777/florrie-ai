import { hasNamedTreatmentDetail, looksLikeABookingOpening, matchTreatments } from './booking-rules.js';
import { hasExplicitBookingRequest, isPassiveBookingInterest, declinesBookingNow } from './booking-request.js';
import { clientQuestionScenario } from './client-question.js';
import { appointmentChangeIntent } from './appointment-message-scenario.js';
import { asksForHuman } from './grounded-reply.js';
import { needsAPerson } from './needs-a-person.js';

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const normalise = value => String(value || '').replace(/[’‘]/g, "'").trim();
const TREATMENT_QUESTION = /\b(?:(?:which|what)\s+treatments?\b|what\s+would\s+you\s+like\b|did\s+you\s+mean\b|just\s+so\s+i\s+book\s+the\s+right\s+thing\b)/i;

function needsOtherHandling(message, ownerName) {
  return declinesBookingNow(message) || isPassiveBookingInterest(message)
    || asksForHuman(message, ownerName) || needsAPerson(message).yes
    || appointmentChangeIntent(message) || clientQuestionScenario(message);
}

/** A menu choice after a question, not praise, a symptom or a policy question. */
export function isTreatmentAnswer(message, treatments) {
  const text = normalise(message);
  if (!text || text.length > 240 || needsOtherHandling(text)
    || /\b(?:when|where|why|how|what|which|safe|suitable|recommend|allerg\w*|reaction|rash|pain|redness|swelling|pregnan\w*|had|was|were|last|loved|love|liked|thank\w*|already|booked|not|don't|can't|won't|instead|refund|receipt|charged|payment|deposit|confirmation|verification|email|code)\b/i.test(text)) return false;
  const choice = text.replace(/\bif\s+(?:possible|that'?s\s+(?:okay|ok)|that\s+is\s+(?:okay|ok))\b/gi, '').trim();
  const match = matchTreatments(choice, treatments);
  return hasNamedTreatmentDetail(choice, treatments)
    && !!(match.treatment || match.ambiguous) && looksLikeABookingOpening(choice, treatments);
}

/**
 * Recover a treatment question actually sent by Florrie before older code saved
 * booking state. The evidence permits another booking step, never a reservation.
 * All rows are supplied by the tenant/client-scoped conversation read.
 */
export function treatmentBookingContinuation({ message, messageId, channel, conversation = [], treatments = [], ownerName, now = Date.now() }) {
  if (!channel || !isTreatmentAnswer(message, treatments) || needsOtherHandling(message, ownerName)) return null;
  let rows = conversation.slice();
  const currentIndex = messageId ? rows.findIndex(row => row.id === messageId) : -1;
  if (messageId && currentIndex < 0) return null;
  const current = currentIndex >= 0 ? rows[currentIndex] : null;
  if (current && (current.direction !== 'inbound' || current.channel !== channel
    || normalise(current.content) !== normalise(message))) return null;
  const currentAt = current ? Date.parse(current.created_at || '') : Number(now);
  if (!Number.isFinite(currentAt) || currentAt > Number(now)) return null;
  if (currentIndex >= 0) rows = rows.slice(0, currentIndex);
  else if (rows.at(-1)?.direction === 'inbound' && normalise(rows.at(-1)?.content) === normalise(message)) rows.pop();
  const recent = row => {
    const at = Date.parse(row?.created_at || '');
    return row?.channel === channel && Number.isFinite(at) && at <= Number(now) && Number(now) - at <= MAX_AGE_MS;
  };
  // Require alternating questions and answers; an unrelated turn ends recovery.
  let questionId = null;
  let nextAnswerAt = currentAt;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 6); i -= 2) {
    const question = rows[i];
    const request = rows[i - 1];
    if (!recent(question) || !recent(request)
      || question.direction !== 'outbound' || question.authored_by !== 'ai'
      || question.ai_handled !== true || question.digital_employee !== 'front_desk'
      || question.escalated === true
      || (question.send_status && !['sent', 'delivered', 'read'].includes(String(question.send_status).toLowerCase()))
      || !TREATMENT_QUESTION.test(question.content || '')
      || request.direction !== 'inbound'
      || Date.parse(question.created_at) > nextAnswerAt
      || Date.parse(request.created_at) > Date.parse(question.created_at)
      || needsOtherHandling(request.content, ownerName)) return null;
    questionId ||= question.id;
    if (hasExplicitBookingRequest(request.content) && looksLikeABookingOpening(request.content, treatments)) {
      return { request: request.content, requestedAt: request.created_at, questionMessageId: questionId };
    }
    if (!isTreatmentAnswer(request.content, treatments)) return null;
    nextAnswerAt = Date.parse(request.created_at);
  }
  return null;
}
