/**
 * Voice Commander — full agentic control over the app via natural language.
 *
 * Accepts audio (base64) or text. Claude Haiku classifies intent and extracts
 * entities. Handlers then take REAL actions — not drafts, not suggestions.
 *
 * Supported intents:
 *   book_appointment      — create a booking (finds treatment + client)
 *   reschedule_appointment — move an existing appointment to a new slot
 *   cancel_appointment    — cancel and notify client
 *   check_schedule        — read today's or any day's appointments
 *   get_client_info       — look up a client's visit/spend history
 *   send_message          — actually send an SMS/WhatsApp/email to a client
 *   send_payment_link     — generate Stripe link and deliver to client
 *   add_note              — add to today's daily checklist
 *   block_time            — create a real hours_exception record
 *   unknown               — graceful fallback
 *
 * Compound commands ("reschedule AND send a payment link") are handled via
 * secondary_actions array in the Claude response.
 */
import { Router } from 'express';
import Stripe from 'stripe';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import { sendMessage } from '../services/notifications.js';
import { calculatePlatformFee } from '../lib/platform-fees.js';
import logger from '../lib/logger.js';

const router = Router();

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://florrie.ai';

// ─── POST /api/voice/command ────────────────────────────────────────────────
router.post('/command', requireAuth, async (req, res) => {
  const { audio_base64, text, mime_type } = req.body;

  if (!audio_base64 && !text) {
    return res.status(400).json({ error: 'Either audio_base64 or text is required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Voice commands require AI to be configured' });
  }

  try {
    const anthropic = new Anthropic();
    let parsed;

    if (audio_base64) {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: voiceSystemPrompt(),
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: mime_type || 'audio/webm', data: audio_base64 },
            },
            { type: 'text', text: 'Transcribe and extract the intent.' },
          ],
        }],
      });
      parsed = safeParseJSON(response.content[0].text.trim());
    } else {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: voiceSystemPrompt(),
        messages: [{ role: 'user', content: text }],
      });
      parsed = safeParseJSON(response.content[0].text.trim());
      parsed.transcript = text;
    }

    // Execute primary intent
    const primary = await handleIntent(req.beautician, parsed);

    // Execute secondary actions (e.g. "also send a payment link")
    const secondary = [];
    for (const sec of (parsed.secondary_actions || [])) {
      const secParsed = { ...parsed, intent: sec };
      try {
        const result = await handleIntent(req.beautician, secParsed);
        secondary.push(result);
      } catch (e) {
        logger.warn({ err: e }, `Secondary action ${sec} failed`);
      }
    }

    const messages = [primary.message, ...secondary.map(s => s.message)].filter(Boolean);

    res.json({
      transcript: parsed.transcript,
      intent: parsed.intent,
      confidence: parsed.confidence,
      action: {
        ...primary,
        message: messages.join('\n\n'),
        secondary,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Voice command failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

// ─── Intent dispatcher ──────────────────────────────────────────────────────
async function handleIntent(beautician, parsed) {
  const { intent, extracted = {} } = parsed;

  switch (intent) {

    // ── Find appointment for a client (shared utility) ──────────────────────
    // Used by reschedule + cancel

    case 'reschedule_appointment': {
      if (!extracted.client_name) {
        return { status: 'incomplete', message: "Who's appointment do you want to move?" };
      }
      if (!extracted.new_date && !extracted.new_time) {
        return { status: 'incomplete', message: 'What date or time should I move it to?' };
      }

      const client = await findClient(beautician.id, extracted.client_name);
      if (!client) return { status: 'not_found', message: `Can't find a client called "${extracted.client_name}".` };

      // Find their next upcoming appointment
      const { data: appts } = await supabase
        .from('appointments')
        .select('id, starts_at, duration_minutes, treatments(name)')
        .eq('beautician_id', beautician.id)
        .eq('client_id', client.id)
        .in('status', ['confirmed', 'pending'])
        .gte('starts_at', new Date().toISOString())
        .order('starts_at', { ascending: true })
        .limit(1);

      const appt = appts?.[0];
      if (!appt) {
        return { status: 'not_found', message: `${client.first_name} has no upcoming appointments to reschedule.` };
      }

      // Build new datetime
      const existing = new Date(appt.starts_at);
      const newDate = extracted.new_date || existing.toISOString().slice(0, 10);
      const newTime = extracted.new_time || existing.toTimeString().slice(0, 5);
      const newStart = new Date(`${newDate}T${newTime}:00`);

      if (isNaN(newStart.getTime())) {
        return { status: 'error', message: "Couldn't parse that date/time. Try again with a clearer date." };
      }

      const newEnd = new Date(newStart.getTime() + (appt.duration_minutes || 60) * 60000);

      await supabase
        .from('appointments')
        .update({ starts_at: newStart.toISOString(), ends_at: newEnd.toISOString() })
        .eq('id', appt.id);

      // Notify the client
      const treatmentName = appt.treatments?.name || 'your appointment';
      const friendlyDate = newStart.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      const friendlyTime = newStart.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      await sendMessage({
        client,
        body: `Hi ${client.first_name}! Just a quick update — your ${treatmentName} has been moved to ${friendlyDate} at ${friendlyTime}. See you then! 💕`,
        beauticianId: beautician.id,
        beauticianPrefs: beautician.client_reminder_prefs || {},
      }).catch(e => logger.warn({ err: e }, 'Reschedule notification failed'));

      return {
        status: 'ok',
        message: `Done — moved ${client.first_name}'s ${treatmentName} to ${friendlyDate} at ${friendlyTime}. Confirmation sent.`,
      };
    }

    case 'cancel_appointment': {
      if (!extracted.client_name) {
        return { status: 'incomplete', message: "Who's appointment do you want to cancel?" };
      }

      const client = await findClient(beautician.id, extracted.client_name);
      if (!client) return { status: 'not_found', message: `Can't find "${extracted.client_name}".` };

      const { data: appts } = await supabase
        .from('appointments')
        .select('id, starts_at, treatments(name)')
        .eq('beautician_id', beautician.id)
        .eq('client_id', client.id)
        .in('status', ['confirmed', 'pending'])
        .gte('starts_at', new Date().toISOString())
        .order('starts_at', { ascending: true })
        .limit(1);

      const appt = appts?.[0];
      if (!appt) {
        return { status: 'not_found', message: `${client.first_name} has no upcoming appointments to cancel.` };
      }

      await supabase
        .from('appointments')
        .update({ status: 'cancelled' })
        .eq('id', appt.id);

      const treatmentName = appt.treatments?.name || 'appointment';
      const friendlyDate = new Date(appt.starts_at).toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long',
      });

      // Notify client if they want
      if (extracted.notify_client !== false) {
        await sendMessage({
          client,
          body: `Hi ${client.first_name}, your ${treatmentName} on ${friendlyDate} has been cancelled. Get in touch if you'd like to rebook 💕`,
          beauticianId: beautician.id,
          beauticianPrefs: beautician.client_reminder_prefs || {},
        }).catch(e => logger.warn({ err: e }, 'Cancel notification failed'));
      }

      return {
        status: 'ok',
        message: `${client.first_name}'s ${treatmentName} on ${friendlyDate} has been cancelled${extracted.notify_client !== false ? ' and they've been notified' : ''}.`,
      };
    }

    case 'book_appointment': {
      if (!extracted.client_name) {
        return { status: 'incomplete', message: 'Who do you want to book?' };
      }

      const client = await findClient(beautician.id, extracted.client_name);
      if (!client) return { status: 'not_found', message: `Can't find "${extracted.client_name}" in your clients.` };

      if (!extracted.date || !extracted.time) {
        return {
          status: 'incomplete',
          message: `Found ${client.first_name}. What date and time do you want to book?`,
        };
      }

      // Find treatment
      let treatmentId = null;
      let treatmentName = extracted.treatment || 'Appointment';
      let durationMins = 60;
      let priceCents = 0;

      if (extracted.treatment) {
        const { data: treatments } = await supabase
          .from('treatments')
          .select('id, name, duration_minutes, price_cents')
          .eq('beautician_id', beautician.id)
          .ilike('name', `%${extracted.treatment}%`)
          .limit(1);

        if (treatments?.[0]) {
          treatmentId = treatments[0].id;
          treatmentName = treatments[0].name;
          durationMins = treatments[0].duration_minutes || 60;
          priceCents = treatments[0].price_cents || 0;
        }
      }

      const startsAt = new Date(`${extracted.date}T${extracted.time}:00`);
      const endsAt = new Date(startsAt.getTime() + durationMins * 60000);

      const { data: newAppt, error } = await supabase
        .from('appointments')
        .insert({
          beautician_id: beautician.id,
          client_id: client.id,
          treatment_id: treatmentId,
          starts_at: startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
          status: 'confirmed',
          price_cents: priceCents,
          source: 'voice_command',
        })
        .select('id')
        .single();

      if (error) {
        logger.error({ err: error }, 'Voice book appointment insert failed');
        return { status: 'error', message: 'Something went wrong creating the booking.' };
      }

      const friendlyDate = startsAt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      const friendlyTime = startsAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      // Send confirmation to client
      await sendMessage({
        client,
        body: `Hi ${client.first_name}! Your ${treatmentName} is confirmed for ${friendlyDate} at ${friendlyTime}. Can't wait to see you 💕`,
        beauticianId: beautician.id,
        beauticianPrefs: beautician.client_reminder_prefs || {},
      }).catch(e => logger.warn({ err: e }, 'Booking confirmation send failed'));

      return {
        status: 'ok',
        message: `Booked ${client.first_name} in for ${treatmentName} on ${friendlyDate} at ${friendlyTime}. Confirmation sent.`,
        appointmentId: newAppt?.id,
      };
    }

    case 'check_schedule': {
      const targetDate = extracted.date || new Date().toISOString().slice(0, 10);
      const { data: appointments } = await supabase
        .from('appointments')
        .select('starts_at, clients(first_name), treatments(name), status')
        .eq('beautician_id', beautician.id)
        .gte('starts_at', `${targetDate}T00:00:00`)
        .lte('starts_at', `${targetDate}T23:59:59`)
        .in('status', ['confirmed', 'pending'])
        .order('starts_at', { ascending: true });

      if (!appointments?.length) {
        const dayName = new Date(targetDate).toLocaleDateString('en-GB', { weekday: 'long' });
        return { status: 'empty', message: `Nothing booked for ${dayName}.` };
      }

      const lines = appointments.map(a => {
        const t = new Date(a.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        return `${t} — ${a.clients?.first_name || 'Client'} (${a.treatments?.name || 'Treatment'})`;
      });

      const dayName = new Date(targetDate).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      return {
        status: 'ok',
        message: `${dayName}:\n${lines.join('\n')}`,
        count: appointments.length,
      };
    }

    case 'get_client_info': {
      if (!extracted.client_name) {
        return { status: 'incomplete', message: "Which client do you want info on?" };
      }

      const client = await findClient(beautician.id, extracted.client_name);
      if (!client) return { status: 'not_found', message: `Can't find "${extracted.client_name}".` };

      const { data: appts } = await supabase
        .from('appointments')
        .select('starts_at, price_cents, status, treatments(name)')
        .eq('beautician_id', beautician.id)
        .eq('client_id', client.id)
        .order('starts_at', { ascending: false })
        .limit(20);

      const completed = (appts || []).filter(a => a.status === 'completed');
      const totalSpend = completed.reduce((s, a) => s + (a.price_cents || 0), 0);
      const lastVisit = completed[0]?.starts_at;
      const upcoming = (appts || []).find(a => a.status === 'confirmed' || a.status === 'pending');

      const lastVisitStr = lastVisit
        ? new Date(lastVisit).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
        : 'never';
      const upcomingStr = upcoming
        ? `${new Date(upcoming.starts_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} (${upcoming.treatments?.name || 'appointment'})`
        : 'none booked';

      return {
        status: 'ok',
        message: `${client.first_name} ${client.last_name || ''}:\n• ${completed.length} visits · £${(totalSpend / 100).toFixed(2)} total spend\n• Last visit: ${lastVisitStr}\n• Next: ${upcomingStr}`,
        clientId: client.id,
      };
    }

    case 'send_message': {
      if (!extracted.client_name || !extracted.message) {
        return { status: 'incomplete', message: "Who should I message and what should I say?" };
      }

      const client = await findClient(beautician.id, extracted.client_name);
      if (!client) return { status: 'not_found', message: `Can't find "${extracted.client_name}".` };

      await sendMessage({
        client,
        body: extracted.message,
        beauticianId: beautician.id,
        beauticianPrefs: beautician.client_reminder_prefs || {},
      });

      return {
        status: 'ok',
        message: `Message sent to ${client.first_name}: "${extracted.message}"`,
      };
    }

    case 'send_payment_link': {
      if (!extracted.client_name) {
        return { status: 'incomplete', message: "Who do you want to send a payment link to?" };
      }

      const client = await findClient(beautician.id, extracted.client_name);
      if (!client) return { status: 'not_found', message: `Can't find "${extracted.client_name}".` };

      const amountCents = extracted.amount_pence || extracted.amount_cents || 1000; // default £10
      const description = extracted.description || `Payment to ${beautician.business_name || beautician.first_name}`;

      // Generate Stripe payment link if Stripe is connected
      let paymentUrl = null;
      if (stripe && beautician.stripe_account_id && beautician.stripe_onboarding_complete) {
        try {
          const platformFee = calculatePlatformFee(amountCents);
          const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: [{
              price_data: {
                currency: 'gbp',
                product_data: { name: description },
                unit_amount: amountCents,
              },
              quantity: 1,
            }],
            payment_intent_data: {
              application_fee_amount: platformFee,
              transfer_data: { destination: beautician.stripe_account_id },
              metadata: {
                beautician_id: beautician.id,
                client_id: client.id,
                type: 'voice_payment_link',
              },
            },
            success_url: `${FRONTEND_URL}/pay/success`,
            cancel_url: `${FRONTEND_URL}/pay/cancelled`,
            metadata: { beautician_id: beautician.id, client_id: client.id, type: 'payment_link' },
          });

          paymentUrl = session.url;

          await supabase.from('payment_links').insert({
            beautician_id: beautician.id,
            client_id: client.id,
            amount_cents: amountCents,
            description,
            stripe_session_id: session.id,
            url: paymentUrl,
            status: 'pending',
          }).catch(() => {});
        } catch (e) {
          logger.error({ err: e }, 'Stripe payment link creation failed in voice handler');
        }
      }

      // Send to client (with or without real link)
      const amountStr = `£${(amountCents / 100).toFixed(2)}`;
      const bizName = beautician.business_name || beautician.first_name;

      if (paymentUrl) {
        await sendMessage({
          client,
          body: `Hi ${client.first_name}! Here's your payment link for ${amountStr} to ${bizName}:\n${paymentUrl}\n\nThanks! 💕`,
          beauticianId: beautician.id,
          beauticianPrefs: beautician.client_reminder_prefs || {},
        });

        return {
          status: 'ok',
          message: `Payment link for ${amountStr} sent to ${client.first_name}.`,
          paymentUrl,
        };
      } else {
        // Stripe not connected — still message the client and flag it
        return {
          status: 'partial',
          message: `Stripe isn't connected yet so I can't generate a link automatically. Connect Stripe in Settings → Payments and try again.`,
        };
      }
    }

    case 'add_note': {
      if (!extracted.note) {
        return { status: 'incomplete', message: "What's the note?" };
      }

      const today = new Date().toISOString().slice(0, 10);
      await supabase.from('daily_checklists').insert({
        beautician_id: beautician.id,
        date: today,
        items: [{ text: extracted.note, done: false }],
        done: false,
      });

      return { status: 'ok', message: `Added to today's checklist: "${extracted.note}"` };
    }

    case 'block_time': {
      const blockDate = extracted.date || new Date().toISOString().slice(0, 10);
      const reason = extracted.reason || 'personal';

      const insertData = {
        beautician_id: beautician.id,
        date: blockDate,
        type: 'closed',
        reason,
        note: extracted.note || null,
        notify_clients: false,
      };

      if (extracted.time && extracted.end_time) {
        insertData.type = 'amended';
        insertData.start_time = extracted.time;
        insertData.end_time = extracted.end_time;
      } else if (extracted.time) {
        // Block from that time to end of day
        insertData.type = 'amended';
        insertData.start_time = extracted.time;
        insertData.end_time = '18:00';
      }

      const { error } = await supabase.from('hours_exceptions').insert(insertData);

      if (error) {
        logger.error({ err: error }, 'Block time insert failed');
        return { status: 'error', message: 'Could not block that time — something went wrong.' };
      }

      const friendlyDate = new Date(blockDate).toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long',
      });
      const timeStr = extracted.time ? ` from ${extracted.time}` : '';
      return { status: 'ok', message: `Blocked${timeStr} on ${friendlyDate}.` };
    }

    default:
      return {
        status: 'unknown',
        message: `I caught "${parsed.transcript}" but wasn't sure what to do with it. Try something like "move Sarah's appointment to Thursday" or "what's my schedule today?"`,
      };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function findClient(beauticianId, name) {
  const { data } = await supabase
    .from('clients')
    .select('id, first_name, last_name, phone, email')
    .eq('beautician_id', beauticianId)
    .ilike('first_name', `%${name}%`)
    .limit(1);
  return data?.[0] || null;
}

function safeParseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { transcript: text, intent: 'unknown', extracted: {}, secondary_actions: [], confidence: 0.5 };
  }
}

function voiceSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are a voice command processor for Florrie, a beauty salon AI assistant.
Today's date is ${today}.

Extract the intent and all relevant details from the command. Handle compound commands by putting the primary action in "intent" and additional actions in "secondary_actions".

Respond ONLY with valid JSON — no explanation, no markdown:
{
  "transcript": "the full spoken text",
  "intent": "reschedule_appointment|cancel_appointment|book_appointment|check_schedule|get_client_info|send_message|send_payment_link|add_note|block_time|unknown",
  "secondary_actions": ["send_payment_link"],
  "extracted": {
    "client_name": "first name only if mentioned",
    "treatment": "treatment name if mentioned",
    "date": "YYYY-MM-DD resolved from relative terms (today, tomorrow, next Thursday)",
    "time": "HH:MM in 24h format",
    "new_date": "YYYY-MM-DD for reschedule target",
    "new_time": "HH:MM for reschedule target",
    "end_time": "HH:MM if a range is mentioned",
    "amount_pence": 0,
    "description": "payment description if mentioned",
    "message": "exact message text to send if asking to send a message",
    "note": "note text if adding a note",
    "reason": "holiday|sick|personal|training|event|other for blocks"
  },
  "confidence": 0.0
}

