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
import { requireAuth } from '../middleware/auth.js';
import { processVoiceCommand } from '../services/voice-orchestrator.js';
import logger from '../lib/logger.js';
import { supabase } from '../index.js';

const router = Router();

router.post('/command', requireAuth, async (req, res) => {
  const { audio_base64, text, mime_type } = req.body;

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
    return res.status(500).json({ error: err.message || 'Something went wrong' });
  }
});

export default router;
