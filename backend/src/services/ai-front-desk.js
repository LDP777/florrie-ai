import Anthropic from '@anthropic-ai/sdk';
import { buildVoiceGuide } from './voice-profile.js';
import { z } from 'zod';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { cleanReply } from '../lib/text.js';
import { safeReply } from '../lib/reply-claims-guard.js';
import { getFreeSlots } from '../lib/free-slots.js';
import { retrieveKnowledge, renderKnowledgeBlock } from '../lib/knowledge.js';
import { createBookingSuggestion } from './automations.js';
import { sendMessage, sendInstagramDM, sendWhatsAppText, sendSMS } from './notifications.js';
import { pushEscalation, pushTeamUpdate } from './push-notifications.js';
import { refreshLiveActivity } from './live-activity.js';
import { isKnownClient, clientAutonomyOverride } from '../lib/outbound-guard.js';
import { getLoyaltyConfig, getClientPoints, loyaltyProximity } from './loyalty.js';
import { getActivePromos, describePromo } from '../lib/promos.js';

/**
 * AI Front Desk — The core agentic service.
 *
 * This is the brain that handles every inbound message. It:
 * 1. Classifies intent (what does the client want?)
 * 2. Gathers context (calendar, client history, price list)
 * 3. Decides: act autonomously or escalate?
 * 4. If confident: generates a response in the beautician's tone, takes action
 * 5. If not confident: escalates to the beautician with a suggested response
 * 6. Logs everything as an AI action for the activity feed
 *
 * The confidence threshold is per-beautician (default 0.90).
 * The tone model learns from corrections over the first 10 messages.
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Intent categories the classifier can detect
const INTENTS = {
  BOOKING_REQUEST: 'booking_request',       // "Can I book in for Friday?"
  PRICE_ENQUIRY: 'price_enquiry',           // "How much is a brow lamination?"
  AVAILABILITY_CHECK: 'availability_check', // "Are you free this week?"
  RESCHEDULE: 'reschedule',                 // "Can I move my appointment to next week?"
  CANCELLATION: 'cancellation',             // "I need to cancel tomorrow"
  GENERAL_QUESTION: 'general_question',     // "Do you do patch tests?"
  GREETING: 'greeting',                     // "Hi!", "Hey"
  REVIEW_THANKS: 'review_thanks',           // "Thanks so much, loved it!"
  COMPLAINT: 'complaint',                   // "I'm not happy with..."
  UNKNOWN: 'unknown'                        // Can't classify
};

// Intents the AI can handle autonomously (at sufficient confidence)
const AUTONOMOUS_INTENTS = [
  INTENTS.BOOKING_REQUEST,
  INTENTS.PRICE_ENQUIRY,
  INTENTS.AVAILABILITY_CHECK,
  INTENTS.RESCHEDULE,
  INTENTS.GREETING,
  INTENTS.REVIEW_THANKS
];

/**
 * Does this message actually leave a question hanging?
 *
 * THE NOISE PROBLEM. Florrie escalates every message from a known client so
 * Ellie can approve the reply. Sound in principle, ruinous in practice: a
 * regular saying "thanks, loved it!" or "see you Tuesday" became a badge point
 * identical to "can I move to Saturday?". 144 escalations across 69 clients,
 * so the badge read 99+ and stopped meaning anything.
 *
 * The mistake was asking "can Florrie write a reply to this?" (she can write a
 * reply to anything) instead of "is a reply OWED?". A message that closes a
 * loop needs no answer from anyone. Florrie should read it, log it, and leave
 * Ellie alone.
 *
 * Conservative on purpose: anything with a question mark, or any intent that
 * could be someone waiting, counts as owed. Staying quiet about a real question
 * is far worse than one unnecessary badge point.
 */
const NO_REPLY_OWED_INTENTS = [
  INTENTS.REVIEW_THANKS,
  INTENTS.GREETING,
];

// Short closers that end a conversation. Deliberately tight: whole-message
// matches only, so "thanks, but can you do Saturday?" is never caught.
// Real sign-offs are usually a STRING of these, not one: "thanks lovely, see
// you then x". So match a run of closing tokens rather than a single one.
// Longest alternatives first, otherwise "see you" consumes "see you then".
const CLOSING_TOKEN = '(?:see you soon|see you then|sounds good|no worries|no problem|thank you|goodbye|see you|will do|got it|understood|perfect|brilliant|amazing|cheers|lovely|thanks|thank|great|night|sure|deal|okay|yeah|yep|cool|fab|thx|bye|xxx|ta|np|ok|yes|ye|xx|kk|no|k|x)';
const CLOSING_PHRASES = new RegExp(`^${CLOSING_TOKEN}(?:[\\s,.!]+${CLOSING_TOKEN})*[\\s.!,]*$`, 'i');

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;

export function replyIsOwed(messageContent, classification) {
  const text = String(messageContent || '').trim();

  // A question mark is the clearest signal someone is waiting. Always owed,
  // whatever the classifier thinks the intent is.
  if (text.includes('?')) return true;

  const intent = classification?.intent;

  // Money, diary and unhappiness are owed even when phrased as a bare
  // acknowledgement, because a one-word "yes" can BE the answer to something
  // Florrie asked ("shall I cancel it?"). These outrank the closing-phrase
  // test deliberately: going quiet on a real cancellation is the one mistake
  // worth being noisy to avoid.
  if ([INTENTS.COMPLAINT, INTENTS.CANCELLATION, INTENTS.RESCHEDULE,
       INTENTS.BOOKING_REQUEST].includes(intent)) return true;

  // Everything below is the noise fix. The classifier readily labels chit-chat
  // as general_question, so the wording gets the final say: "ok" and "thanks
  // lovely, see you then x" close a conversation whatever the intent says.
  if (EMOJI_ONLY.test(text)) return false;
  if (CLOSING_PHRASES.test(text)) return false;

  if ([INTENTS.AVAILABILITY_CHECK, INTENTS.PRICE_ENQUIRY,
       INTENTS.GENERAL_QUESTION].includes(intent)) return true;

  if (NO_REPLY_OWED_INTENTS.includes(intent) && text.length < 120) return false;

  // Unknown intent with real content: she should see it. Better a wasted glance
  // than a client left hanging.
  return true;
}

