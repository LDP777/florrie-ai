/**
 * Voice Orchestrator — Claude as an agentic tool-caller.
 *
 * Instead of intent classification → hardcoded switch, we give Claude the full
 * tool library and let it compose whatever sequence of actions it needs.
 *
 * Flow:
 *   1. User says something (text or transcribed audio)
 *   2. We send Claude the tools + today's context + the utterance
 *   3. Claude returns one or more tool_use blocks
 *   4. We execute each tool (real DB writes, real messages)
 *   5. Tool results are fed back to Claude
 *   6. Claude returns a final human-readable summary
 *   7. We return that to the frontend
 *
 * This supports arbitrarily complex compound commands:
 *   "Block next week for half term, message everyone booked those days, and
 *    also show me who I haven't seen in two months"
 *   → Claude calls: block_date_range + send_bulk_message + get_lapsed_clients
 */

import Anthropic from '@anthropic-ai/sdk';
import { TOOL_DEFINITIONS, executeTool, findClient } from './voice-tools.js';
import logger from '../lib/logger.js';

const MAX_TOOL_ROUNDS = 5; // Safety limit on agentic loops

/**
 * Process a voice command end-to-end.
 *
 * @param {string|null} audioBase64 — raw audio as base64 (null if text input)
 * @param {string|null} text — direct text input (null if audio)
 * @param {string|null} mimeType — audio MIME type if audio provided
 * @param {object} beautician — authenticated beautician record
 * @param {object} supabase — supabase client
 * @returns {{ transcript, reply, actions, status }}
 */
export async function processVoiceCommand({ audioBase64, text, mimeType, beautician, supabase }) {
  const anthropic = new Anthropic();
  const today = new Date().toISOString().slice(0, 10);

  // ── Step 1: Get transcript (if audio) ─────────────────────────────────────
  let transcript = text;

  if (audioBase64) {
    try {
      const transcriptResp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: mimeType || 'audio/webm', data: audioBase64 },
            },
            { type: 'text', text: 'Transcribe this audio exactly. Return only the transcription, no other text.' },
          ],
        }],
      });
      transcript = transcriptResp.content[0]?.text?.trim() || '';
    } catch (err) {
      logger.error({ err }, 'Audio transcription failed');
      throw new Error('Could not transcribe the audio. Try again or type the command.');
    }
  }

  if (!transcript) {
    return { transcript: '', reply: "I didn't catch that — try speaking again.", actions: [], status: 'empty' };
  }

  // ── Step 2: Agentic tool-calling loop ──────────────────────────────────────
  const systemPrompt = buildSystemPrompt(beautician, today);
  const messages = [{ role: 'user', content: transcript }];

  const executedActions = [];
  let finalReply = null;
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;

    let response;
    try {
      response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        tools: TOOL_DEFINITIONS,
        messages,
      });
    } catch (apiErr) {
      // Anthropic SDK errors (billing, rate limits, invalid key, etc.)
      const status = apiErr?.status || 500;
      if (status === 400 && apiErr.message?.includes('credit balance')) {
        logger.error({ err: apiErr }, 'Anthropic API credit balance exhausted');
        throw new Error('AI_CREDITS_EXHAUSTED');
      } else if (status === 429) {
        logger.error({ err: apiErr }, 'Anthropic API rate limited');
        throw new Error('AI_RATE_LIMITED');
      } else {
        logger.error({ err: apiErr }, 'Anthropic API call failed');
        throw new Error('AI_UNAVAILABLE');
      }
    }

    // If Claude wants to use tools
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    if (toolUseBlocks.length === 0) {
      // Claude returned a text response — we're done
      const textBlock = response.content.find(b => b.type === 'text');
      finalReply = textBlock?.text?.trim() || "Done.";
      break;
    }

    // Execute all tool calls in this round
    const toolResults = [];

    for (const toolCall of toolUseBlocks) {
      logger.info({ toolName: toolCall.name, input: toolCall.input }, 'Executing voice tool');

      const result = await executeTool(toolCall.name, toolCall.input, beautician, supabase);

      executedActions.push({
        tool: toolCall.name,
        input: toolCall.input,
        result: result.result,
        data: result.data,
      });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: result.result,
      });
    }

    // Add Claude's response and the tool results to the conversation
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    // If stop_reason is end_turn after tools, Claude may want another round
    if (response.stop_reason === 'end_turn') {
      // Extract any trailing text from the last assistant response
      const lastText = response.content.find(b => b.type === 'text');
      if (lastText?.text?.trim()) {
        finalReply = lastText.text.trim();
      }
      break;
    }
  }

  // ── Step 3: If no final text from Claude, synthesise from action results ───
  if (!finalReply) {
    if (executedActions.length === 1) {
      finalReply = executedActions[0].result;
    } else if (executedActions.length > 1) {
      finalReply = executedActions.map(a => a.result).join('\n\n');
    } else {
      finalReply = "I'm not sure what to do with that. Try something like 'what's my schedule today?' or 'block next week for a holiday'.";
    }
  }

  return {
    transcript,
    reply: finalReply,
    actions: executedActions,
    status: executedActions.length > 0 ? 'ok' : 'unknown',
  };
}

