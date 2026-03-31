import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../index.js';
import logger from '../lib/logger.js';
import { createBookingSuggestion } from './automations.js';

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
    // 1. Gather context
    const context = await gatherContext(beautician, client);

    // 2. Classify intent
    const classification = await classifyIntent(messageContent, context);

    // 3. Decide: act or escalate?
    const shouldAct = canActAutonomously(classification, beautician.confidence_threshold);

    if (shouldAct) {
      // 4a. Generate response and take action
      const result = await generateResponseAndAct(
        messageContent, classification, context, beautician, client
      );

      // 5a. Update message record
      await supabase.from('messages').update({
        ai_handled: true,
        ai_confidence: classification.confidence,
        ai_intent: classification.intent,
        ai_response: result.response,
        tone_match_score: result.toneScore,
        digital_employee: 'front_desk'
      }).eq('id', messageId);

      // 6a. Log AI action
      await logAiAction(beautician.id, client?.id, messageId, classification, result);

      // 7a. Send the response
      await sendResponse(beautician, client, result.response, messageContent);

      logger.info({ handled: true, intent: classification.intent }, 'AI Front Desk handled message');
      return { handled: true, intent: classification.intent, response: result.response };

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


// ============================================================
// STEP 1: GATHER CONTEXT
// ============================================================

async function gatherContext(beautician, client) {
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Parallel fetches for speed
  const [treatments, upcomingAppointments, clientHistory, clientIntelligence] = await Promise.all([
    // Treatment menu
    supabase
      .from('treatments')
      .select('id, name, duration_minutes, price_cents, deposit_cents, category, contraindications')
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
      .single() : { data: null }
  ]);

  return {
    treatments: treatments.data || [],
    upcomingAppointments: upcomingAppointments.data || [],
    clientHistory: clientHistory.data || [],
    clientIntelligence: clientIntelligence.data,
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


// ============================================================
// STEP 2: CLASSIFY INTENT
// ============================================================

async function classifyIntent(message, context) {
  const treatmentNames = context.treatments.map(t => t.name).join(', ');

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: `You are an intent classifier for a beauty salon. Classify the customer's message into exactly one intent. Respond with JSON only.

Available treatments: ${treatmentNames}

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
    return JSON.parse(jsonStr);
  } catch (err) {
    logger.error({ err }, 'Classification parse error');
    return { intent: INTENTS.UNKNOWN, confidence: 0.0, extracted: {} };
  }
}


// ============================================================
// STEP 3: DECIDE
// ============================================================

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
    return `Low confidence (${(classification.confidence * 100).toFixed(0)}%) — not sure enough to respond autonomously`;
  }
  return `Intent "${classification.intent}" is not in the autonomous action list`;
}


// ============================================================
// STEP 4a: GENERATE RESPONSE + TAKE ACTION
// ============================================================

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

RULES:
- Keep it short. This is WhatsApp, not email. 1-3 sentences max.
- Never say you're an AI, bot, or assistant. You ARE the beautician.
- Use the beautician's name style (first name only, never "I am [Business Name]").
- Match their likely communication style: professional but warm, not overly casual.
- Include specific details (treatment names, prices, times) when relevant.
- If directing to booking, include the link: florrie.ai/book/${context.beautician.bookingSlug || 'book'}
- Never make up availability. Only reference times from the context provided.

${actionPrompt}

CONTEXT:
Treatments: ${context.treatments.map(t => `${t.name} (${t.duration_minutes}min, £${(t.price_cents/100).toFixed(2)})`).join(', ')}
${context.client ? `Client: ${context.client.name}, ${context.client.totalVisits || 0} previous visits` : 'New client'}
${context.clientIntelligence?.favourite_treatments?.length ? `Favourite treatments: ${context.clientIntelligence.favourite_treatments.join(', ')}` : ''}

Respond with the WhatsApp message only. No quotes, no JSON, no explanation.`,
    messages: [{ role: 'user', content: message }]
  });

  const replyText = response.content[0].text.trim();

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


// ============================================================
// STEP 4b: GENERATE SUGGESTED RESPONSE (for escalated messages)
// ============================================================

async function generateSuggestedResponse(message, classification, context, beautician) {
  const toneGuide = buildToneGuide(beautician.tone_model);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: `You are drafting a SUGGESTED reply for a beautician called ${context.beautician.name} to review before sending.

${toneGuide}

This message was escalated because: ${getEscalationReason(classification)}
The beautician will review and edit before sending.

Keep it short (WhatsApp style, 1-3 sentences). Be helpful but flag anything you're unsure about with [CHECK: ...].

Treatments: ${context.treatments.map(t => `${t.name} (£${(t.price_cents/100).toFixed(2)})`).join(', ')}

Respond with the suggested message only.`,
    messages: [{ role: 'user', content: message }]
  });

  return response.content[0].text.trim();
}