// Intents that always escalate (human judgment needed)
const ALWAYS_ESCALATE = [
  INTENTS.COMPLAINT,
  INTENTS.UNKNOWN
];

/**
 * Process an inbound message through the AI Front Desk.
 * Called by the webhook handler after storing the raw message.
 */
export async function processInboundMessage(messageId, beautician, client, messageContent) {
  const startTime = Date.now();

  try {
    // 0. PECR opt-out: STOP and friends are honoured instantly, on any channel,
    // before any AI processing. Service messages (confirmations, reminders)
    // still go out; marketing never does again (see lib/marketing-guard.js).
    if (/^\s*(stop|unsubscribe|opt\s?-?out)\s*[.!]*\s*$/i.test(String(messageContent || ''))) {
      await supabase.from('clients').update({
        marketing_consent: false,
        marketing_opted_out_at: new Date().toISOString(),
      }).eq('id', client.id);
      const confirmation = "No problem, you won't get any more promotional messages from us. Booking confirmations and reminders still come through. Reply here anytime to book.";
      const sent = await sendResponse(beautician, client, confirmation, { intent: 'marketing_opt_out', confidence: 1.0 }, messageId);
      try {
        await supabase.from('ai_actions').insert({
          beautician_id: beautician.id,
          client_id: client?.id || null,
          action_type: 'marketing_opt_out',
          digital_employee: 'front_desk',
          summary: `${client?.first_name || 'A client'} opted out of marketing messages, I've stopped offers and nudges to them`,
          confidence: 1.0,
          autonomous: true,
          outcome: 'success',
          notification_sent: false,
        });
      } catch (logErr) {
        logger.warn({ err: logErr }, 'opt-out ai_action insert failed');
      }
      return { handled: sent, drafted: !sent, intent: 'marketing_opt_out', response: confirmation };
    }

    // 1. Gather context
    const context = await gatherContext(beautician, client, messageContent);

    // 2. Classify intent
    const classification = await classifyIntent(messageContent, context);

    // 3. Decide: act or escalate?
    let shouldAct = canActAutonomously(classification, beautician.confidence_threshold);

    // Per-client driver setting comes FIRST. 'just_me' / 'drafts' means she
    // asked Florrie not to speak in this thread: always draft + escalate,
    // never auto-send. 'florrie' is an explicit whitelist that also skips the
    // known-client hold below.
    const autonomyOverride = await clientAutonomyOverride(beautician.id, client?.id, client);
    if (autonomyOverride === 'just_me' || autonomyOverride === 'drafts') {
      shouldAct = false;
    }

    // Clients Ellie already knows are relationships she manages personally. Never
    // auto-reply to them: draft the response and escalate so she gives the yes/no.
    // This is the main guard against a regular getting an out of context message,
    // which is most likely on Instagram where we may be missing the earlier chat.
    // Skipped when she explicitly set this client to 'Florrie handles'.
    if (shouldAct && autonomyOverride !== 'florrie'
        && await isKnownClient(beautician.id, client?.id, client)) {
      shouldAct = false;
    }

    if (shouldAct) {
      // 4a. Generate response and take action
      const result = await generateResponseAndAct(
        messageContent, classification, context, beautician, client
      );

      // 5a. Try to deliver. Returns true ONLY if the message was actually sent.
      // Florrie never silently auto-sends a phantom message; if delivery does not
      // happen the reply is surfaced as a one-tap draft (the "every send is one
      // human tap" thesis), and we never record it as sent.
      const sent = await sendResponse(beautician, client, result.response, classification, messageId);

      // 6a. Update message record honestly based on whether it actually sent.
      await supabase.from('messages').update({
        ai_handled: sent,
        ai_confidence: classification.confidence,
        ai_intent: classification.intent,
        ai_response: result.response,
        tone_match_score: result.toneScore,
        escalated: !sent,
        digital_employee: 'front_desk'
      }).eq('id', messageId);

      // 7a. Only log it as a completed action if it was genuinely delivered.
      if (sent) {
        await logAiAction(beautician.id, client?.id, messageId, classification, result);
      }

      logger.info({ handled: sent, drafted: !sent, intent: classification.intent }, sent ? 'AI Front Desk sent reply' : 'AI Front Desk drafted reply for one-tap send');
      return { handled: sent, drafted: !sent, intent: classification.intent, response: result.response };

    } else if (!replyIsOwed(messageContent, classification)) {
      // 4c. Nothing is owed. She said thanks, or see you Tuesday, or sent a
      // heart. Florrie reads it, records what it was, and stays quiet. No
      // escalation, no badge, no draft for Ellie to approve. This is the single
      // biggest source of the 99+, and the cheapest thing to stop doing.
      await supabase.from('messages').update({
        ai_handled: false,
        ai_confidence: classification.confidence,
        ai_intent: classification.intent,
        escalated: false,
        digital_employee: 'front_desk',
      }).eq('id', messageId);

      logger.info({ intent: classification.intent }, 'AI Front Desk: no reply owed, staying quiet');
      return { handled: false, drafted: false, quiet: true, intent: classification.intent };

    } else {
      // 4b. Escalate — still generate a suggested response
      const suggestion = await generateSuggestedResponse(
        messageContent, classification, context, beautician
      );

      // 5b. Mark as escalated
      await supabase.from('messages').update({
        ai_handled: false,
        ai_confidence: classification.confidence,
        ai_intent: classification.intent,
        ai_response: suggestion,
        escalated: true,
        escalated_reason: getEscalationReason(classification),
        digital_employee: 'front_desk'
      }).eq('id', messageId);

      // 6b. Log escalation
      await supabase.from('ai_actions').insert({
        beautician_id: beautician.id,
        action_type: 'message_escalated',
        digital_employee: 'front_desk',
        summary: `Escalated message from ${client?.first_name || 'unknown'}: "${truncate(messageContent, 50)}"`,
        details: {
          intent: classification.intent,
          confidence: classification.confidence,
          reason: getEscalationReason(classification),
          suggested_response: suggestion
        },
        client_id: client?.id,
        message_id: messageId,
        confidence: classification.confidence,
        autonomous: false,
        outcome: 'escalated',
        notification_sent: true,
        notification_text: `New message from ${client?.first_name || 'someone'} needs your attention`
      });

      // Push notification for escalation — beautician needs to act
      pushEscalation(beautician.id, client?.first_name || 'Someone', messageContent).catch(() => {});
    refreshLiveActivity(beautician.id).catch(() => {});

      logger.info({ handled: false, intent: classification.intent, escalated: true }, 'AI Front Desk escalated message');
      return { handled: false, intent: classification.intent, escalated: true, suggestion };
    }

  } catch (err) {
    logger.error({ err }, 'AI Front Desk error');

    // On any error, escalate
    await supabase.from('messages').update({
      escalated: true,
      escalated_reason: `Processing error: ${err.message}`
    }).eq('id', messageId);

    return { handled: false, error: err.message };
  }
}

