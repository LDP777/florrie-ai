import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { cleanReply } from '../lib/text.js';
import { safeReply, checkReplyClaims } from '../lib/reply-claims-guard.js';
import {
  renderVoiceSection,
  NEUTRAL_VOICE_SECTION,
  styleFit,
  regenerationHint,
  AUTHOR,
} from '../lib/idiolect.js';
import { getFreeSlots } from '../lib/free-slots.js';
import { retrieveKnowledge, renderKnowledgeBlock } from '../lib/knowledge.js';
import { createBookingSuggestion } from './automations.js';
import { sendMessage, sendInstagramDM, sendWhatsAppText, sendSMS } from './notifications.js';
import { pushEscalation, pushTeamUpdate } from './push-notifications.js';
import { refreshLiveActivity } from './live-activity.js';
import { isKnownClient, clientAutonomyOverride } from '../lib/outbound-guard.js';
import { getLoyaltyConfig, getClientPoints, loyaltyProximity } from './loyalty.js';
import { getActivePromos, describePromo } from '../lib/promos.js';
import { advanceBookingConversation } from './conversational-booking.js';
import { authorship } from '../lib/authorship.js';
import { isGroundedReply, asksForHuman, signAsFlorrie } from '../lib/grounded-reply.js';

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
  // "I have an appointment with you tomorrow at 6pm correct?" — a client asked
  // Ellie exactly that the evening before hers, and there was no intent for it,
  // so it landed in `unknown` and queued for approval. It is a database
  // lookup: Florrie knows the answer with certainty and can answer in two
  // seconds. Distinct from availability_check, which is a claim about the
  // future and stays gated.
  BOOKING_LOOKUP: 'booking_lookup',         // "when am I booked in?"
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
  INTENTS.BOOKING_LOOKUP,
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
    //
    // TWO GATES, AND FOR MONTHS ONLY ONE OF THEM EVER RAN.
    //
    // canActAutonomously is the original: is the intent on a list, and is the
    // classifier's confidence over her threshold (0.9). isGroundedReply is the
    // one built to answer Ellie's actual complaint: is the ANSWER a fact we
    // already hold?
    //
    // The grounded check used to sit INSIDE `if (shouldAct)`, so it could only
    // ever narrow what the confidence gate had already allowed. And the
    // confidence gate almost never allows anything, because 0.9 is a number
    // this classifier does not return: it says 0.85 when it is sure. Thirty
    // days of her inbox, measured:
    //
    //   177 messages in. Florrie wrote a reply to 147 of them. She sent 5.
    //   142 escalated — 43 of those at exactly 85% confidence.
    //
    // One of the held ones was a client saying "So don't rush xx" and Florrie
    // wanting to answer "no worries! take your time". That went to Ellie for
    // approval. Twenty-one greetings and six thank-yous did the same. About
    // twelve of the hundred and forty-two genuinely needed her.
    //
    // So the guards decide now, rather than a number nobody can reach. The
    // grounded check runs FIRST and on its own terms, and everything it
    // refuses — availability, reschedules, cancellations, complaints, anything
    // it cannot evidence — escalates exactly as it does today. The 28 July
    // incident ("4.30 Thursday is free" when it was not) was an availability
    // claim, and availability is still ungrounded, still gated, unchanged.
    //
    // One switch, so this is reversible without a deploy: autonomy.grounded_replies.
    const groundedRepliesOn = beautician.autonomy?.grounded_replies !== false;
    let groundedDecision = groundedRepliesOn
      ? isGroundedReply({ intent: classification.intent, message: messageContent, context })
      : { grounded: false, reason: 'grounded_replies_switched_off' };

    // A client Ellie already knows is a relationship she manages personally, so
    // the grounded check is the ONLY way Florrie speaks in that thread — the
    // confidence gate cannot let a booking request through on a 0.95. For
    // somebody who has never booked, either gate will do: a stranger asking
    // what a lash lift costs is answered from the price list, and a stranger
    // asking for a slot still goes down the old path with its threshold intact.
    const known = await isKnownClient(beautician.id, client?.id, client);
    // Per-client driver setting. 'just_me' / 'drafts' means she asked Florrie
    // not to speak in this thread. 'florrie' is an explicit whitelist.
    const autonomyOverride = await clientAutonomyOverride(beautician.id, client?.id, client);

    let shouldAct = mayFlorrieSend({
      classification,
      groundedDecision,
      known,
      autonomyOverride,
      threshold: beautician.confidence_threshold,
    });

    // Asking for a human is answered by a human, full stop — and the thread is
    // marked so Florrie stays out of it from now on rather than making her ask
    // twice. This runs regardless of intent: a client who says "is this a bot?"
    // has said the only thing that matters in the message.
    if (client?.id && asksForHuman(messageContent)) {
      shouldAct = false;
      try {
        await supabase.from('clients')
          .update({ messaging_autonomy: 'just_me' })
          .eq('id', client.id)
          .eq('beautician_id', beautician.id);
        logger.info({ beauticianId: beautician.id, clientId: client.id }, 'Client asked for a human; thread handed to the beautician');
      } catch (err) {
        logger.warn({ err, clientId: client.id }, 'Could not mark thread as human-only');
      }
    }

    // 3b. THE BOOKING CONVERSATION, and it runs HERE for a reason.
    //
    // Booking someone in end to end is the one thing a prompt cannot do: it
    // reads the real diary, holds the slot under the same database guards the
    // booking page uses, and takes a deposit. Those are WRITES. It used to run
    // above the three gates, which meant that for a client Ellie had set to
    // "just me", or for any client she already knows, or with her autonomy dial
    // where it is today, Florrie would still hold a slot out of her diary and
    // open a Stripe session while the reply itself sat unsent in her queue.
    // The slot then expired thirty minutes later and the cleanup texted the
    // client that a booking they had never been offered had been released.
    //
    // So the machine only turns over when the reply is actually going out. If
    // Florrie may not speak in this thread, she may not touch the diary in it
    // either. Everything else falls through to the ordinary draft Ellie already
    // gets, which is what she has today, not a regression.
    let convo = null;
    if (shouldAct) {
      try {
        convo = await advanceBookingConversation({ beautician, client, message: messageContent, classification, context });
      } catch (err) {
        // Belt and braces: the module already catches its own failures and
        // hands over. If it somehow throws, the normal reply path still runs.
        logger.error({ err, beauticianId: beautician.id }, 'Booking conversation threw, falling back to the normal reply path');
        convo = null;
      }
    }

    // A booking conversation that gave up (could not read the diary, nothing
    // free, asked twice already) is exactly the case where Ellie should see it.
    if (convo?.handOver) shouldAct = false;

    if (shouldAct) {
      // 4a. Generate response and take action
      const result = convo
        ? { response: convo.reply, toneScore: null, actions: [], intent: classification.intent }
        : await generateResponseAndAct(
          messageContent, classification, context, beautician, client
        );

      // The SECOND grounding check, and it is on the text rather than the
      // intent. A message classified as a lookup can still come back promising
      // "I'll get Ellie to call you" or offering a time — at which point it is
      // no longer a lookup, whatever the classifier said. Cheap, and it is the
      // only check that sees what is actually about to be sent.
      if (groundedDecision?.grounded) {
        const onText = isGroundedReply({
          intent: classification.intent, message: messageContent, context, reply: result.response,
        });
        if (!onText.grounded) {
          logger.info({ beauticianId: beautician.id, clientId: client?.id, reason: onText.reason },
            'Reply held after generation: the text was not grounded');
          groundedDecision = onText;
          shouldAct = false;
        }
      }

      if (!shouldAct) {
        // Fall through to the draft path with the reply we already generated,
        // rather than generating a second one.
        return await escalateWithDraft({
          beautician, client, messageContent, classification, context, messageId,
          draft: result.response, reason: groundedDecision?.reason || 'held_after_generation',
        });
      }

      // Signed, whenever Florrie is speaking for herself.
      //
      // Two things at once, and the second is the one that matters most: it
      // says a machine wrote this so nobody thinks Ellie typed it, and it
      // gives a one-word way out. A client cannot be expected to guess that
      // "ELLIE" works — it has to be on the message. Nothing Ellie approves
      // herself gets signed, because she wrote it.
      const outgoing = signAsFlorrie(result.response, beautician.first_name || 'Ellie');

      // 5a. Try to deliver. Returns true ONLY if the message was actually sent.
      // Florrie never silently auto-sends a phantom message; if delivery does not
      // happen the reply is surfaced as a one-tap draft (the "every send is one
      // human tap" thesis), and we never record it as sent.
      const sent = await sendResponse(beautician, client, outgoing, classification, messageId);

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
        // Carry WHY Florrie was allowed to answer this one, so "What Florrie
        // did" can say it and a decision can be explained after the fact
        // rather than reconstructed from the intent.
        await logAiAction(beautician.id, client?.id, messageId, classification, result, groundedDecision?.reason || null);
      }

      logger.info({ handled: sent, drafted: !sent, intent: classification.intent }, sent ? 'AI Front Desk sent reply' : 'AI Front Desk drafted reply for one-tap send');
      return { handled: sent, drafted: !sent, intent: classification.intent, response: result.response };

    } else if (!convo && !replyIsOwed(messageContent, classification)) {
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
      // 4b. Escalate, still giving her a suggested response to approve. When
      // the booking conversation produced one it wins outright: it is the only
      // text in this file backed by a real diary read and, once a slot is
      // held, a real appointment row.
      return await escalateWithDraft({
        beautician, client, messageContent, classification, context, messageId,
        draft: convo?.reply || null,
        // Say the real reason. An escalation logged as "Low confidence (85%)"
        // when the truth is "she set this thread to just me" is a reason that
        // sends whoever reads it looking in the wrong place — and for months
        // that string was on 43 messages whose confidence had nothing to do
        // with why they were held.
        reason: (autonomyOverride === 'just_me' || autonomyOverride === 'drafts')
          ? `client_set_to:${autonomyOverride}`
          : (groundedDecision && !groundedDecision.grounded ? groundedDecision.reason : null),
      });
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
  const [treatments, upcomingAppointments, clientUpcoming, clientHistory, clientIntelligence, conversation, loyaltyConfig, clientPoints, patchTests, activePromos, freeSlots, knowledge] = await Promise.all([
    // Treatment menu
    // deposit_percent, buffer_minutes and requires_consultation are here
    // because lib/booking-rules.js needs them to price and length a booking
    // exactly as the booking page does. All three exist in production; the
    // error is checked below, because a mistyped column makes PostgREST reject
    // the WHOLE select and an empty menu reads as "this salon does nothing".
    supabase
      .from('treatments')
      .select('id, name, duration_minutes, buffer_minutes, price_cents, deposit_cents, deposit_percent, category, contraindications, requires_patch_test, requires_consultation, consultation_form_id')
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

    // THIS client's own bookings still to come.
    //
    // upcomingAppointments above is the whole diary for seven days, which
    // answers "how busy is she" and cannot answer "am I booked in?" — the
    // question a client actually asked the evening before hers. It also stops
    // at seven days, so a booking three weeks out was invisible.
    //
    // Ninety days, and every live status, because confirming a booking back to
    // somebody is only safe if we are looking at all of them.
    client?.id ? supabase
      .from('appointments')
      .select('id, starts_at, ends_at, status, treatments(name)')
      .eq('beautician_id', beautician.id)
      .eq('client_id', client.id)
      .gte('starts_at', new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString())
      .lte('starts_at', new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString())
      .in('status', ['confirmed', 'pending'])
      .order('starts_at')
      : Promise.resolve({ data: [] }),

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

  if (treatments.error) {
    logger.error({ err: treatments.error, beauticianId: beautician.id }, 'Treatment menu read failed; Florrie must not claim she does not offer something');
  }

  return {
    treatments: treatments.data || [],
    // Carried so the booking flow can tell "she has no treatments" apart from
    // "I could not read her treatments". Those need different replies.
    treatmentsError: treatments.error || null,
    upcomingAppointments: upcomingAppointments.data || [],
    clientUpcoming: clientUpcoming?.data || [],
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
- booking_lookup: asking about an appointment they ALREADY have — when is it, is it still booked, confirming a date or time back to you ("I have an appointment tomorrow at 6pm correct?", "when am I booked in?", "am I still in for Tuesday?"). NOT wanting to change it and NOT asking when you are free.
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
        'reschedule', 'cancellation', 'general_question', 'booking_lookup',
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

/**
 * Hand the message to Ellie with a reply already written for her.
 *
 * Pulled out of the inline else-branch so the two paths that reach it cannot
 * drift: the ordinary "Florrie may not answer this" case, and the later one
 * where a reply was generated, read, and judged ungrounded on its text. The
 * second must produce exactly the escalation the first does, or a held reply
 * would land in a different queue from a gated one.
 *
 * `draft` is a reply we already have; when it is null one is generated.
 * `reason` is the grounding verdict, recorded so a decision can be explained
 * after the fact rather than guessed at from the intent.
 */
async function escalateWithDraft({ beautician, client, messageContent, classification, context, messageId, draft = null, reason = null }) {
  const suggestion = draft || await generateSuggestedResponse(
    messageContent, classification, context, beautician
  );
  const escalationReason = reason || getEscalationReason(classification);

  await supabase.from('messages').update({
    ai_handled: false,
    ai_confidence: classification.confidence,
    ai_intent: classification.intent,
    ai_response: suggestion,
    escalated: true,
    escalated_reason: escalationReason,
    digital_employee: 'front_desk',
  }).eq('id', messageId);

  await supabase.from('ai_actions').insert({
    beautician_id: beautician.id,
    action_type: 'message_escalated',
    digital_employee: 'front_desk',
    summary: `Escalated message from ${client?.first_name || 'unknown'}: "${truncate(messageContent, 50)}"`,
    details: {
      intent: classification.intent,
      confidence: classification.confidence,
      reason: escalationReason,
      suggested_response: suggestion,
    },
    client_id: client?.id,
    message_id: messageId,
    confidence: classification.confidence,
    autonomous: false,
    outcome: 'escalated',
    notification_sent: true,
    notification_text: `New message from ${client?.first_name || 'someone'} needs your attention`,
  });

  pushEscalation(beautician.id, client?.first_name || 'Someone', messageContent).catch(() => {});
  refreshLiveActivity(beautician.id).catch(() => {});

  logger.info({ handled: false, intent: classification.intent, escalated: true, reason: escalationReason }, 'AI Front Desk escalated message');
  return { handled: false, intent: classification.intent, escalated: true, suggestion };
}

/**
 * This client's own bookings, for the prompt.
 *
 * Without it, "I have an appointment with you tomorrow at 6pm correct?" has no
 * answer in front of the model and it either hedges or invents. The whole
 * point of treating that question as grounded is that the fact is right here.
 *
 * Wall clock, not local conversion: starts_at parks salon time in the UTC slot.
 */
function renderClientBookings(rows) {
  if (!rows?.length) return 'This client has nothing booked in right now. Do NOT tell them they are booked; if they think they are, say you will get it checked.';
  const fmt = (r) => {
    const d = new Date(r.starts_at);
    const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    return `${day} at ${time}${r.treatments?.name ? ` for ${r.treatments.name}` : ''}`;
  };
  return `This client's booked appointments (these are FACTS from the diary, state them plainly and never contradict them): ${rows.map(fmt).join('; ')}.
NEVER say when an appointment is unless it is in that list, and say the day that is actually written there. Do not say "tomorrow", "today" or a weekday as a friendly aside — a client asked "hello" and got "all set for tomorrow!" when her appointment was the following Wednesday, and she had to correct it. If you are not naming a date from the list above, do not name one at all.`;
}

// STEP 3: DECIDE

/**
 * May Florrie send this one herself?
 *
 * Pulled out as a pure function because it is the single most consequential
 * `if` in the product — it decides whether a machine speaks to Ellie's clients
 * — and for months nobody could test it without an LLM and a database. The
 * version it replaces was three assignments scattered across forty lines of
 * the handler, and the bug in it (the grounded check could only ever narrow
 * what the confidence gate allowed, and the confidence gate allowed almost
 * nothing) was invisible for exactly that reason.
 *
 * @param {object} a
 * @param {{intent: string, confidence: number}} a.classification
 * @param {{grounded: boolean, reason: string}} a.groundedDecision from isGroundedReply
 * @param {boolean} a.known has this client ever booked
 * @param {string|null} a.autonomyOverride 'just_me' | 'drafts' | 'florrie' | null
 * @param {number} a.threshold her confidence threshold, for the old path
 */
export function mayFlorrieSend({ classification, groundedDecision, known, autonomyOverride, threshold }) {
  // She said not in this thread. Nothing else matters.
  if (autonomyOverride === 'just_me' || autonomyOverride === 'drafts') return false;

  const grounded = !!groundedDecision?.grounded;
  const classic = canActAutonomously(classification, threshold);

  // A client she has explicitly whitelisted is one she has said Florrie may
  // speak to, so the known-client narrowing below does not apply.
  if (autonomyOverride === 'florrie') return grounded || classic;

  // A client she already knows is a relationship she manages personally: the
  // grounded check is the ONLY way in. A booking request at 0.95 confidence
  // still waits for her, which is what the 28 July availability incident was.
  if (known) return grounded;

  // A stranger: either gate will do. Answering "what does a lash lift cost"
  // from the price list needs no permission, and asking for a Saturday slot
  // still goes down the old path with its threshold intact.
  return grounded || classic;
}

function canActAutonomously(classification, threshold) {
  // Always escalate certain intents regardless of confidence
  if (ALWAYS_ESCALATE.includes(classification.intent)) {
    return false;
  }

  // Check if intent is in the autonomous list AND confidence meets threshold
  return AUTONOMOUS_INTENTS.includes(classification.intent)
    && classification.confidence >= threshold;
}

/**
 * Why this one is going to Ellie, when nothing more specific was passed.
 *
 * The grounded check now supplies the reason in almost every case, so this is
 * the fallback for a message held by something else. It used to blame
 * confidence for everything below 0.9, which was both the commonest string in
 * her queue and usually not the cause.
 */
function getEscalationReason(classification, threshold = 0.9) {
  if (ALWAYS_ESCALATE.includes(classification.intent)) {
    return `Intent "${classification.intent}" requires human judgment`;
  }
  if (!AUTONOMOUS_INTENTS.includes(classification.intent)) {
    return `Intent "${classification.intent}" is not in the autonomous action list`;
  }
  if (classification.confidence < threshold) {
    return `Not sure enough what "${classification.intent}" meant here (${(classification.confidence * 100).toFixed(0)}%)`;
  }
  return `Held for you to check`;
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

  const voiceSection = buildVoiceInstructions(beautician, message);
  const style = beautician.voice_profile?.style || null;

  // The system prompt is a function of one extra instruction so the length
  // retry below can re-run the SAME prompt with a hard word cap bolted on,
  // rather than a second, subtly different prompt.
  const systemPrompt = (extra = '') => `You are replying to a client on behalf of a beautician called ${context.beautician.name}.

${voiceSection}

RULES:
- Keep it short. This is WhatsApp, not email.
- Never say you're an AI, bot, or assistant. You ARE the beautician.
- Use the beautician's name style (first name only, never "I am [Business Name]").
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
${extra}
Respond with the WhatsApp message only. No quotes, no JSON, no explanation.`;

  const callModel = async (extra) => {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt(extra),
      messages: [{ role: 'user', content: message }],
    });
    return cleanReply(r.content[0].text.trim());
  };

  // Length is the one voice failure an edit cannot fix, so it is the one worth
  // paying a second Haiku call for. Everything else (her sign off, her emoji,
  // her lower case start, the missing full stop) is repaired mechanically.
  let fit = styleFit(await callModel(''), style);
  if (fit.tooLong) {
    logger.info({ beauticianId: beautician?.id, band: fit.band }, 'reply was longer than she writes, regenerating once');
    fit = styleFit(await callModel(regenerationHint(fit.band)), style);
  }
  if (!fit.ok) {
    logger.info({ beauticianId: beautician?.id, problems: fit.problems }, 'reply still off her voice after repair');
  }

  const allowedTimes = (context.freeSlots || []).map(s => s.time);
  // The prompt holds real slots, so a named time is checkable: anything off the
  // verified list is invented and gets refused. Nothing in this path can move a
  // booking, so actionPerformed stays false and any "you're moved" claim is
  // still refused outright. See lib/reply-claims-guard.js and the 28 Jul incident.
  // Style repair runs BEFORE this on purpose: the guard gets the last word.
  const guarded = safeReply(fit.text, { allowedTimes });
  let replyText = guarded.text;
  if (guarded.rejected) {
    logger.warn({
      beauticianId: beautician?.id,
      intent: classification?.intent,
      reason: guarded.reason,
      offending: guarded.offending,
    }, 'AI Front Desk BLOCKED an unverifiable claim in an auto-send reply');

    // The holding reply is safe but it is not hers, and "let me check my book"
    // in flat prose is exactly the tell we are fixing. repairDraft only adds or
    // removes her sign off, her emoji, her capital and her final full stop, so
    // it cannot introduce a time or a claim. Re-checked anyway: if the styled
    // version fails for any reason the plain one goes instead.
    const styledFallback = styleFit(replyText, style).text;
    if (checkReplyClaims(styledFallback, { allowedTimes }).ok) replyText = styledFallback;
  }

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
  const voiceSection = buildVoiceInstructions(beautician, message);
  const style = beautician.voice_profile?.style || null;

  const systemPrompt = (extra = '') => `You are ${context.beautician.name}, a beautician, replying to your client${context.client?.name ? ' ' + context.client.name : ''} on WhatsApp. Write the message you would send them, ready to send word for word.

${voiceSection}

Hard rules:
- Output ONLY the message to the client, exactly as it should be sent. Nothing else.
- Write as yourself, to the client. Never talk about the client in the third person, never address anyone else, never explain your reasoning, and never ask for information you were not given.
- Never write a note, a placeholder, or anything in square brackets. It must be sendable as is.
- Never invent specifics you are unsure of, like a time, a price, or availability. If you are not certain, send a warm holding reply instead, for example that you will check your book and come straight back to them.
- If their last message is just a thank you, a sign off, or a quick acknowledgement, reply with a short warm closer.
- Keep it short and natural, WhatsApp style. Length and sign off come from the voice notes above, not from what reads as complete.

Never use em dashes (—) or en dashes (–). Use commas, full stops, colons or line breaks instead.

Treatments: ${context.treatments.map(t => `${t.name} (£${(t.price_cents/100).toFixed(2)})`).join(', ')}
${renderClientBookings(context.clientUpcoming)}
${renderFreeSlots(context.freeSlots)}
${context.loyalty ? `Loyalty: ${context.loyalty.summary} If it fits, you may mention it once, warmly, never pushy. Never invent points or rewards beyond this.` : ''}
${context.patchTest ? `Patch test: these treatments need one at least 24h before the first visit: ${context.patchTest.treatmentsNeedingTest.join(', ')}. This client's status: ${context.patchTest.status}. If they want one of these and status is none or pending, offer to book the quick patch test first at a real time; if completed, book as normal. Never invent a result.` : ''}
${context.offers?.length ? `Offers: ${context.offers.join('; ')}. Mention only if they ask about price or offers, or hesitate on cost. Never volunteer, never invent a code.` : `Offers: none running right now. If they ask about offers, say there is nothing on at the moment. Never invent an offer, discount, or code.`}
${renderKnowledgeBlock(context.knowledge)}
${buildTranscript(context, message) ? `\nConversation so far (oldest first), so your draft fits the thread:\n${buildTranscript(context, message)}` : ''}
${extra}
Write only the message to send.`;

  const callModel = async (extra) => {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt(extra),
      messages: [{ role: 'user', content: message }],
    });
    return cleanReply(r.content[0].text.trim());
  };

  let fit = styleFit(await callModel(''), style);
  if (fit.tooLong) fit = styleFit(await callModel(regenerationHint(fit.band)), style);

  const allowedTimes = (context.freeSlots || []).map(s => s.time);
  // Ellie sends this from a card without opening the thread, so it has to be
  // safe on its own. Same guard, same verified list, as the auto path.
  const guarded = safeReply(fit.text, { allowedTimes });
  if (guarded.rejected) {
    logger.warn({
      reason: guarded.reason,
      offending: guarded.offending,
    }, 'AI Front Desk BLOCKED an unverifiable claim in a drafted reply');
    const styledFallback = styleFit(guarded.text, style).text;
    if (checkReplyClaims(styledFallback, { allowedTimes }).ok) return styledFallback;
  }
  return guarded.text;
}

// INTENT-SPECIFIC PROMPT BUILDERS

function buildBookingPrompt(context, extracted) {
  return `The client wants to book an appointment.
${extracted?.treatment ? `They mentioned: "${extracted.treatment}"` : 'They haven\'t specified a treatment yet.'}
${extracted?.date ? `Preferred date: ${extracted.date}` : ''}
${extracted?.time ? `Preferred time: ${extracted.time}` : ''}

${renderClientBookings(context.clientUpcoming)}
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

/**
 * The voice block every reply prompt gets, in strict order of evidence.
 *
 * 1. Her MEASURED idiolect plus four of her real messages (lib/idiolect.js).
 * 2. Failing that, whatever her own corrections have taught us.
 * 3. Failing that, plain and neutral.
 *
 * These are alternatives, never a stack. The old code emitted the hardcoded
 * default tone AND the voice profile together, so a prompt could carry
 * 'Use "Hi [name]" not "Hey [name]"' and 'she opens with "hey lovely"' in the
 * same breath, plus "no emojis unless the client uses them first" over the top
 * of her measured emoji habit. Handed a contradiction, a model splits the
 * difference, and the difference is the generic message her clients spotted.
 */
function buildVoiceInstructions(beautician, incomingMessage) {
  const measured = renderVoiceSection(beautician?.voice_profile, incomingMessage);
  if (measured) return measured;
  const learned = buildToneGuide(beautician?.tone_model);
  return learned || NEUTRAL_VOICE_SECTION;
}

function buildToneGuide(toneModel) {
  // No corrections on file: say nothing here and let the caller fall through to
  // the neutral block. A confident description of a voice nobody has measured
  // is worse than admitting we do not know it yet.
  if (!toneModel || Object.keys(toneModel).length === 0) return '';

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
      // Florrie's sentences, start to finish. This row must never come back as
      // training data for Florrie: see migration 20260805.
      ...authorship(AUTHOR.AI),
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

async function logAiAction(beauticianId, clientId, messageId, classification, result, groundedReason = null) {
  const actionTypeMap = {
    // NOT 'booking_created'. This path replies to a booking enquiry; it does
    // not create a booking. Only conversational-booking.js writes an
    // appointment row, and it logs its own action when it does, so leaving this
    // as 'booking_created' told Ellie a booking had been made every time
    // somebody merely asked, and told her twice when one really was.
    booking_request: 'message_replied',
    price_enquiry: 'message_replied',
    availability_check: 'message_replied',
    booking_lookup: 'message_replied',
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
    booking_lookup: `Confirmed a client's booking back to them`,
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
      response_preview: truncate(result.response, 80),
      // Why Florrie was allowed to send this one herself. Recorded so a
      // decision can be read back rather than reconstructed from the intent —
      // and so that if she ever answers something she should not have, the
      // reason is right there next to it.
      grounded_reason: groundedReason,
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
  const voiceSection = buildVoiceInstructions(beautician, lastInboundMessage);
  const style = beautician.voice_profile?.style || null;
  const firstName = context.client?.name || 'the client';

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: `You draft 3 SHORT candidate replies for ${context.beautician.name} to choose from, written in her voice. She taps one to load into her reply box, then sends or edits it. Write as her, to her client ${firstName}.

${voiceSection}

Rules:
- Give 3 genuinely DIFFERENT useful options for this exact message (for example: a direct confirm, an alternative or offer, and an info/aftercare reply). No near-duplicates.
- WhatsApp style. Each option the length SHE writes, per the voice notes above.
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
    // Repaired, not regenerated: three chips are not worth three retries, and
    // the repairs are the audible half anyway (her kiss, her emoji, her case).
    text: styleFit(String(sug.text || '').replace(/[\u2013\u2014]/g, '-').trim(), style).text,
  })).filter(s => s.text && !safeReply(s.text, {
    allowedTimes: (context.freeSlots || []).map(s2 => s2.time),
  }).rejected);
}