// ─── System prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(beautician, today) {
  const name = beautician.first_name || 'the beautician';
  const bizName = beautician.business_name || `${name}'s salon`;

  // Compute useful relative dates for Claude
  const dates = computeRelativeDates(today);

  return `You are Florrie, an AI assistant for ${bizName} (run by ${name}).
Today is ${today} (${new Date(`${today}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}).

Useful dates:
- Tomorrow: ${dates.tomorrow}
- This Monday: ${dates.thisMonday}
- Next Monday: ${dates.nextMonday}
- This Friday: ${dates.thisFriday}
- Next Friday: ${dates.nextFriday}
- Start of this week: ${dates.startOfWeek}
- End of this week: ${dates.endOfWeek}
- Start of next week: ${dates.startOfNextWeek}
- End of next week: ${dates.endOfNextWeek}
- Start of this month: ${dates.startOfMonth}
- End of this month: ${dates.endOfMonth}

You have access to tools that let you take real actions in the salon management system. Use them to help ${name} run their business.

IMPORTANT RULES:
1. Always use tools to take the real action — don't just describe what you'd do.
2. For compound requests ("block next week AND message everyone booked"), call multiple tools.
3. For holiday/time-off ranges, use block_date_range (not repeated block_date calls).
4. For "everyone booked next week", use send_bulk_message with segment "booked_next_week".
5. After tools complete, give a brief, friendly confirmation of what was done.
6. Resolve relative dates (today, tomorrow, next Thursday, etc.) using the dates above.
7. If something is ambiguous, make a sensible assumption and do it — don't ask for clarification unless truly impossible.
8. Keep your final response concise and warm — this appears in a small voice UI.
9. NEVER mention tool names in your response to the user.

Examples of good compound commands you should handle:
- "Book Megan in for HD Brows next Thursday at 11 and send her a payment link for £20" → book_appointment + send_payment_link
- "Block the 14th to 21st for a holiday and let everyone booked that week know" → block_date_range + send_bulk_message
- "Cancel Sarah's appointment and message her with a rebook link" → cancel_appointment + send_rebook_reminder
- "How much did I make last month and who are my top 5 clients?" → get_revenue_summary + get_top_clients
- "Who haven't I seen in a while? Send them all a message saying I'd love to see them back" → get_lapsed_clients + send_bulk_message`;
}

function computeRelativeDates(todayStr) {
  const today = new Date(`${todayStr}T12:00:00`);
  const iso = d => d.toISOString().slice(0, 10);

  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);

  // Monday of current week
  const startOfWeek = new Date(today);
  const dayOfWeek = today.getDay(); // 0=Sun
  const daysToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  startOfWeek.setDate(today.getDate() + daysToMon);

  const endOfWeek = new Date(startOfWeek); endOfWeek.setDate(startOfWeek.getDate() + 6);

  const startOfNextWeek = new Date(startOfWeek); startOfNextWeek.setDate(startOfWeek.getDate() + 7);
  const endOfNextWeek = new Date(startOfNextWeek); endOfNextWeek.setDate(startOfNextWeek.getDate() + 6);

  // This Friday
  const thisFriday = new Date(startOfWeek); thisFriday.setDate(startOfWeek.getDate() + 4);
  const nextFriday = new Date(thisFriday); nextFriday.setDate(thisFriday.getDate() + 7);

  // This Monday (same as startOfWeek if we haven't passed it)
  const thisMonday = new Date(startOfWeek);
  const nextMonday = new Date(startOfNextWeek);

  // Month bounds
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  return {
    tomorrow: iso(tomorrow),
    thisMonday: iso(thisMonday),
    nextMonday: iso(nextMonday),
    thisFriday: iso(thisFriday),
    nextFriday: iso(nextFriday),
    startOfWeek: iso(startOfWeek),
    endOfWeek: iso(endOfWeek),
    startOfNextWeek: iso(startOfNextWeek),
    endOfNextWeek: iso(endOfNextWeek),
    startOfMonth: iso(startOfMonth),
    endOfMonth: iso(endOfMonth),
  };
}