// STEP 1: GATHER CONTEXT

async function gatherContext(beautician, client, messageContent = '') {
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Parallel fetches for speed
  const [treatments, upcomingAppointments, clientHistory, clientIntelligence, conversation, loyaltyConfig, clientPoints, patchTests, activePromos, freeSlots, knowledge] = await Promise.all([
    // Treatment menu
    supabase
      .from('treatments')
      .select('id, name, duration_minutes, price_cents, deposit_cents, category, contraindications, requires_patch_test')
      .eq('beautician_id', beautician.id)
      .eq('is_active', true)
      .eq('booking_enabled', true),

    // Next 7 days of appointments
    supabase
      .from('appointments')
      .select('starts_at, ends_at, status, treatments(name)')
      .eq('beautician_id', beautician.id)
      .gte('starts_at', now.toISOString())
      .lte('starts_at', weekFromNow.toISOString())
      .in('status', ['confirmed', 'pending'])
      .order('starts_at'),

    // Client's appointment history (if known)
    client?.id ? supabase
      .from('appointments')
      .select('starts_at, status, treatments(name), price_cents')
      .eq('client_id', client.id)
      .order('starts_at', { ascending: false })
      .limit(5) : { data: [] },

    // Client intelligence (if exists)
    client?.id ? supabase
      .from('client_intelligence')
      .select('*')
      .eq('client_id', client.id)
      .single() : { data: null },

    // Recent conversation thread with this client, so replies continue the chat
    // with context instead of answering the latest line in isolation. This is the
    // main fix for out of context Instagram replies where we only saw one DM.
    client?.id ? supabase
      .from('messages')
      .select('direction, content, channel, created_at')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .limit(12) : { data: [] },

    // Loyalty programme settings (null when the beautician has it off) and
    // this client's running points balance, so replies can nod to reward
    // proximity. Both fail soft so a loyalty hiccup never blanks the brain.
    getLoyaltyConfig(beautician.id),
    client?.id ? getClientPoints(beautician.id, client.id) : 0,

    // Patch test history so Florrie can sell the patch-test visit instead of
    // stalling when a new or lapsed client asks for a treatment that needs one.
    // Read only, conversational; the /book endpoint keeps its own hard gates.
    client?.id ? supabase
      .from('patch_tests')
      .select('status, result, test_date, expires_at, confirmed_at')
      .eq('client_id', client.id)
      .eq('beautician_id', beautician.id)
      .order('created_at', { ascending: false })
      .limit(5) : { data: [] },

    // Live promo codes so Florrie can answer "any offers?" truthfully. Fail
    // soft to [] so a promo hiccup never blanks the brain.
    getActivePromos(beautician.id, 3),

    // THE DIARY. Before this, no reply prompt was ever given a single real
    // clock time, which is how a client was told 4.30 Thursday was free when it
    // was not. Same generator the booking page uses, so what Florrie offers and
    // what the client can actually pick are the same list. An hour is the
    // conservative length: the treatment is often not known yet, and offering a
    // slot too short to use is the same lie in a smaller hat. Fails soft to []
    // because an empty list makes Florrie cautious, never wrong.
    getFreeSlots(beautician.id, {
      workingHours: beautician.working_hours,
      timezone: beautician.timezone || 'Europe/London',
      durationMinutes: 60,
      days: 7,
    }).catch(err => {
      logger.warn({ err, beauticianId: beautician.id }, 'Free slot lookup failed, replying without times');
      return [];
    }),

    // THE SALON'S OWN NOTES. Aftercare, policies, treatment explainers, prep,
    // written by the beautician in the Knowledge page. Retrieval is lexical
    // keyword overlap against this message (see lib/knowledge.js for why not
    // embeddings at this scale). The prompt block built from these tells the
    // model to answer ONLY from them, and to say it will check and come back
    // rather than guess: same shape as the free-slots fix. Fails soft to []
    // so a knowledge hiccup makes Florrie cautious, never wrong.
    retrieveKnowledge(beautician.id, messageContent).catch(err => {
      logger.warn({ err, beauticianId: beautician.id }, 'Knowledge lookup failed, replying without knowledge');
      return [];
    })
  ]);

  // Oldest to newest, ready to render as a transcript.
  const conversationThread = (conversation.data || []).slice().reverse();

  // Average spend from recent history lets us judge 'within one visit'.
  const historyRows = clientHistory.data || [];
  const pricedVisits = historyRows.filter(a => (a.price_cents || 0) > 0);
  const avgSpendPounds = pricedVisits.length
    ? (pricedVisits.reduce((sum, a) => sum + a.price_cents, 0) / pricedVisits.length) / 100
    : null;
  const loyalty = client?.id ? loyaltyProximity(loyaltyConfig, clientPoints, avgSpendPounds) : null;

  // Guardian: which treatments need a patch test, and where this client stands.
  const treatmentsNeedingTest = (treatments.data || [])
    .filter(t => t.requires_patch_test)
    .map(t => t.name);
  let patchTest = null;
  if (treatmentsNeedingTest.length) {
    const ptRows = patchTests.data || [];
    const nowMs = Date.now();
    const sixMonthsMs = 1000 * 60 * 60 * 24 * 183;
    const hasValid = ptRows.some(pt =>
      (pt.status === 'passed' || pt.result === 'pass') && (
        (pt.expires_at && new Date(pt.expires_at).getTime() > nowMs) ||
        (pt.test_date && (nowMs - new Date(pt.test_date).getTime()) < sixMonthsMs)
      )
    );
    const hasPending = ptRows.some(pt => pt.status === 'pending' || pt.confirmed_at);
    const status = hasValid ? 'completed' : (hasPending ? 'pending' : 'none');
    patchTest = { status, treatmentsNeedingTest };
  }

  const offers = (activePromos || []).map(describePromo).filter(Boolean);

  return {
    treatments: treatments.data || [],
    upcomingAppointments: upcomingAppointments.data || [],
    clientHistory: clientHistory.data || [],
    clientIntelligence: clientIntelligence.data,
    conversation: conversationThread,
    freeSlots: freeSlots || [],
    knowledge: knowledge || [],
    loyalty,
    patchTest,
    offers,
    beautician: {
      name: beautician.business_name || beautician.first_name,
      workingHours: beautician.working_hours,
      bookingSlug: beautician.booking_slug
    },
    client: client ? {
      name: client.first_name,
      lastVisit: client.last_visit_at,
      totalVisits: client.total_visits,
      preferences: client.preferences,
      notes: client.notes
    } : null
  };
}

