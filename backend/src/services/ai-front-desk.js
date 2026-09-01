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
import { retrieveKnowledge, renderKnowledgeBlock, arrivalNoteFrom, writtenNotesFrom } from '../lib/knowledge.js';
import { createBookingSuggestion } from './automations.js';
import { sendMessage, sendInstagramDM, sendWhatsAppText, sendSMS, notifyBookingConfirmed } from './notifications.js';
import { pushEscalation, pushTeamUpdate, pushAtTheDoor } from './push-notifications.js';
import { refreshLiveActivity } from './live-activity.js';
import { isKnownClient, clientAutonomyOverride, guardedSend, classifyTier } from '../lib/outbound-guard.js';
import { ownerIsInThread } from '../lib/owner-in-thread.js';
import { authorshipAvailable } from '../lib/authorship.js';
import { isOptOutMessage, applyOptOut, OPT_OUT_CONFIRMATION } from '../lib/opt-out.js';
import { getLoyaltyConfig, getClientPoints, loyaltyProximity } from './loyalty.js';
import { getActivePromos, describePromo } from '../lib/promos.js';
import { advanceBookingConversation } from './conversational-booking.js';
import { authorship } from '../lib/authorship.js';
import { isGroundedReply, asksForHuman, signAsFlorrie, atTheDoorPhrase } from '../lib/grounded-reply.js';
import { normaliseOutcome } from '../lib/ai-actions.js';
import { patchTestEvidence, patchTestStance } from '../lib/patch-test-status.js';

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

  // Somebody standing outside is owed an answer from the person inside, and
  // this line is load bearing: "Im 60 seconds away!" has no question mark, and
  // this classifier reads it as a greeting, and a short greeting falls through
  // to the quiet branch below. Without this the 27 August message would not
  // even have made it into her queue, let alone onto her lock screen.
  if (atTheDoorPhrase(text)) return true;

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
export async function processInboundMessage(messageId, beautician, client, messageContent, channel = null) {
  const startTime = Date.now();

  // WHICH TRANSPORT THE MESSAGE CAME IN ON, not which one the client record
  // says she prefers.
  //
  // 31 August 2026, the night Instagram went live for @ellindigo. sendResponse
  // read clients.preferred_channel, and preferred_channel is only ever set to
  // 'instagram' when the client row is CREATED from an Instagram DM. An
  // existing WhatsApp or SMS client who DMs on Instagram therefore had
  // Florrie's reply sent as a text, to a conversation that was happening
  // somewhere else, and the outbound row was logged with the wrong channel on
  // it too. routes/escalations.js already had the right shape and this now
  // matches it: the channel of the message, then the stored preference, then
  // sms. Callers that do not pass one are unchanged.
  const replyChannel = channel || client?.preferred_channel || 'sms';

  try {
    // 0. PECR opt-out: STOP and friends are honoured instantly, on any channel,
    // before any AI processing. Service messages (confirmations, reminders)
    // still go out; marketing never does again (see lib/marketing-guard.js).
    //
    // The recogniser and the consent write moved to lib/opt-out.js on
    // 31 August 2026 so that Instagram's `redirect` and `off` modes, which
    // never reach this function, can honour STOP too.
    if (isOptOutMessage(messageContent)) {
      await applyOptOut({ beautician, client });
      const confirmation = OPT_OUT_CONFIRMATION;
      const sent = await sendResponse(beautician, client, confirmation, { intent: 'marketing_opt_out', confidence: 1.0 }, messageId, replyChannel);
      return { handled: sent, drafted: !sent, intent: 'marketing_opt_out', response: confirmation };
    }

    // 0b. SOMEBODY IS OUTSIDE, and this is the FIRST thing this function does
    // after the opt-out check, on purpose.
    //
    // 27 August, 11:32. "Im 60 seconds away!" came in, Florrie replied on her
    // own with "Oh I'm ready! I'll come get you xx", and a minute later Ellie
    // was writing over the top of her to a client already on the step.
    //
    // THIS ALERT IS NOT CONDITIONAL ON HOLDING THE REPLY, and that is the
    // point of it running here rather than down in the escalation branch. Even
    // when Florrie can answer properly from the arrival note, Ellie still wants
    // to know somebody is at her door: she is the one who has to look up.
    //
    // Everything below this line is slow on the scale that matters here.
    // gatherContext reads five tables, classifyIntent is a model call, and the
    // escalation path is a SECOND model call to write a draft before it pushes
    // anything at all. That is comfortably several seconds, spent in front of
    // the only part of this that a person outside a door can feel. So the
    // doorstep alert jumps the whole queue: no context, no classifier, no
    // draft, just her own words on Ellie's lock screen.
    //
    // It is awaited rather than fired and forgotten, because the answer to
    // "did she actually get it" is the point, and this is the one push in the
    // file allowed to fall back to a text when the answer is no.
    const doorstep = atTheDoorPhrase(messageContent);
    let doorstepAlert = null;
    if (doorstep) {
      doorstepAlert = await pushAtTheDoor(
        beautician.id,
        client?.first_name || 'Someone',
        messageContent,
        { clientId: client?.id || null }
      );
      logger.info(
        { beauticianId: beautician.id, clientId: client?.id, phrase: doorstep, told: doorstepAlert?.channel },
        'Client is at the door: alerted the owner before any other work'
      );
    }

    // 1. Gather context
    const context = await gatherContext(beautician, client, messageContent);

    // WHAT ELLIE HAS WRITTEN DOWN ABOUT ARRIVING, or ''. Read once here and
    // carried through every decision below, so the gate that lets Florrie
    // speak, the guard that checks her wording and the prompt that writes it
    // are all looking at the same sentence. Only read on a doorstep message:
    // an arrival note is not permission to say "come through" in the middle of
    // a reply about the price of a lash lift.
    const arrivalNote = doorstep ? arrivalNoteFrom(context.knowledge) : '';

    // And everything she has written, for the CLAIMS GUARD, which asks a wider
    // question than the gate does. The gate wants to know whether she has
    // written an arrival instruction. The guard wants to know whether any
    // particular sentence is hers, and a parking FAQ she wrote in March is
    // hers too. See writtenNotesFrom for why the two are not the same string.
    const writtenNotes = writtenNotesFrom(context.knowledge);

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
      ? isGroundedReply({ intent: classification.intent, message: messageContent, context, beauticianFirstName: beautician.first_name, arrivalNote })
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

    // Is Ellie already in this conversation herself. Read from the thread we
    // just loaded, so it costs nothing extra.
    const ownerPresent = context.conversationReadable === false
      // Unknown, so assume she is. Silence costs a message Ellie was going to
      // answer herself; speaking into a thread we cannot read is how Florrie
      // ends up contradicting her in front of a client.
      ? { present: true, at: null, reason: 'thread_unreadable' }
      : ownerIsInThread({
        conversation: context.conversation,
        currentMessageId: messageId,
      });

    let shouldAct = mayFlorrieSend({
      classification,
      groundedDecision,
      known,
      autonomyOverride,
      threshold: beautician.confidence_threshold,
      message: messageContent,
      arrivalNote,
      ownerPresent,
    });

    if (ownerPresent.present) {
      logger.info(
        { beauticianId: beautician.id, clientId: client?.id || null, ownerLastSpokeAt: ownerPresent.at },
        'AI Front Desk: the owner is already in this thread, drafting for her instead of sending',
      );
    }

    // Asking for a human is answered by a human, full stop — and the thread is
    // marked so Florrie stays out of it from now on rather than making her ask
    // twice. This runs regardless of intent: a client who says "is this a bot?"
    // has said the only thing that matters in the message.
    if (client?.id && asksForHuman(messageContent, beautician.first_name)) {
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

    // 3c. THE RESEND, and it sits HERE for exactly the reason 3b does.
    //
    // "I don't think I got a confirmation" is the one request in this file
    // Florrie can now actually satisfy, because notifyBookingConfirmed already
    // exists and does it properly. Everything about where this line is placed
    // is deliberate: below the three gates, so a thread Ellie has set to "just
    // me" gets no send; below the booking conversation, so a handover stops it;
    // and BEFORE the reply is generated, so the reply is written knowing
    // whether the send really happened rather than promising that it will.
    //
    // If it could not be done (no upcoming booking, more than one and no way
    // to tell which, or the send bounced) shouldAct goes false and the whole
    // thing becomes an ordinary draft for Ellie. The guard then holds every
    // sentence that would claim otherwise, because sendPerformed stays false.
    let resend = null;
    if (shouldAct && !convo && wantsConfirmationResent(messageContent)) {
      try {
        resend = await resendConfirmation({ beautician, client, messageContent, classification, context, messageId });
      } catch (err) {
        logger.error({ err, beauticianId: beautician.id, clientId: client?.id }, 'Confirmation resend threw');
        resend = { sent: false, escalate: true, reason: 'resend_threw', appointment: null, channels: [] };
      }
      if (resend.escalate) shouldAct = false;
    }

    if (shouldAct) {
      // 4a. Generate response and take action
      const result = convo
        ? { response: convo.reply, toneScore: null, actions: [], intent: classification.intent }
        : await generateResponseAndAct(
          messageContent, classification, context, beautician, client, { resend, arrivalNote, writtenNotes }
        );

      // The SECOND grounding check, and it is on the text rather than the
      // intent. A message classified as a lookup can still come back promising
      // "I'll get Ellie to call you" or offering a time — at which point it is
      // no longer a lookup, whatever the classifier said. Cheap, and it is the
      // only check that sees what is actually about to be sent.
      if (groundedDecision?.grounded) {
        const onText = isGroundedReply({
          intent: classification.intent, message: messageContent, context, reply: result.response,
          beauticianFirstName: beautician.first_name, arrivalNote,
        });
        if (!onText.grounded) {
          logger.info({ beauticianId: beautician.id, clientId: client?.id, reason: onText.reason },
            'Reply held after generation: the text was not grounded');
          groundedDecision = onText;
          shouldAct = false;
        }
      }

      // A DOORSTEP REPLY THE GUARD REFUSED MUST NOT GO OUT AS THE HOLDING REPLY.
      //
      // safeReply swaps a refused sentence for "let me check my book and come
      // straight back to you", and everywhere else in this file that is the
      // right trade: it is warm, it is always true, and Ellie picks the thread
      // up from her inbox. To somebody standing outside the door it is a
      // non-answer that reads as a brush-off, and it costs her the one thing
      // she came here for. So the message is held instead and the draft path
      // decides, on the same rule, whether there is anything worth offering.
      if (doorstep && result.blocked) {
        logger.info({ beauticianId: beautician.id, clientId: client?.id },
          'Doorstep reply refused by the claims guard, holding it rather than sending the fallback');
        groundedDecision = { grounded: false, reason: 'doorstep_reply_failed_the_claims_guard' };
        shouldAct = false;
      }

      if (!shouldAct) {
        // Fall through to the draft path with the reply we already generated,
        // rather than generating a second one.
        return await escalateWithDraft({
          beautician, client, messageContent, classification, context, messageId,
          // Except when that reply is the holding reply standing in for one the
          // guard refused: offering it as a one-tap is the same non-answer with
          // an extra step, so the draft path writes a fresh one or none.
          draft: result.blocked ? null : result.response,
          reason: groundedDecision?.reason || 'held_after_generation',
          doorstep: !!doorstep, arrivalNote, writtenNotes, skipPush: !!doorstep, alert: doorstepAlert,
        });
      }

      // Signed, whenever Florrie is speaking for herself.
      //
      // Two things at once, and the second is the one that matters most: it
      // says a machine wrote this so nobody thinks the beautician typed it,
      // and it gives a one-word way out. A client cannot be expected to guess
      // the word, so the signature prints it. Nothing she approves herself
      // gets signed, because she wrote it.
      //
      // No fallback name here. `first_name` is empty on a fresh signup, and a
      // default put the pilot's name on every other salon's messages for
      // months; florrieSignature handles the empty case honestly instead.
      const outgoing = signAsFlorrie(result.response, beautician.first_name);

      // 5a. Try to deliver. Returns true ONLY if the message was actually sent.
      // Florrie never silently auto-sends a phantom message; if delivery does not
      // happen the reply is surfaced as a one-tap draft (the "every send is one
      // human tap" thesis), and we never record it as sent.
      const sent = await sendResponse(beautician, client, outgoing, classification, messageId, replyChannel);

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

    } else if (!convo && !resend?.escalate && !replyIsOwed(messageContent, classification)) {
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
        // A doorstep escalation still gets a draft. An earlier version of this
        // fix skipped it, reasoning that every sentence worth sending to
        // somebody outside is a fact only the person in the room holds. That is
        // true of what Florrie can INVENT and false of what Ellie has written
        // down, and it is the wrong trade even with nothing written down: she
        // would still rather tap than type while a client waits. What she must
        // never get is a one-tap suggestion Florrie is not allowed to send, so
        // the draft is written under the doorstep tone rule and re-checked, and
        // a draft that fails the guard becomes no draft at all.
        doorstep: !!doorstep,
        arrivalNote,
        writtenNotes,
        // pushAtTheDoor has already buzzed her, louder and sooner than
        // pushEscalation would. A second notification for the same message
        // would teach her to ignore both.
        skipPush: !!doorstep,
        alert: doorstepAlert,
        // Say the real reason. An escalation logged as "Low confidence (85%)"
        // when the truth is "she set this thread to just me" is a reason that
        // sends whoever reads it looking in the wrong place — and for months
        // that string was on 43 messages whose confidence had nothing to do
        // with why they were held.
        // A held resend is the most specific reason there is, so it wins.
        // "Low confidence (85%)" on a message that actually failed to resend
        // a confirmation sends whoever reads it looking in the wrong place.
        // The doorstep wins outright. It is the most specific thing that can be
        // true about a message and it is the reason she is being interrupted.
        reason: doorstep
          ? `client_is_at_the_door:${doorstep}`
          : resend?.escalate
          ? `confirmation_resend:${resend.reason}`
          : (autonomyOverride === 'just_me' || autonomyOverride === 'drafts')
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


// RESENDING A CONFIRMATION
//
// 26 August 2026, in production, to a real client. Sophie wrote:
//
//   "...don't think I got a confirmation. Do you know what the email is called?"
//
// and Florrie answered, on her own, signed and sent:
//
//   "Hey, i'll send you a new one now. should come through in a min xx"
//
// Nothing was sent. There was no code path that COULD have sent it:
// notifyBookingConfirmed exists and works, and is called from Stripe, the
// booking flow, routes/appointments.js and a Resend button in the app, but it
// was never called from this file, and Florrie has no tools. So she described
// the action instead of taking it and the client sat waiting for an email that
// was never coming. Ellie's question afterwards was the right one: "How will I
// know if it actioned this?"
//
// Two halves to the fix and they are separate on purpose. The guard
// (lib/reply-claims-guard.js) stops the sentence being said when it is false.
// This is the half that makes it true.
//
// EVERYTHING HERE SITS BELOW THE GATE. It is called from inside
// `if (shouldAct)`, next to the booking conversation, for the reason written
// out at step 3b: a feature that WRITES above the gate once put a real
// appointment in the diary for a client who was never offered it. If Florrie
// may not speak in this thread she may not send in it either, and the draft
// Ellie gets must not claim a send that never happened.

/** The word for the thing. Everything else is a cue about it. */
const CONFIRMATION_NOUN = /\b(?:confirmation|confirmations|booking email|booking text)\b/i;

/**
 * Cues that the client has not got it, or wants it again. Read together with
 * the noun above: a cue on its own ("I never got the shade I wanted") means
 * nothing here.
 */
const CONFIRMATION_MISSING_CUES = [
  // "didn't get", "haven't received", "never came through", "hasn't arrived"
  /\b(?:did\s*n(?:'|’)?t|didnt|have\s*n(?:'|’)?t|havent|has\s*n(?:'|’)?t|hasnt|never|not)\s+(?:\w+\s+){0,3}?(?:get|got|receive|received|have|had|come|came|arrive|arrived|seen|see|show|turn)/i,
  // "don't think I got", "do not think I have had"
  /\b(?:do\s*n(?:'|’)?t|dont|do not|did\s*n(?:'|’)?t)\s+think\s+i\s+(?:\w+\s+){0,3}?(?:get|got|receive|received|have|had|ever)/i,
  // "can't find it", "couldn't see it"
  /\b(?:can\s*n?(?:'|’)?t|cannot|could\s*n(?:'|’)?t|couldnt)\s+(?:\w+\s+){0,2}?(?:find|see|locate)/i,
  /\bno\s+(?:sign\s+of\s+(?:a|an|my|the)\s+)?(?:confirmation|email|text)\b/i,
  /\bnothing\s+(?:came|arrived|through|has come)\b/i,
  /\bstill\s+(?:waiting|nothing)\b/i,
  /\bre-?send\b/i,
  /\bsend\s+(?:it|that|me|another|a\s+new|the)\b/i,
  /\b(?:missing|lost)\b/i,
];

/**
 * Is this client telling us she has not got her confirmation?
 *
 * Deliberately NOT a job for the classifier. The intent taxonomy has no slot
 * for this, and today's message classified as an ordinary question, which is
 * part of why nothing happened. A regex over the client's own words is
 * evidence; a model's label is a guess.
 */
export function wantsConfirmationResent(text) {
  const body = String(text || '');
  if (!CONFIRMATION_NOUN.test(body)) return false;
  return CONFIRMATION_MISSING_CUES.some(p => p.test(body));
}

// starts_at is SALON WALL TIME parked in the UTC slot, so the weekday is read
// with getUTCDay. Converting locally shifts the day by an hour in BST.
const WALL_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function wallWeekday(startsAt) {
  const d = new Date(startsAt);
  return Number.isNaN(d.getTime()) ? null : WALL_WEEKDAYS[d.getUTCDay()];
}
function wallLabel(startsAt) {
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return 'her appointment';
  const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `${day} at ${time}`;
}

/**
 * WHICH booking is "my confirmation"?
 *
 * The rows are context.clientUpcoming, which the rest of this file already
 * uses to answer "am I booked in?": this client, this beautician, confirmed or
 * pending, from twelve hours ago to ninety days out, oldest first. Reusing it
 * means the appointment Florrie resends is the same one she would name.
 *
 * The rule: the NEXT one, unless the conversation says otherwise. When it says
 * otherwise, we do not guess. There is no half-right resend, and sending a
 * client the confirmation for the wrong appointment is a new wrong fact rather
 * than a fix for an old one.
 *
 * @returns {{appointment: object|null, reason: string}}
 */
export function pickConfirmationAppointment(upcoming, messageText = '') {
  const rows = (upcoming || [])
    .filter(r => r && r.id && r.starts_at)
    .slice()
    .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));

  if (!rows.length) return { appointment: null, reason: 'no_upcoming_booking' };
  const next = rows[0];
  if (rows.length === 1) return { appointment: next, reason: 'only_upcoming_booking' };

  const body = String(messageText || '');

  // She named a day, and it is not the next one's day. She is talking about a
  // different booking, so this is Ellie's.
  const namedDays = WALL_WEEKDAYS.filter(d => new RegExp(`\\b${d}\\b`, 'i').test(body));
  if (namedDays.length && !namedDays.includes(wallWeekday(next.starts_at))) {
    return { appointment: null, reason: 'ambiguous_named_another_day' };
  }

  // Same for a treatment: "my lash lift confirmation" when the next one is a
  // pedicure means the lash lift, and we are not going to work out which.
  const namedHere = rows
    .map(r => r.treatments?.name)
    .filter(Boolean)
    .filter(n => body.toLowerCase().includes(String(n).toLowerCase()));
  if (namedHere.length && !namedHere.includes(next.treatments?.name)) {
    return { appointment: null, reason: 'ambiguous_named_another_treatment' };
  }

  return { appointment: next, reason: 'next_upcoming_booking' };
}

/**
 * One ai_actions row per attempt, success or failure.
 *
 * The owner has to be able to see it: that was Ellie's actual question. A
 * silent failure here recreates the exact bug we are fixing, so a bounce is
 * logged as loudly as a send. action_type has no CHECK any more (migration
 * 051 dropped it); outcome still does, so it goes through normaliseOutcome.
 * message_id ties the row to the message that claimed it, which is what
 * GET /api/inbox/thread joins on.
 */
async function logResendAction({
  beauticianId, clientId, messageId, appointmentId,
  status, summary, details, confidence,
}) {
  try {
    const { error } = await supabase.from('ai_actions').insert({
      beautician_id: beauticianId,
      client_id: clientId || null,
      message_id: messageId || null,
      appointment_id: appointmentId || null,
      action_type: 'booking_confirmation_resent',
      digital_employee: 'front_desk',
      summary,
      details: details || {},
      confidence: typeof confidence === 'number' ? confidence : null,
      autonomous: true,
      outcome: normaliseOutcome(status),
      status: status === 'sent' ? 'executed' : null,
      // The escalation path pushes its own notification; a second push for the
      // same message is the noise problem this file spent a quarter fixing.
      notification_sent: false,
    });
    if (error) throw error;
  } catch (err) {
    logger.error({ err, beauticianId, messageId, appointmentId }, 'Could not log the confirmation resend to ai_actions');
  }
}

/**
 * Actually resend the confirmation, then report honestly what happened.
 *
 * The send itself is notifyBookingConfirmed, the SAME function Stripe, the
 * booking flow and Ellie's own Resend button call. There is deliberately no
 * second sender: a copy would drift from the template, the calendar link and
 * the receipt line, and the client would get a different email depending on
 * who asked for it.
 *
 * It goes through guardedSend so consent, quiet hours, the frequency cap, the
 * per-client monthly cap and the allowance reserve all get their say, and so
 * the outbound_sends row exists for every other engine's caps to read. The
 * tier is TRANSACTIONAL, and that is not an opinion: classifyTier
 * ('booking_confirmation') returns it from the guard's own list, alongside
 * appointment_reminder and receipt. It re-sends a message about a booking this
 * client already made and already agreed to, carrying nothing she has not
 * already seen. Holding it behind an approval queue IS the failure being
 * fixed: she is waiting for it right now.
 *
 * @returns {{sent: boolean, escalate: boolean, reason: string, appointment: object|null, channels: string[]}}
 */
async function resendConfirmation({ beautician, client, messageContent, classification, context, messageId }) {
  const who = client?.first_name || 'A client';
  const { appointment, reason } = pickConfirmationAppointment(context?.clientUpcoming, messageContent);

  // Nothing to resend, or more than one candidate and the conversation does
  // not say which. Do not guess, do not send, hand it to Ellie.
  if (!appointment) {
    const summary = reason === 'no_upcoming_booking'
      ? `${who} asked about her confirmation but I could not find a booking to resend, so this is for you`
      : `${who} asked about her confirmation and she has more than one booking, so I did not guess which one`;
    await logResendAction({
      beauticianId: beautician.id, clientId: client?.id, messageId, appointmentId: null,
      status: 'escalated', summary, confidence: classification?.confidence,
      details: { reason, upcoming_count: (context?.clientUpcoming || []).length, asked: truncate(messageContent, 120) },
    });
    logger.info({ beauticianId: beautician.id, clientId: client?.id, reason }, 'Confirmation resend not attempted');
    return { sent: false, escalate: true, reason, appointment: null, channels: [] };
  }

  let result = null;
  const verdict = await guardedSend({
    beauticianId: beautician.id,
    clientId: client?.id || null,
    messageType: 'booking_confirmation',
    // What the confirmation itself travels on is decided by her reminder
    // prefs inside notifyBookingConfirmed. This is the thread it was asked
    // for in, which is what makes the outbound_sends row readable later.
    channel: client?.preferred_channel || 'whatsapp',
    client,
    body: `Booking confirmation resent for ${wallLabel(appointment.starts_at)}`,
    send: async () => {
      // notifyBookingConfirmed resolves with an OBJECT on failure as well as
      // on success ({sent:false, reason:'no_contact_details'}), and an object
      // is truthy. Returning it raw would report every bounce as a send.
      result = await notifyBookingConfirmed(appointment.id);
      return result?.sent === true;
    },
  });

  const sent = verdict?.delivered === true;
  const channels = result?.channels || [];
  const failure = result?.reason || (verdict?.decision !== 'send' ? verdict?.reason : null) || 'send_failed';

  await logResendAction({
    beauticianId: beautician.id, clientId: client?.id, messageId, appointmentId: appointment.id,
    status: sent ? 'sent' : 'failed',
    confidence: classification?.confidence,
    summary: sent
      ? `Resent ${who}'s booking confirmation for ${wallLabel(appointment.starts_at)}${channels.length ? ` by ${channels.join(' and ')}` : ''}`
      : `Tried to resend ${who}'s booking confirmation for ${wallLabel(appointment.starts_at)} and it did not go (${failure})`,
    details: {
      reason,
      appointment_id: appointment.id,
      starts_at: appointment.starts_at,
      channels,
      outbound_decision: verdict?.decision || null,
      outbound_tier: verdict?.tier || classifyTier('booking_confirmation'),
      failure: sent ? null : failure,
      asked: truncate(messageContent, 120),
    },
  });

  if (!sent) {
    logger.error({ beauticianId: beautician.id, clientId: client?.id, appointmentId: appointment.id, failure },
      'Confirmation resend FAILED; the reply must not say it was sent');
  }

  // A failed send is escalated as well as logged. The client asked for
  // something and it did not happen, and the only person who can fix a missing
  // phone number or a paused account is Ellie.
  return { sent, escalate: !sent, reason: sent ? reason : failure, appointment, channels };
}

// STEP 1: GATHER CONTEXT

async function gatherContext(beautician, client, messageContent = '') {
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Parallel fetches for speed
  const [treatments, upcomingAppointments, clientUpcoming, clientHistory, clientIntelligence, conversation, loyaltyConfig, clientPoints, activePromos, freeSlots, knowledge] = await Promise.all([
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
      // authored_by only when the column is really there. Naming it blind
      // would reject the WHOLE select, and this select IS the conversation
      // history, so the failure would be Florrie answering with no context at
      // all: worse than the out-of-context replies it is here to prevent.
      .select(`id, direction, content, channel, created_at${authorshipAvailable() ? ', authored_by' : ''}`)
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .limit(12) : { data: [] },

    // Loyalty programme settings (null when the beautician has it off) and
    // this client's running points balance, so replies can nod to reward
    // proximity. Both fail soft so a loyalty hiccup never blanks the brain.
    getLoyaltyConfig(beautician.id),
    client?.id ? getClientPoints(beautician.id, client.id) : 0,

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
    //
    // The arrival note is FORCED in for a client who has just turned up, and it
    // has to be. Scoring is keyword overlap, and "Im 60 seconds away!" shares
    // not one word with "Come through when you get here, no need to knock", so
    // the single entry that answers the message scores zero and is dropped
    // before it is ranked. See the 27 August incident, and lib/knowledge.js.
    retrieveKnowledge(beautician.id, messageContent, {
      alwaysInclude: atTheDoorPhrase(messageContent) ? ['arrival'] : [],
    }).catch(err => {
      logger.warn({ err, beauticianId: beautician.id }, 'Knowledge lookup failed, replying without knowledge');
      return [];
    })
  ]);

  // Oldest to newest, ready to render as a transcript.
  const conversationThread = (conversation.data || []).slice().reverse();

  // A failed read and an empty thread are the same shape here, and they mean
  // opposite things. An empty thread is a new client; a failed read is Florrie
  // about to answer a conversation she cannot see, which is precisely the
  // 1 September incident arriving by a different route. Say so, and let the
  // caller treat it as "somebody may already be handling this".
  const conversationReadable = !conversation.error;
  if (conversation.error) {
    logger.error(
      { err: conversation.error, beauticianId: beautician.id, clientId: client?.id || null },
      'AI Front Desk: could not read the conversation history. Florrie will not auto-send into a thread she cannot see.',
    );
  }

  // Average spend from recent history lets us judge 'within one visit'.
  const historyRows = clientHistory.data || [];
  const pricedVisits = historyRows.filter(a => (a.price_cents || 0) > 0);
  const avgSpendPounds = pricedVisits.length
    ? (pricedVisits.reduce((sum, a) => sum + a.price_cents, 0) / pricedVisits.length) / 100
    : null;
  const loyalty = client?.id ? loyaltyProximity(loyaltyConfig, clientPoints, avgSpendPounds) : null;

  /* Guardian: which treatments need a patch test, and where this client stands.
   *
   * THIS USED TO BE ITS OWN COPY OF THE RULE, AND IT WAS BROKEN IN TWO WAYS.
   *
   * It tested `pt.status === 'passed'`, a spelling nothing in this codebase
   * writes and the CHECK constraint on patch_tests.result rejects with 23514.
   * So `hasValid` was false for every client alive, including one whose test
   * the owner had recorded herself from the Patch Tests page: Florrie went on
   * offering to book her another one.
   *
   * And it had no idea who it was talking to. On 27 August 2026 at 01:18 a
   * client wrote "hey I have a appointment on the 3rd of September and I just
   * went onto the website and it said about a patch test do I need to book one
   * in or not x". She was one of 277 true first timers, so yes. But 673 of the
   * 854 clients imported from Timely with a real total_visits have no completed
   * appointment inside Florrie at all, and this block would have offered every
   * one of them a patch test as though she had never been in.
   *
   * There is one implementation of the rule now, in lib/patch-test-status.js,
   * and the three prompts below are handed the population rather than a status
   * word they have to interpret.
   */
  const treatmentsNeedingTest = (treatments.data || [])
    .filter(t => t.requires_patch_test)
    .map(t => t.name);
  let patchTest = null;
  if (treatmentsNeedingTest.length) {
    // No appointment is on the table yet in a conversation, so the window runs
    // to today. patchTestEvidence keeps its asOf contract for every caller that
    // DOES have a date (the manage page judges against the booking).
    const evidence = client?.id
      ? await patchTestEvidence(supabase, beautician.id, client.id, {
          expiryMonths: beautician.patch_test_expiry_months || 6,
          logger,
        })
      : null;

    patchTest = { ...patchTestStance(evidence), treatmentsNeedingTest };
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
    conversationReadable,
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

/**
 * THE ONE PATCH TEST PARAGRAPH THE MODEL EVER SEES.
 *
 * Three prompts carried three slightly different versions of the same
 * sentence, and all three said the same wrong thing: "if their status is none
 * or pending, warmly explain they need a quick patch test". Status was
 * computed by a block that could never return anything else (it tested for
 * 'passed'), and it knew nothing about who it was talking to, so a returning
 * client was offered a patch test she had had years ago and, on 27 August
 * 2026, one of the 673 imported regulars asked at 01:18 whether she needed to
 * book one.
 *
 * Written once, here, off patchTestStance in lib/patch-test-status.js. Terse
 * on purpose: it is pasted into a Haiku system prompt three times.
 */
function renderPatchTestBlock(patchTest) {
  if (!patchTest) return '';
  const head = `Patch test: these treatments need one at least 24h before the first visit: ${patchTest.treatmentsNeedingTest.join(', ')}.`;
  const never = 'Never invent a patch test, a result, or a date.';

  switch (patchTest.status) {
    case 'satisfied':
      return `${head} This client is covered, it is on record. Book as normal and do not raise a patch test. ${never}`;
    case 'booked':
      return `${head} She already has one booked, so do not offer another. Book as normal. ${never}`;
    case 'first_timer':
      return `${head} We have no record of this client ever visiting, so she does need one. Warmly explain it and offer to pop her in at a real available time before the main appointment, rather than stalling. ${never}`;
    case 'returning_recent':
    case 'returning_stale':
      return `${head} She has been here before, and we simply have nothing written down. Do NOT tell her she needs one and do NOT offer to book one. Book as normal. If she asks about a patch test, say you will check her notes and come back to her, and leave it there. ${never}`;
    case 'reaction':
      return `${head} There is a note on her last patch test. Do not offer a booking and do not reassure her. Say you want a quick chat before this one and that you will come back to her. ${never}`;
    case 'unidentified':
      return `${head} You have not matched this person to a client record, so say nothing about HER: state the condition instead, that a first visit needs a quick patch test at least 24h before, and offer a real time for it if that is her. If she says she has been in before, do not argue, say you will check her notes and come back to her. ${never}`;
    default:
      return `${head} You could not check her record just now, so claim nothing either way. Do not tell her she needs one. Say you will check and come straight back to her. ${never}`;
  }
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
 * `doorstep` says a client is standing outside. It changes one thing here: a
 * draft the claims guard refuses becomes NO draft, instead of the usual
 * "let me check my book and come straight back to you" holding reply. That
 * fallback is a fine thing to say about a diary question and a useless thing to
 * offer somebody already on the step, and a one-tap she cannot send is worse
 * than an empty box.
 * `arrivalNote` is what she has written down about arriving, which is what
 * makes a doorstep draft sayable at all, and what the draft is written FROM.
 * `writtenNotes` is everything she has written, which is what the claims guard
 * checks the finished draft AGAINST. See lib/knowledge.js for why those are two
 * strings rather than one.
 * `skipPush` is for when she has ALREADY been notified, louder and sooner, by
 * something that ran before this. Two buzzes for one message teaches her to
 * ignore both.
 * `alert` is the verdict from that earlier notification, recorded so "she was
 * never actually told" is discoverable rather than silent.
 */
async function escalateWithDraft({
  beautician, client, messageContent, classification, context, messageId,
  draft = null, reason = null, doorstep = false, arrivalNote = '', writtenNotes = '',
  skipPush = false, alert = null,
}) {
  const suggestion = draft || await generateSuggestedResponse(
    messageContent, classification, context, beautician,
    { arrivalNote, writtenNotes, holdingFallback: !doorstep },
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
      // How she was told, and whether it actually landed. 'push' means at least
      // one device took it, 'sms' means push reached nothing and a text went to
      // her own mobile instead, 'none' means neither worked and she has NOT
      // been told by this system. Recorded so that last case is discoverable
      // rather than silent.
      ...(alert ? { alerted_by: alert.channel, alert_delivered: alert.delivered } : {}),
    },
    client_id: client?.id,
    message_id: messageId,
    confidence: classification.confidence,
    autonomous: false,
    outcome: 'escalated',
    notification_sent: true,
    // Read off the flag rather than sniffed out of the reason string. A
    // doorstep message reaches this function by two routes, and only one of
    // them carries a reason that starts with client_is_at_the_door: the other
    // is a reply that was written, refused by the guard and held, whose reason
    // says so instead. Both are somebody standing at her door.
    notification_text: doorstep
      ? `${client?.first_name || 'A client'} is at the door now`
      : `New message from ${client?.first_name || 'someone'} needs your attention`,
  });

  if (!skipPush) pushEscalation(beautician.id, client?.first_name || 'Someone', messageContent).catch(() => {});
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
 * @param {string} a.message the client's own words, for the doorstep check
 * @param {string} a.arrivalNote what she has written down about arriving
 * @param {{present: boolean, reason: string}} [a.ownerPresent] is Ellie already in this thread
 */
export function mayFlorrieSend({ classification, groundedDecision, known, autonomyOverride, threshold, message, arrivalNote = '', ownerPresent = null }) {
  // ABOVE EVERYTHING, INCLUDING THE DOORSTEP RULE BELOW.
  //
  // 1 September: Ellie answered a client's reschedule herself, the client said
  // "Yes no problem!! Xxx", and Florrie then arrived to check about a patch
  // test. The exchange was already finished. Every dial we had said yes,
  // because every dial asks what Florrie may SAY and none of them asks whether
  // a human being is already saying it.
  //
  // She still writes the draft; it still reaches Ellie. The only thing this
  // changes is who presses send, and that is the whole of the complaint.
  if (ownerPresent?.present) return false;
  // ABOVE EVERY DIAL, INCLUDING THE ONE THAT SAYS YES, AND ONLY WHEN SHE HAS
  // WRITTEN NOTHING DOWN.
  //
  // 27 August: a client sixty seconds from the door was told "Oh I'm ready!
  // I'll come get you xx" at 0.99 confidence, and a minute later Ellie was
  // contradicting her own assistant to somebody already on the step. What was
  // missing was not caution, it was a fact. Nobody had written down what
  // happens when a client arrives, so every word of that reply was invented.
  //
  // With an arrival note on file this falls straight through to the ordinary
  // dials below, because the note IS the fact and it is the owner's own
  // sentence. A thread she set to 'just me' still gets a draft rather than a
  // send, which is exactly what she asked for and is handled two lines down.
  //
  // This sits first, and inside this function rather than beside it, because
  // this is the one decision that decides whether a machine speaks to Ellie's
  // clients. A check anywhere else is a check the next call site can forget.
  if (atTheDoorPhrase(message) && !String(arrivalNote || '').trim()) return false;

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

/**
 * The extra paragraph a reply gets when the client is standing outside.
 *
 * TWO THINGS WENT WRONG AT 11:32 ON 27 AUGUST and only one of them was a lie.
 * The other was the voice. "Oh I'm ready! I'll come get you xx" is gushing, and
 * Ellie does not write like that: her own reply a minute later was "Come
 * through when you're here! It's a bit hectic with the festival staff". A
 * client on a doorstep has about four seconds of attention and wants one fact.
 *
 * So the note supplies the fact and this supplies the shape. Written as an
 * instruction rather than trusted as one: lib/reply-claims-guard.js still
 * refuses every sentence below whatever the model does with this.
 */
function doorstepInstruction(message, arrivalNote) {
  if (!atTheDoorPhrase(message)) return '';
  const note = String(arrivalNote || '').trim();
  return `
THIS CLIENT IS AT YOUR DOOR RIGHT NOW.
${note
    ? `Your own note about arriving says: "${note}"\nAnswer from that note and nothing else, in its own words wherever you can.`
    : 'You have no note about what happens when a client arrives, so you have nothing true to tell them about getting in. Do not invent anything: where to go, where to park, whether the door is open and whether you are ready are all things you cannot see.'}
- ONE short sentence. Nothing else.
- Never say what you are doing or are about to do, never say you are ready, never offer to come and get them, never describe the room.
- No kisses, no exclamation marks, no "Oh".`;
}

// STEP 4a: GENERATE RESPONSE + TAKE ACTION

async function generateResponseAndAct(message, classification, context, beautician, client, opts = {}) {
  const { intent, extracted } = classification;
  // Evidence of a real send in THIS request. Nothing else may set it.
  const sendPerformed = opts?.resend?.sent === true;
  // Her arrival instruction, which is what a doorstep reply is written FROM,
  // and everything she has written, which is what the guard checks it AGAINST.
  const arrivalNote = String(opts?.arrivalNote || '');
  const writtenNotes = String(opts?.writtenNotes || arrivalNote);

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

  // The confirmation really did go out a moment ago, so the reply is allowed
  // to say so, and should: the client asked a question and the answer is now a
  // fact. This block is only ever reached when sendPerformed is true, which
  // means notifyBookingConfirmed reported a delivered channel.
  if (sendPerformed) {
    const appt = opts.resend.appointment;
    const chans = (opts.resend.channels || []).join(' and ');
    actionPrompt = `${actionPrompt}

YOU HAVE JUST RESENT THIS CLIENT'S BOOKING CONFIRMATION. It really did go out${chans ? ` by ${chans}` : ''}, just now, for ${wallLabel(appt?.starts_at)}. This is a fact, not a plan. Tell her plainly that you have sent it again and roughly where it will land. Suggest she checks her junk folder if she cannot see it. Do not promise anything else and do not offer any times.`;
  }

  // Last onto actionPrompt, so it wins the argument with whatever the intent
  // asked for. "Respond warmly and briefly. Ask how you can help today" is the
  // greeting prompt, and a greeting prompt is what wrote the 27 August reply.
  const doorstepBlock = doorstepInstruction(message, arrivalNote);
  if (doorstepBlock) actionPrompt = `${actionPrompt}\n${doorstepBlock}`;

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
${renderPatchTestBlock(context.patchTest)}
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
  // sendPerformed is the sibling of actionPerformed, not the same flag. A
  // real resend must not license "you're all moved to Thursday": that is a
  // different claim, evidenced by different code, and folding the two into one
  // flag would wave the 28 July incident through on the strength of the fix
  // for the 26 August one.
  const guarded = safeReply(fit.text, { allowedTimes, sendPerformed, arrivalNote: writtenNotes });
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
    if (checkReplyClaims(styledFallback, { allowedTimes, sendPerformed, arrivalNote: writtenNotes }).ok) replyText = styledFallback;
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
    intent,
    // The guard threw the model's sentence away and replaced it. Carried out of
    // here because the caller has to know: for most messages the holding reply
    // is a perfectly good thing to send, and for a client standing at a door it
    // is not. See processInboundMessage.
    blocked: guarded.rejected === true,
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

/**
 * @param {object} opts
 * @param {string} opts.arrivalNote what the owner wrote about clients arriving,
 *   quoted into the prompt so the draft is written from her words.
 * @param {string} opts.writtenNotes everything she has written, which is what
 *   the claims guard checks the finished draft against.
 * @param {boolean} opts.holdingFallback whether a draft the guard refuses may be
 *   replaced by the holding reply. False for a doorstep message: "let me check
 *   my book and come straight back to you" is a sensible thing to offer about a
 *   diary question and nonsense to offer somebody standing outside, and a
 *   one-tap she cannot use costs her a tap and the client a minute. Returns
 *   null instead, and escalateWithDraft ships no draft.
 */
async function generateSuggestedResponse(message, classification, context, beautician, opts = {}) {
  const arrivalNote = String(opts.arrivalNote || '');
  const writtenNotes = String(opts.writtenNotes || arrivalNote);
  const holdingFallback = opts.holdingFallback !== false;
  const voiceSection = buildVoiceInstructions(beautician, message);
  const style = beautician.voice_profile?.style || null;
  const doorstepBlock = doorstepInstruction(message, arrivalNote);

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
${doorstepBlock}
Treatments: ${context.treatments.map(t => `${t.name} (£${(t.price_cents/100).toFixed(2)})`).join(', ')}
${renderClientBookings(context.clientUpcoming)}
${renderFreeSlots(context.freeSlots)}
${context.loyalty ? `Loyalty: ${context.loyalty.summary} If it fits, you may mention it once, warmly, never pushy. Never invent points or rewards beyond this.` : ''}
${renderPatchTestBlock(context.patchTest)}
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
  const guarded = safeReply(fit.text, { allowedTimes, arrivalNote: writtenNotes });
  if (guarded.rejected) {
    logger.warn({
      reason: guarded.reason,
      offending: guarded.offending,
      facet: guarded.facet,
    }, 'AI Front Desk BLOCKED an unverifiable claim in a drafted reply');
    if (!holdingFallback) return null;
    const styledFallback = styleFit(guarded.text, style).text;
    if (checkReplyClaims(styledFallback, { allowedTimes, arrivalNote: writtenNotes }).ok) return styledFallback;
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

async function sendResponse(beautician, client, responseText, classification, messageId, channel = null) {
  // The channel the message ARRIVED on, passed down from processInboundMessage.
  // See the note on replyChannel there for why reading preferred_channel here
  // was sending Instagram replies out as texts on 31 August 2026. The fallback
  // chain is kept for the few callers that still do not know their channel.
  const inboundChannel = channel || client?.preferred_channel || 'sms';
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
${renderPatchTestBlock(context.patchTest)}
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
    // gatherContext forces the arrival note in when the last inbound message
    // was somebody at the door, so a chip saying what Ellie herself wrote
    // survives instead of being dropped a tap before she sends it.
    arrivalNote: writtenNotesFrom(context.knowledge),
  }).rejected);
}