Examples:
- "Move Sarah's appointment to Thursday 2pm" → intent: reschedule_appointment, client_name: Sarah, new_date: ${getNextThursday(today)}, new_time: 14:00
- "Book Megan in for HD Brows on Friday at 11" → intent: book_appointment, client_name: Megan, treatment: HD Brows, date: [next Friday], time: 11:00
- "What's my schedule today?" → intent: check_schedule, date: ${today}
- "Send a £30 payment link to Emma for her deposit" → intent: send_payment_link, client_name: Emma, amount_pence: 3000, description: deposit
- "Reschedule Daisy to Monday and send her a payment link for £20" → intent: reschedule_appointment, secondary_actions: [send_payment_link], client_name: Daisy, new_date: [next Monday], amount_pence: 2000
- "Block out Friday afternoon" → intent: block_time, date: [next Friday], time: 12:00, end_time: 18:00, reason: personal
- "What can you tell me about Shauna?" → intent: get_client_info, client_name: Shauna
- "Send Chloe a message saying her slot has changed" → intent: send_message, client_name: Chloe, message: Hi Chloe! Just to let you know your slot has changed — get in touch to confirm a new time 💕`;
}

function getNextThursday(todayStr) {
  const d = new Date(todayStr);
  const day = d.getDay();
  const daysUntilThursday = (4 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilThursday);
  return d.toISOString().slice(0, 10);
}

export default router;