// Render the recent message thread as a short transcript so the AI classifies and
// replies in context, not to the latest line in isolation. Skips the current
// inbound message (shown to the model separately) and caps at the last 10 turns.
function buildTranscript(context, currentMessage) {
  const rows = (context?.conversation || []).filter(m => m && m.content);
  if (!rows.length) return '';
  const youName = context?.beautician?.name || 'You';
  const cur = String(currentMessage || '').trim();
  const lines = [];
  for (const m of rows) {
    if (m.direction === 'inbound' && String(m.content).trim() === cur) continue;
    lines.push(`${m.direction === 'inbound' ? 'Client' : youName}: ${m.content}`);
  }
  return lines.slice(-10).join('\n');
}

// STEP 2: CLASSIFY INTENT

async function classifyIntent(message, context) {
  const treatmentNames = context.treatments.map(t => t.name).join(', ');
  const transcript = buildTranscript(context, message);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: `You are an intent classifier for a beauty salon. Classify the customer's message into exactly one intent. Respond with JSON only.

Available treatments: ${treatmentNames}
${transcript ? `\nConversation so far (oldest first):\n${transcript}\n\nUse this thread for context. A short message like "yes please" or "Tuesday works" follows on from the chat above. Classify the customer's LATEST message (below), reading it as part of this conversation.\n` : ''}
Intents:
- booking_request: wants to book an appointment
- price_enquiry: asking about prices or costs
- availability_check: asking when the beautician is free
- reschedule: wants to move an existing appointment
- cancellation: wants to cancel an appointment
- general_question: question about treatments, products, patch tests, etc.
- greeting: just saying hi or hello
- review_thanks: thanking or praising after an appointment
- complaint: unhappy about something
- unknown: can't determine intent

Respond with: {"intent": "...", "confidence": 0.XX, "extracted": {"treatment": "...", "date": "...", "time": "..."}}
Only include extracted fields if they're mentioned in the message. Confidence is 0.0 to 1.0.`,
    messages: [{ role: 'user', content: message }]
  });

  try {
    const text = response.content[0].text.trim();
    // Handle potential markdown wrapping
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const raw = JSON.parse(jsonStr);

    // Validate AI classification output
    const classificationSchema = z.object({
      intent: z.enum([
        'booking_request', 'price_enquiry', 'availability_check',
        'reschedule', 'cancellation', 'general_question',
        'greeting', 'review_thanks', 'complaint', 'unknown'
      ]).default('unknown'),
      confidence: z.number().min(0).max(1).default(0),
      extracted: z.object({
        treatment: z.string().max(200).optional(),
        date: z.string().max(50).optional(),
        time: z.string().max(50).optional()
      }).passthrough().default({})
    });

    const validated = classificationSchema.safeParse(raw);
    if (!validated.success) {
      logger.warn({ issues: validated.error.issues, raw }, 'Classification AI output failed validation');
      return { intent: INTENTS.UNKNOWN, confidence: 0.0, extracted: {} };
    }
    return validated.data;
  } catch (err) {
    logger.error({ err }, 'Classification parse error');
    return { intent: INTENTS.UNKNOWN, confidence: 0.0, extracted: {} };
  }
}

// STEP 3: DECIDE

function canActAutonomously(classification, threshold) {
  // Always escalate certain intents regardless of confidence
  if (ALWAYS_ESCALATE.includes(classification.intent)) {
    return false;
  }

  // Check if intent is in the autonomous list AND confidence meets threshold
  return AUTONOMOUS_INTENTS.includes(classification.intent)
    && classification.confidence >= threshold;
}

function getEscalationReason(classification) {
  if (ALWAYS_ESCALATE.includes(classification.intent)) {
    return `Intent "${classification.intent}" requires human judgment`;
  }
  if (classification.confidence < 0.9) {
    return `Low confidence (${(classification.confidence * 100).toFixed(0)}%), not sure enough to respond autonomously`;
  }
  return `Intent "${classification.intent}" is not in the autonomous action list`;
}

// STEP 4a: GENERATE RESPONSE + TAKE ACTION

