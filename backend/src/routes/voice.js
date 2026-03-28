import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import logger from '../lib/logger.js';

const router = Router();

const voiceCommandSchema = z.object({
  audio_base64: z.string().optional().nullable(),
  text: z.string().max(5000).optional().nullable(),
}).refine(
  (data) => data.audio_base64 || data.text,
  { message: 'Either audio_base64 or text is required' }
);

/**
 * POST /api/voice/command
 * Process a voice command or text input
 * Body: {
 *   audio_base64?: string,
 *   text?: string
 * }
 *
 * Response: {
 *   intent: string,
 *   response: string,
 *   actions: array
 * }
 */
router.post('/command', requireAuth, validate(voiceCommandSchema), async (req, res) => {
  try {
    const { audio_base64, text } = req.body;

    // Log the incoming command for future implementation
    logger.info(
      { beautician_id: req.beautician.id, has_audio: !!audio_base64, has_text: !!text },
      'Voice command received'
    );

    // Stub response for now
    // In the future, this will:
    // 1. If audio_base64: transcribe using Whisper or similar
    // 2. Pass transcription to Claude for intent detection
    // 3. Route to appropriate agent (calendar, clients, campaigns, money, content, settings)
    // 4. Execute the action and return result
    const response = {
      intent: 'unknown',
      response: 'Voice commands coming soon. In the meantime, use the UI to manage your business.',
      actions: [],
      debug: {
        received_audio: !!audio_base64,
        received_text: !!text,
        text_preview: text ? text.substring(0, 50) : null,
      },
    };

    res.json(response);
  } catch (err) {
    logger.error({ err }, 'Voice command error');
    res.status(500).json({ error: 'Failed to process voice command' });
  }
});

export default router;
