/**
 * Voice Commander Route — thin layer over the voice orchestrator.
 *
 * POST /api/voice/command
 *   Body: { text?: string, audio_base64?: string, mime_type?: string }
 *   Response: { transcript, reply, actions, status }
 *
 * The orchestrator handles all logic: transcription, tool-calling, execution.
 * This file is intentionally minimal.
 */
import { Router } from 'express';
import { executeTool } from '../services/voice-tools.js';
import { requireAuth } from '../middleware/auth.js';
import { processVoiceCommand, CONFIRM_REQUIRED } from '../services/voice-orchestrator.js';
import logger from '../lib/logger.js';
import { COMMANDER_TASKS, processCommanderTask } from '../services/commander-tasks.js';
import { supabase } from '../config.js';

const router = Router();

router.post('/command', requireAuth, async (req, res) => {
  const { audio_base64, text, mime_type, task_id } = req.body || {};

  if (task_id != null) {
    if (typeof task_id !== 'string' || !Object.hasOwn(COMMANDER_TASKS, task_id)) return res.status(400).json({ error: 'Unknown Commander task' });
    res.set('Cache-Control', 'no-store');
    try {
      return res.json(await processCommanderTask({ taskId: task_id, beautician: req.beautician, supabase }));
    } catch (err) {
      logger.warn({ taskId: task_id, message: err.message }, 'Commander task read failed');
      return res.status(503).json({ error: 'I could not check all the records for this task. Nothing was changed. Please try again.' });
    }
  }

  if (!audio_base64 && !text) {
    return res.status(400).json({ error: 'Either audio_base64 or text is required' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Voice commands require AI to be configured' });
  }

  try {
    const result = await processVoiceCommand({
      audioBase64: audio_base64 || null,
      text: text || null,
      mimeType: mime_type || 'audio/webm',
      beautician: req.beautician,
      supabase,
    });

    return res.json(result);
  } catch (err) {
    logger.error({ err }, 'Voice command route failed');

    // Map typed errors to friendly responses
    const friendlyErrors = {
      AI_CREDITS_EXHAUSTED: "I'm temporarily offline. The AI service needs topping up, please try again later.",
      AI_RATE_LIMITED: "I'm a bit overloaded right now. Give me a moment and try again.",
      AI_UNAVAILABLE: "I couldn't connect to my brain just now. Try again in a moment.",
    };

    const friendly = friendlyErrors[err.message];
    if (friendly) {
      return res.status(503).json({ error: friendly });
    }

    return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
  }
});

/**
 * POST /api/voice/execute
 * Runs ONE previously-proposed consequential tool after the beautician tapped
 * the visual confirm card. Only tools on the confirm list are accepted here.
 * Body: { tool: string, input: object }
 */
router.post('/execute', requireAuth, async (req, res) => {
  const { tool, input } = req.body || {};
  if (!tool || !CONFIRM_REQUIRED.has(tool)) {
    return res.status(400).json({ error: 'Unknown or non-confirmable tool' });
  }
  try {
    const result = await executeTool(tool, input || {}, req.beautician, supabase);
    res.json({ result: result.result, data: result.data || null });
  } catch (err) {
    logger.error({ err, tool }, 'voice execute failed');
    res.status(500).json({ error: 'Could not do that. Try again.' });
  }
});

export default router;