async function generateResponseAndAct(message, classification, context, beautician, client) {
  const { intent, extracted } = classification;

  // Build the action-specific prompt
  let actionPrompt = '';
  let actions = [];

  switch (intent) {
    case INTENTS.BOOKING_REQUEST:
    case INTENTS.AVAILABILITY_CHECK:
      actionPrompt = buildBookingPrompt(context, extracted);
      break;

    case INTENTS.PRICE_ENQUIRY:
      actionPrompt = buildPricePrompt(context, extracted);
      break;

    case INTENTS.RESCHEDULE:
      actionPrompt = buildReschedulePrompt(context, client, extracted);
      break;

    case INTENTS.GREETING:
      actionPrompt = 'Respond warmly and briefly. Ask how you can help today.';
      break;

    case INTENTS.REVIEW_THANKS:
      actionPrompt = 'Thank them warmly. If appropriate, mention they can book again anytime or leave a Google review.';
      break;

    default:
      actionPrompt = 'Respond helpfully based on what you know about the business.';
  }

  // Get tone model
  const toneGuide = buildToneGuide(beautician.tone_model);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: `You are replying to a client on behalf of a beautician called ${context.beautician.name}.

${toneGuide}

${buildVoiceGuide(beautician.voice_profile)}

RULES:
- Keep it short. This is WhatsApp, not email. 1-3 sentences max.
- Never say you're an AI, bot, or assistant. You ARE the beautician.
- Use the beautician's name style (first name only, never "I am [Business Name]").
- Match their likely communication style: professional but warm, not overly casual.
- Include specific details (treatment names, prices, times) when relevant.
- If directing to booking, include the link: florrie.ai/book/${context.beautician.bookingSlug || 'book'}
- Never make up availability. Only reference times from the context provided.
- Never use em dashes (—) or en dashes (–). Use commas, full stops, colons or line breaks instead.

${actionPrompt}

CONTEXT:
Treatments: ${context.treatments.map(t => `${t.name} (${t.duration_minutes}min, £${(t.price_cents/100).toFixed(2)})`).join(', ')}
${context.client ? `Client: ${context.client.name}, ${context.client.totalVisits || 0} previous visits` : 'New client'}
${context.clientIntelligence?.favourite_treatments?.length ? `Favourite treatments: ${context.clientIntelligence.favourite_treatments.join(', ')}` : ''}
${context.loyalty ? `LOYALTY: ${context.loyalty.summary} If it fits this message, you may mention it once, warmly and naturally, never pushy. Never invent points or rewards beyond what is stated here.` : ''}
${context.patchTest ? `PATCH TEST: These treatments need a patch test at least 24 hours before the first appointment: ${context.patchTest.treatmentsNeedingTest.join(', ')}. This client's patch test status: ${context.patchTest.status}. If they want to book one of these and their status is none or pending, warmly explain they need a quick patch test first and offer to pop them in for it at a real available time before the main appointment, rather than stalling. If their status is completed, treat it as a normal booking. Never invent a patch test result.` : ''}
${context.offers?.length ? `OFFERS: ${context.offers.join('; ')}. Only mention an offer if the client asks about price or offers, or is hesitating on cost. Never volunteer it otherwise, and never invent a code.` : `OFFERS: none running right now. If the client asks about offers or discounts, tell them there is nothing on at the moment. Never invent an offer, discount, or code.`}
${renderKnowledgeBlock(context.knowledge)}
${buildTranscript(context, message) ? `\nConversation so far (oldest first). Continue it naturally, do not repeat yourself or reintroduce yourself:\n${buildTranscript(context, message)}` : ''}

Respond with the WhatsApp message only. No quotes, no JSON, no explanation.`,
    messages: [{ role: 'user', content: message }]
  });

  // The prompt now holds real slots, so a named time is checkable: anything off
  // the verified list is invented and gets refused. Nothing in this path can
  // move a booking, so actionPerformed stays false and any "you're moved" claim
  // is still refused outright. See lib/reply-claims-guard.js and the 28 Jul incident.
  const guarded = safeReply(cleanReply(response.content[0].text.trim()), {
    allowedTimes: (context.freeSlots || []).map(s => s.time),
  });
  if (guarded.rejected) {
    logger.warn({
      beauticianId: beautician?.id,
      intent: classification?.intent,
      reason: guarded.reason,
      offending: guarded.offending,
    }, 'AI Front Desk BLOCKED an unverifiable claim in an auto-send reply');
  }
  const replyText = guarded.text;

  // Calculate tone match score by comparing against beautician's correction history
  const toneScore = await calculateToneScore(beautician, replyText);

  // Take any additional actions based on intent
  // Suggest-and-confirm: don't auto-book. Surface it for the beautician to approve.
  if (intent === INTENTS.BOOKING_REQUEST && extracted?.treatment && extracted?.date) {
    const suggestion = await createBookingSuggestion({
      beauticianId: beautician.id,
      clientId: context.client?.id || null,
      treatmentName: extracted.treatment,
      suggestedDate: extracted.date,
      suggestedTime: extracted.time || null,
      source: 'ai_front_desk',
      messageId: context.messageId || null,
    });
    actions.push({ type: 'booking_suggestion_created', suggestionId: suggestion?.id, treatment: extracted.treatment, date: extracted.date });
  }

  return {
    response: replyText,
    toneScore,
    actions,
    intent
  };
}

/**
 * Calculate how well the AI response matches the beautician's learned tone.
 * If no correction history exists, default to 0.85.
 * Otherwise, use Claude to rate similarity on 0-1 scale.
 */
async function calculateToneScore(beautician, generatedResponse) {
  const toneModel = beautician.tone_model || {};
  const corrections = toneModel.corrections || [];

  // No correction history — default to 0.85
  if (!corrections || corrections.length === 0) {
    return 0.85;
  }

  // Build examples from correction history
  const correctionExamples = corrections.slice(0, 5).map(c =>
    `Beautician's actual message: "${c.corrected}"`
  ).join('\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: `You are evaluating how well a generated response matches a beautician's communication style.

Examples of the beautician's actual messages:
${correctionExamples}

Rate the generated response on a scale of 0.0 to 1.0 based on:
- Formality level (matches their professionalism)
- Tone and warmth (matches their personality)
- Greeting/closing style (matches how they start/end)
- Vocabulary and phrasing (matches their word choices)

Respond with ONLY a number between 0.0 and 1.0 (e.g., 0.78). No explanation.`,
      messages: [{
        role: 'user',
        content: `Generated response to evaluate: "${generatedResponse}"`
      }]
    });

    const scoreStr = response.content[0].text.trim();
    const score = parseFloat(scoreStr);

    // Validate the score is a number between 0 and 1
    if (!isNaN(score) && score >= 0 && score <= 1) {
      return score;
    }

    logger.warn({ scoreStr }, 'Invalid tone score from Claude, defaulting to 0.85');
    return 0.85;
  } catch (err) {
    logger.error({ err }, 'Tone scoring failed, defaulting to 0.85');
    return 0.85;
  }
}

// STEP 4b: GENERATE SUGGESTED RESPONSE (for escalated messages)

async function generateSuggestedResponse(message, classification, context, beautician) {
  const toneGuide = buildToneGuide(beautician.tone_model);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: `You are ${context.beautician.name}, a beautician, replying to your client${context.client?.name ? ' ' + context.client.name : ''} on WhatsApp. Write the message you would send them, ready to send word for word.

${toneGuide}

${buildVoiceGuide(beautician.voice_profile)}

Hard rules:
- Output ONLY the message to the client, exactly as it should be sent. Nothing else.
- Write as yourself, to the client. Never talk about the client in the third person, never address anyone else, never explain your reasoning, and never ask for information you were not given.
- Never write a note, a placeholder, or anything in square brackets. It must be sendable as is.
- Never invent specifics you are unsure of, like a time, a price, or availability. If you are not certain, send a warm holding reply instead, for example that you will check your book and come straight back to them.
- If their last message is just a thank you, a sign off, or a quick acknowledgement, reply with a short warm closer.
- Keep it short and natural, WhatsApp style, 1 to 3 sentences. Use their first name where it feels natural.

Never use em dashes (—) or en dashes (–). Use commas, full stops, colons or line breaks instead.

Treatments: ${context.treatments.map(t => `${t.name} (£${(t.price_cents/100).toFixed(2)})`).join(', ')}
${renderFreeSlots(context.freeSlots)}
${context.loyalty ? `Loyalty: ${context.loyalty.summary} If it fits, you may mention it once, warmly, never pushy. Never invent points or rewards beyond this.` : ''}
${context.patchTest ? `Patch test: these treatments need one at least 24h before the first visit: ${context.patchTest.treatmentsNeedingTest.join(', ')}. This client's status: ${context.patchTest.status}. If they want one of these and status is none or pending, offer to book the quick patch test first at a real time; if completed, book as normal. Never invent a result.` : ''}
${context.offers?.length ? `Offers: ${context.offers.join('; ')}. Mention only if they ask about price or offers, or hesitate on cost. Never volunteer, never invent a code.` : `Offers: none running right now. If they ask about offers, say there is nothing on at the moment. Never invent an offer, discount, or code.`}
${renderKnowledgeBlock(context.knowledge)}
${buildTranscript(context, message) ? `\nConversation so far (oldest first), so your draft fits the thread:\n${buildTranscript(context, message)}` : ''}

Write only the message to send.`,
    messages: [{ role: 'user', content: message }]
  });

  // Ellie sends this from a card without opening the thread, so it has to be
  // safe on its own. Same guard, same verified list, as the auto path.
  const guarded = safeReply(cleanReply(response.content[0].text.trim()), {
    allowedTimes: (context.freeSlots || []).map(s => s.time),
  });
  if (guarded.rejected) {
    logger.warn({
      reason: guarded.reason,
      offending: guarded.offending,
    }, 'AI Front Desk BLOCKED an unverifiable claim in a drafted reply');
  }
  return guarded.text;
}

// INTENT-SPECIFIC PROMPT BUILDERS

function buildBookingPrompt(context, extracted) {
  return `The client wants to book an appointment.
${extracted?.treatment ? `They mentioned: "${extracted.treatment}"` : 'They haven\'t specified a treatment yet.'}
${extracted?.date ? `Preferred date: ${extracted.date}` : ''}
${extracted?.time ? `Preferred time: ${extracted.time}` : ''}

${renderFreeSlots(context.freeSlots)}

If they've specified enough details, confirm and direct them to the booking link.
If they haven't specified a treatment, ask which one they'd like.
If the time they asked for is not on the list above, say it has gone and offer the nearest time that IS on the list.`;
}

function buildPricePrompt(context, extracted) {
  return `The client is asking about prices.
${extracted?.treatment ? `They asked about: "${extracted.treatment}"` : 'They didn\'t specify which treatment.'}

If they asked about a specific treatment, give the price directly.
If they asked generally, list the 2-3 most popular treatments with prices.
Keep it natural — don't list every treatment like a menu.`;
}

