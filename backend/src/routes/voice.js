/**
 * Voice Commander — transcribe audio via Claude, route to intent handlers.
 *
 * The beautician can speak a command ("book Sarah in for brows on Thursday")
 * and the system transcribes it, classifies the intent, and takes action.
 *
 * Accepts audio as base64 or text fallback. Uses Claude's multimodal
 * capabilities for transcription and intent extraction in a single call.
 */
import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { createBookingSuggestion } from '../services/automations.js';

const router = Router();

const VOICE_INTENTS = {
  book_appointment: 'book_appointment',
  check_schedule: 'check_schedule',
  send_message: 'send_message',
  add_note: 'add_note',
  block_time: 'block_time',
  unknown: 'unknown',
};

/**
 * POST /api/voice/command
 * Body: { audio_base64?: string, text?: string, mime_type?: string }
 */
router.post('/command', requireAuth, async (req, res) => {
  const { audio_base64, text, mime_type } = req.body;

  if (!audio_base64 && !text) {
    return res.status(400).json({ error: 'Either audio_base64 or text is required' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Voice commands require AI configuration' });
  }

  try {
    const anthropic = new Anthropic();
    let parsed;

    if (audio_base64) {
      // Transcribe + extract intent in one Claude call
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: voiceSystemPrompt(),
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: mime_type || 'audio/webm',
                data: audio_base64,
              },
            },
            { type: 'text', text: 'Transcribe this voice command and extract the intent.' },
          ],
        }],
      });

      parsed = safeParseJSON(response.content[0].text.trim());
    } else {
      // Text input — just classify the intent
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: voiceSystemPrompt(),
        messages: [{ role: 'user', content: text }],
      });

      parsed = safeParseJSON(response.content[0].text.trim());
      parsed.transcript = text;
    }

    // Act on the intent
    const result = await handleVoiceIntent(req.beautician, parsed);

    res.json({
      transcript: parsed.transcript,
      intent: parsed.intent,
      confidence: parsed.confidence,
      action: result,
    });
  } catch (err) {
    logger.error({ err }, 'Voice command processing failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

function voiceSystemPrompt() {
  return `You are a voice command processor for a beauty salon booking system.
Transcribe the audio (if present) and extract the intent.

Respond ONLY with valid JSON:
{
  "transcript": "the spoken text",
  "intent": "book_appointment|check_schedule|send_message|add_note|block_time|unknown",
  "extracted": {
    "client_name": "if mentioned",
    "treatment": "if mentioned",
    "date": "YYYY-MM-DD if mentioned",
    "time": "HH:MM if mentioned",
    "message": "if sending a message",
    "note": "if adding a note"
  },
  "confidence": 0.0-1.0
}`;
}

function safeParseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { transcript: text, intent: 'unknown', extracted: {}, confidence: 0.5 };
  }
}

async function handleVoiceIntent(beautician, parsed) {
  const { intent, extracted } = parsed;

  switch (intent) {
    case VOICE_INTENTS.book_appointment: {
      if (!extracted?.client_name || !extracted?.treatment) {
        return { status: 'incomplete', message: 'I heard you but need a client name and treatment to book.' };
      }

      // Look up client by name
      const { data: clients } = await supabase
        .from('clients')
        .select('id, first_name, last_name')
        .eq('beautician_id', beautician.id)
        .ilike('first_name', `%${extracted.client_name}%`)
        .limit(5);

      const client = clients?.[0];
      if (!client) {
        return { status: 'not_found', message: `Couldn't find a client called "${extracted.client_name}".` };
      }

      // Suggest-and-confirm — not auto-book
      const suggestion = await createBookingSuggestion({
        beauticianId: beautician.id,
        clientId: client.id,
        treatmentName: extracted.treatment,
        suggestedDate: extracted.date || null,
        suggestedTime: extracted.time || null,
        source: 'voice_command',
      });

      return {
        status: 'suggested',
        message: `Booking suggestion created for ${client.first_name} (${extracted.treatment}). Check your dashboard to confirm.`,
        suggestionId: suggestion?.id,
      };
    }

    case VOICE_INTENTS.check_schedule: {
      const targetDate = extracted?.date || new Date().toISOString().slice(0, 10);
      const dayStart = `${targetDate}T00:00:00`;
      const dayEnd = `${targetDate}T23:59:59`;

      const { data: appointments } = await supabase
        .from('appointments')
        .select('starts_at, clients(first_name), treatments(name)')
        .eq('beautician_id', beautician.id)
        .gte('starts_at', dayStart)
        .lte('starts_at', dayEnd)
        .in('status', ['confirmed', 'pending'])
        .order('starts_at', { ascending: true });

      if (!appointments?.length) {
        return { status: 'empty', message: `Nothing booked for ${targetDate}.` };
      }

      const summary = appointments.map(a => {
        const time = new Date(a.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        return `${time} — ${a.clients?.first_name || 'Client'} (${a.treatments?.name || 'Treatment'})`;
      }).join('\n');

      return { status: 'ok', message: `Schedule for ${targetDate}:\n${summary}`, count: appointments.length };
    }

    case VOICE_INTENTS.send_message: {
      if (!extracted?.client_name || !extracted?.message) {
        return { status: 'incomplete', message: 'I need a client name and message to send.' };
      }
      // Surface as draft — don't auto-send from voice
      return {
        status: 'draft',
        message: `Draft message to ${extracted.client_name}: "${extracted.message}" — confirm on your dashboard to send.`,
        draft: { client: extracted.client_name, text: extracted.message },
      };
    }

    case VOICE_INTENTS.add_note: {
      if (!extracted?.note) {
        return { status: 'incomplete', message: "I didn't catch the note content." };
      }

      const today = new Date().toISOString().slice(0, 10);
      await supabase.from('daily_checklists').insert({
        beautician_id: beautician.id,
        date: today,
        items: [{ text: extracted.note, done: false }],
        done: false,
      });

      return { status: 'ok', message: `Note added to today's checklist: "${extracted.note}"` };
    }

    case VOICE_INTENTS.block_time: {
      if (!extracted?.date || !extracted?.time) {
        return { status: 'incomplete', message: 'I need a date and time to block off.' };
      }
      return {
        status: 'draft',
        message: `Block ${extracted.date} at ${extracted.time} — confirm on your dashboard.`,
        draft: { date: extracted.date, time: extracted.time },
      };
    }

    default:
      return { status: 'unknown', message: `I heard: "${parsed.transcript}" but I'm not sure what to do with it.` };
  }
}

export default router;