// ============================================================
// INTENT-SPECIFIC PROMPT BUILDERS
// ============================================================

function buildBookingPrompt(context, extracted) {
  const availableDays = getAvailableDays(context.upcomingAppointments, context.beautician.workingHours);

  return `The client wants to book an appointment.
${extracted?.treatment ? `They mentioned: "${extracted.treatment}"` : 'They haven\'t specified a treatment yet.'}
${extracted?.date ? `Preferred date: ${extracted.date}` : ''}
${extracted?.time ? `Preferred time: ${extracted.time}` : ''}

Available times in the next 7 days: ${availableDays.length > 0 ? availableDays.join(', ') : 'check booking page'}

If they've specified enough details, confirm and direct them to the booking link.
If they haven't specified a treatment, ask which one they'd like.
If their preferred time is taken, suggest the nearest available alternative.`;
}

function buildPricePrompt(context, extracted) {
  return `The client is asking about prices.
${extracted?.treatment ? `They asked about: "${extracted.treatment}"` : 'They didn\'t specify which treatment.'}

If they asked about a specific treatment, give the price directly.
If they asked generally, list the 2-3 most popular treatments with prices.
Keep it natural — don't list every treatment like a menu.`;
}

function buildReschedulePrompt(context, client, extracted) {
  return `The client wants to reschedule an existing appointment.
${extracted?.date ? `New preferred date: ${extracted.date}` : ''}

Check if they have an upcoming appointment. If so, confirm the change.
If you can't find their appointment, ask for more details.
Direct them to the booking link if needed.`;
}


// ============================================================
// TONE MODEL
// ============================================================

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
    return JSON.parse(jsonStr);
  } catch (err) {
    logger.warn({ err }, 'Tone pattern analysis parse error');
    return {};
  }
}


// ============================================================
// HELPERS
// ============================================================

function getAvailableDays(existingAppointments, workingHours) {
  // Simple availability summary for the next 7 days
  const days = [];
  const now = new Date();

  for (let i = 1; i <= 7; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() + i);
    const dayKey = date.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
    const hours = workingHours?.[dayKey];

    if (!hours) continue; // Not a working day

    const dateStr = date.toISOString().split('T')[0];
    const dayAppointments = existingAppointments.filter(a => a.starts_at.startsWith(dateStr));

    // Rough check: if fewer than 8 appointments, probably has availability
    if (dayAppointments.length < 8) {
      days.push(date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }));
    }
  }

  return days;
}

async function sendResponse(beautician, client, responseText, originalMessage) {
  // WhatsApp send
  if (beautician.whatsapp_phone_id && client?.whatsapp_id) {
    try {
      await fetch(`https://graph.facebook.com/v21.0/${beautician.whatsapp_phone_id}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: client.whatsapp_id,
          type: 'text',
          text: { body: responseText }
        })
      });
    } catch (err) {
      logger.error({ err }, 'WhatsApp send error');
    }
  }

  // Store outbound message
  await supabase.from('messages').insert({
    beautician_id: beautician.id,
    client_id: client?.id,
    channel: 'whatsapp',
    direction: 'outbound',
    content: responseText,
    ai_handled: true,
    ai_confidence: 1.0,
    digital_employee: 'front_desk'
  });
}

async function logAiAction(beauticianId, clientId, messageId, classification, result) {
  const actionTypeMap = {
    booking_request: 'booking_created',
    price_enquiry: 'message_replied',
    availability_check: 'message_replied',
    reschedule: 'booking_rescheduled',
    greeting: 'message_replied',
    review_thanks: 'message_replied'
  };

  const summaryMap = {
    booking_request: `Helped a client book an appointment`,
    price_enquiry: `Answered a price enquiry`,
    availability_check: `Checked availability for a client`,
    reschedule: `Handled a reschedule request`,
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