function buildReschedulePrompt(context, client, extracted) {
  // This prompt used to say "Check if they have an upcoming appointment. If so,
  // confirm the change." Both halves were impossible: no appointment list is
  // given to the model, and NOTHING in the inbound-message path can move a
  // booking. The only code that writes appointments.starts_at is the client's
  // own manage link and Ellie's voice assistant. So "confirm the change" asked
  // the model to state something that could never be true, which is exactly
  // what it did on 28 Jul.
  return `The client wants to reschedule an existing appointment.
${extracted?.date ? `Date they mentioned: ${extracted.date}` : ''}

You CANNOT move appointments yourself. Never say the appointment has been
moved, changed, rescheduled, sorted, or is now at a new time. Never agree that
a specific time is free: you cannot see the diary and you will be wrong.

Acknowledge what they asked for warmly, then send them the link so they can
move it themselves and see the real availability.`;
}

// TONE MODEL

function buildToneGuide(toneModel) {
  if (!toneModel || Object.keys(toneModel).length === 0) {
    // Default tone based on Ellie validation data
    return `TONE: Professional but warm. Like a friendly colleague, not a corporate bot.
- Use "Hi [name]" not "Hello [name]" or "Hey [name]"
- End with something helpful, not a formal sign-off
- Keep punctuation natural (one exclamation mark max)
- No emojis unless the client uses them first
- British English spelling`;
  }

  // Use learned tone patterns
  const guide = ['TONE (learned from corrections):'];

  if (toneModel.greetingStyle) guide.push(`Greeting: ${toneModel.greetingStyle}`);
  if (toneModel.signoffStyle) guide.push(`Sign-off: ${toneModel.signoffStyle}`);
  if (toneModel.emojiUsage) guide.push(`Emojis: ${toneModel.emojiUsage}`);
  if (toneModel.formality) guide.push(`Formality: ${toneModel.formality}`);
  if (toneModel.exampleMessages?.length) {
    guide.push('Example messages from the beautician:');
    toneModel.exampleMessages.slice(0, 3).forEach(m => guide.push(`  "${m}"`));
  }

  return guide.join('\n');
}

