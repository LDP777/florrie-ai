import { Router } from 'express';
import { supabase } from '../config.js';
import { apiLimiter } from '../middleware/rate-limit.js';
import { verifyTurnstile } from '../middleware/turnstile.js';
import { sendEmail } from '../services/notifications.js';
import logger from '../lib/logger.js';
import { waitlistSchema } from '../lib/schemas.js';

const router = Router();

/**
 * POST /api/waitlist
 * Public endpoint to add email to the waitlist.
 * Accepts: { email, name?, source? }
 * Returns: { success: true, message: "You're on the list!" }
 */
router.post('/', apiLimiter, verifyTurnstile, async (req, res) => {
  try {
    // Validate request body
    const { email, name, source } = waitlistSchema.parse(req.body);

    // Upsert into waitlist_signups (don't duplicate on email)
    const { data, error } = await supabase
      .from('waitlist_signups')
      .upsert(
        {
          email,
          name,
          source,
          signed_up_at: new Date().toISOString(),
        },
        { onConflict: 'email' }
      )
      .select();

    if (error) {
      logger.error({ err: error }, 'Failed to insert waitlist signup');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // Send notification email to admin
    const adminSubject = `New Florrie waitlist signup: ${email}`;
    const adminHtml = `
      <h2>New Florrie Waitlist Signup</h2>
      <p><strong>Email:</strong> ${email}</p>
      ${name ? `<p><strong>Name:</strong> ${name}</p>` : ''}
      ${source ? `<p><strong>Source:</strong> ${source}</p>` : ''}
      <p><strong>Signed up at:</strong> ${new Date().toISOString()}</p>
    `;
    const adminText = `
New Florrie Waitlist Signup
Email: ${email}
${name ? `Name: ${name}` : ''}
${source ? `Source: ${source}` : ''}
Signed up at: ${new Date().toISOString()}
    `.trim();

    await sendEmail({
      to: 'levipither7@gmail.com',
      subject: adminSubject,
      html: adminHtml,
      text: adminText,
    });

    // Send confirmation email to the signup
    const confirmSubject = "You're on the Florrie waitlist!";
    const confirmHtml = `
      <h2>Welcome to the Florrie Waitlist</h2>
      <p>Thanks for signing up, ${name || 'friend'}!</p>
      <p>You're now on the waitlist for early access to Florrie — the AI-powered salon management platform.</p>
      <p>We'll be in touch soon with updates and exclusive early-access opportunities.</p>
      <p style="color: #666; font-size: 12px; margin-top: 20px;">
        <strong>Florrie</strong><br/>
        The future of salon management
      </p>
    `;
    const confirmText = `
Welcome to the Florrie Waitlist

Thanks for signing up, ${name || 'friend'}!

You're now on the waitlist for early access to Florrie — the AI-powered salon management platform.

We'll be in touch soon with updates and exclusive early-access opportunities.

Florrie — The future of salon management
    `.trim();

    await sendEmail({
      to: email,
      subject: confirmSubject,
      html: confirmHtml,
      text: confirmText,
    });

    res.json({ success: true, message: "You're on the list!" });
  } catch (err) {
    // Validation errors
    if (err.name === 'ZodError') {
      const messages = err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
      logger.warn({ errors: err.errors }, 'Waitlist validation failed');
      return res.status(400).json({ error: messages });
    }

    // Server error
    logger.error({ err }, 'Waitlist signup error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