/**
 * Learn from a tone correction.
 * Called when the beautician edits a suggested response before sending.
 * After 10 corrections, the tone model stabilises.
 */
export async function learnFromCorrection(beauticianId, originalResponse, correctedResponse) {
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('tone_model')
    .eq('id', beauticianId)
    .single();

  const toneModel = beautician?.tone_model || {};
  const corrections = toneModel.corrections || [];

  corrections.push({
    original: originalResponse,
    corrected: correctedResponse,
    timestamp: new Date().toISOString()
  });

  // After enough corrections, analyse patterns
  if (corrections.length >= 5) {
    const analysed = await analyseTonePatterns(corrections);
    Object.assign(toneModel, analysed);
  }

  toneModel.corrections = corrections.slice(-20); // Keep last 20

  await supabase
    .from('beauticians')
    .update({ tone_model: toneModel })
    .eq('id', beauticianId);
}

async function analyseTonePatterns(corrections) {
  const examples = corrections.map(c =>
    `Original: "${c.original}"\nCorrected: "${c.corrected}"`
  ).join('\n\n');

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: `Analyse these message corrections to extract communication style patterns. The "corrected" versions show how this beautician actually talks to clients.

Return JSON with:
{
  "greetingStyle": "how they typically open messages",
  "signoffStyle": "how they end messages",
  "emojiUsage": "never / rarely / moderate / frequent",
  "formality": "casual / warm-professional / formal",
  "keyPhrases": ["phrases they commonly use"],
  "avoidPhrases": ["phrases they consistently removed"],
  "exampleMessages": ["2-3 corrected messages that best represent their style"]
}`,
    messages: [{ role: 'user', content: examples }]
  });

  try {
    const text = response.content[0].text.trim();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const raw = JSON.parse(jsonStr);

    // Validate tone analysis output
    const toneSchema = z.object({
      greetingStyle: z.string().max(500).default(''),
      signoffStyle: z.string().max(500).default(''),
      emojiUsage: z.enum(['never', 'rarely', 'moderate', 'frequent']).default('moderate'),
      formality: z.enum(['casual', 'warm-professional', 'formal']).default('warm-professional'),
      keyPhrases: z.array(z.string().max(200)).max(20).default([]),
      avoidPhrases: z.array(z.string().max(200)).max(20).default([]),
      exampleMessages: z.array(z.string().max(1000)).max(5).default([])
    });

    const validated = toneSchema.safeParse(raw);
    if (!validated.success) {
      logger.warn({ issues: validated.error.issues, raw }, 'Tone pattern AI output failed validation');
      return {};
    }
    return validated.data;
  } catch (err) {
    logger.warn({ err }, 'Tone pattern analysis parse error');
    return {};
  }
}

// HELPERS

// Wall-frame labels. The date string already IS the salon's wall clock, so it
// is parsed as UTC and read with getUTC*: any locale conversion here would
// shift the day by an hour in BST and put a client at the wrong door.
const SLOT_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SLOT_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Prompts get a readable list, not 200 lines of it. The guard's allow-list
// still holds every slot, so trimming the prompt can only make Florrie offer
// fewer real times, never a fake one.
const SLOTS_SHOWN_IN_PROMPT = 40;

function formatSlot(slot) {
  const d = new Date(`${slot.date}T00:00:00Z`);
  return `${SLOT_DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${SLOT_MONTH_NAMES[d.getUTCMonth()]} ${slot.time}`;
}

/**
 * The availability block every reply prompt gets.
 *
 * This replaced getAvailableDays, which listed a whole day as "available" if it
 * held fewer than eight appointments. It never looked at working hours properly,
 * never looked at her blocks, and never produced a clock time at all, so the
 * model filled the gap itself. That guess is the 28 Jul incident.
 */
function renderFreeSlots(freeSlots) {
  const slots = freeSlots || [];
  if (!slots.length) {
    return 'No free slots found. Do not name any time. Offer to check the book and come back to them.';
  }
  const shown = slots.slice(0, SLOTS_SHOWN_IN_PROMPT).map(formatSlot).join(', ');
  const more = slots.length > SLOTS_SHOWN_IN_PROMPT ? ', and more after that' : '';
  return `Free slots (ONLY offer times from this list, never invent one): ${shown}${more}`;
}

async function sendResponse(beautician, client, responseText, classification, messageId) {
  // Detect which channel the client came in on
  const inboundChannel = client?.preferred_channel || 'sms';
  let sent = false;

  if (inboundChannel === 'instagram' && client?.instagram_id) {
    try {
      const result = await sendInstagramDM({
        recipientId: client.instagram_id,
        text: responseText,
        pageToken: beautician.instagram_page_token,
      });
      if (result) sent = true;
    } catch (err) {
      logger.error({ err }, 'Instagram DM send error in Front Desk');
    }
  } else if (inboundChannel === 'whatsapp' && beautician.whatsapp_phone_id && client?.whatsapp_id) {
    try {
      const result = await sendWhatsAppText({ to: client.whatsapp_id, body: responseText, beauticianId: beautician.id });
      if (result) sent = true;
    } catch (err) {
      logger.error({ err }, 'WhatsApp send error in Front Desk');
    }
  } else if (client?.phone) {
    try {
      const result = await sendSMS({ to: client.phone, body: responseText, beauticianId: beautician.id, messageType: 'ai_reply' });
      if (result) sent = true;
    } catch (err) {
      logger.error({ err }, 'SMS send error in Front Desk');
    }
  }

  if (sent) {
    // Genuinely delivered — safe to record it as a sent outbound message.
    await supabase.from('messages').insert({
      beautician_id: beautician.id,
      client_id: client?.id,
      channel: inboundChannel,
      direction: 'outbound',
      content: responseText,
      ai_handled: true,
      ai_confidence: 1.0,
      digital_employee: 'front_desk'
    });
  } else {
    // NOT delivered. Previously we inserted the message anyway, so the inbox showed
    // it as sent when the client never received it (the phantom-send bug). Instead,
    // surface the reply as a one-tap draft the beautician can review and send.
    logger.warn({ clientId: client?.id, channel: inboundChannel }, 'Front Desk: reply not delivered, surfacing as one-tap draft');
    await supabase.from('ai_actions').insert({
      beautician_id: beautician.id,
      action_type: 'message_escalated',
      digital_employee: 'front_desk',
      summary: `Reply ready for ${client?.first_name || 'a client'}, tap to send`,
      details: {
        intent: classification?.intent,
        confidence: classification?.confidence,
        suggested_response: responseText,
        channel: inboundChannel,
        reason: 'draft_ready_not_auto_sent'
      },
      client_id: client?.id,
      message_id: messageId,
      confidence: classification?.confidence ?? 1.0,
      autonomous: false,
      outcome: 'escalated',
      notification_sent: true,
      notification_text: `A reply to ${client?.first_name || 'a client'} is ready, tap to send`
    });
    pushEscalation(beautician.id, client?.first_name || 'Someone', responseText).catch(() => {});
    refreshLiveActivity(beautician.id).catch(() => {});
  }

  return sent;
}

async function logAiAction(beauticianId, clientId, messageId, classification, result) {
  const actionTypeMap = {
    booking_request: 'booking_created',
    price_enquiry: 'message_replied',
    availability_check: 'message_replied',
    // NOT 'booking_rescheduled'. Nothing in this path moves a booking, so
    // logging one told Ellie a second time that a change had happened. Only
    // code that actually writes the row may claim that.
    reschedule: 'message_replied',
    greeting: 'message_replied',
    review_thanks: 'message_replied'
  };

  const summaryMap = {
    booking_request: `Helped a client book an appointment`,
    price_enquiry: `Answered a price enquiry`,
    availability_check: `Checked availability for a client`,
    reschedule: `Replied about a reschedule request`,
    greeting: `Greeted a client`,
    review_thanks: `Thanked a client for their feedback`
  };

  await supabase.from('ai_actions').insert({
    beautician_id: beauticianId,
    action_type: actionTypeMap[classification.intent] || 'message_replied',
    digital_employee: 'front_desk',
    summary: summaryMap[classification.intent] || `Handled a "${classification.intent}" message`,
    details: {
      intent: classification.intent,
      confidence: classification.confidence,
      response_preview: truncate(result.response, 80)
    },
    client_id: clientId,
    message_id: messageId,
    confidence: classification.confidence,
    autonomous: true,
    outcome: 'success',
    notification_sent: true,
    notification_text: summaryMap[classification.intent] || 'Handled a message'
  });
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}


/**
 * Generate up to 3 short, distinct candidate replies for the salon owner to
 * pick from in the Inbox. She taps one to load it into her reply box, then
 * sends or edits it - she is always the one who sends (the "never start from
 * blank, but every send is a human tap" thesis). One cheap Haiku call.
 *
 * @returns {Promise<Array<{id:string,label:string,text:string}>>}
 */
export async function generateReplySuggestions(beautician, client, lastInboundMessage) {
  if (!lastInboundMessage || !process.env.ANTHROPIC_API_KEY) return [];

  const context = await gatherContext(beautician, client, lastInboundMessage);
  const toneGuide = buildToneGuide(beautician.tone_model);
  const firstName = context.client?.name || 'the client';

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: `You draft 3 SHORT candidate replies for ${context.beautician.name} to choose from, written in her voice. She taps one to load into her reply box, then sends or edits it. Write as her, to her client ${firstName}.

${buildVoiceGuide(beautician.voice_profile)}

${toneGuide}

Rules:
- Give 3 genuinely DIFFERENT useful options for this exact message (for example: a direct confirm, an alternative or offer, and an info/aftercare reply). No near-duplicates.
- WhatsApp style, 1 to 2 sentences each.
- British English. Never use em dashes or en dashes; use commas, full stops or line breaks.
- Each option needs a 2 to 3 word chip label summarising it (for example "Confirm Friday", "Offer alt time", "Send price").
- Use the client's real first name (${firstName}) where natural, not a placeholder.

Treatments: ${context.treatments.map(t => `${t.name} (£${(t.price_cents/100).toFixed(2)})`).join(', ') || 'none listed'}.
${renderFreeSlots(context.freeSlots)}
${context.loyalty ? `Loyalty: ${context.loyalty.summary} One of the 3 options may nod to this if it fits, warmly and never pushy.` : ''}
${context.patchTest ? `Patch test: these treatments need one at least 24h before the first visit: ${context.patchTest.treatmentsNeedingTest.join(', ')}. This client's status: ${context.patchTest.status}. If they want one of these and status is none or pending, offer to book the quick patch test first at a real time; if completed, book as normal. Never invent a result.` : ''}
${context.offers?.length ? `Offers: ${context.offers.join('; ')}. Mention only if they ask about price or offers, or hesitate on cost. Never volunteer, never invent a code.` : `Offers: none running right now. If they ask about offers, say there is nothing on at the moment. Never invent an offer, discount, or code.`}

Respond with ONLY a JSON array of exactly 3 objects: [{"label":"...","text":"..."}].`,
    messages: [{ role: 'user', content: lastInboundMessage }],
  });

  let raw = (response.content?.[0]?.text || '').trim();
  raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];

  // These are one tap from being sent, so they get the same guard. A chip that
  // would name an unverified time is dropped rather than shown: three good
  // options is better than four with a trap in it. The prompt's own worked
  // example used to be "Confirm Friday", which is precisely this failure.
  return parsed.slice(0, 3).map((sug, i) => ({
    id: `sg_${i}`,
    label: String(sug.label || `Option ${i + 1}`).replace(/[\u2013\u2014]/g, '-').slice(0, 28),
    text: String(sug.text || '').replace(/[\u2013\u2014]/g, '-').trim(),
  })).filter(s => s.text && !safeReply(s.text, {
    allowedTimes: (context.freeSlots || []).map(s2 => s2.time),
  }).rejected);
}
