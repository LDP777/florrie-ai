import { supabase } from '../index.js';
import { sendEmail } from './notifications.js';
import logger from '../lib/logger.js';

/**
 * Email Sequence Engine — drip campaigns triggered by lifecycle events.
 *
 * How it works:
 *   1. An event fires (signup, trial_expiring, appointment_completed, etc.)
 *   2. The engine looks up which sequence that event triggers
 *   3. It schedules the emails in that sequence (with delays)
 *   4. A cron checks for due emails every 15 minutes and sends them
 *
 * Sequences are defined in code (not DB) so they deploy with the app.
 * Individual sends are tracked in `email_sends` so we never double-send.
 */

// ── Sequence definitions ───────────────────────
// delay_hours: hours after the trigger event to send
// Each email gets a unique key per beautician so we can dedup.

const SEQUENCES = {
  welcome: {
    trigger: 'signup_completed',
    emails: [
      {
        key: 'welcome_day0',
        delay_hours: 0,
        subject: 'Welcome to Florrie — let\'s get you set up',
        build: (b) => welcomeDay0(b),
      },
      {
        key: 'welcome_day3',
        delay_hours: 72,
        subject: 'Meet your AI team',
        build: (b) => welcomeDay3(b),
      },
      {
        key: 'welcome_day7',
        delay_hours: 168,
        subject: 'What beauticians are saying about Florrie',
        build: (b) => welcomeDay7(b),
      },
      {
        key: 'welcome_day14',
        delay_hours: 336,
        subject: 'Your trial is halfway through — how\'s it going?',
        build: (b) => welcomeDay14(b),
      },
    ],
  },

  trial_expiring: {
    trigger: 'trial_3_days_left',
    emails: [
      {
        key: 'trial_3day_warning',
        delay_hours: 0,
        subject: 'Your Florrie trial ends in 3 days',
        build: (b) => trialWarning(b),
      },
      {
        key: 'trial_expired',
        delay_hours: 72,
        subject: 'Your trial has ended — but your data is safe',
        build: (b) => trialExpired(b),
      },
    ],
  },

  post_appointment: {
    trigger: 'appointment_completed',
    emails: [
      {
        key: 'review_request',
        delay_hours: 2,
        subject: (b) => `How was your visit with ${b.business_name || b.first_name}?`,
        build: (b, ctx) => reviewRequest(b, ctx),
      },
    ],
  },
};

// ── Public API ──────────────────────────────────

/**
 * Trigger a sequence for a beautician.
 * Called by signup handler, cron jobs, appointment completion, etc.
 */
export async function triggerSequence(sequenceName, beauticianId, context = {}) {
  const sequence = SEQUENCES[sequenceName];
  if (!sequence) {
    logger.warn({ sequenceName }, 'Unknown email sequence');
    return;
  }

  const { data: beautician } = await supabase
    .from('beauticians')
    .select('id, first_name, business_name, email, brand_color, booking_slug, subscription_plan, trial_ends_at')
    .eq('id', beauticianId)
    .single();

  if (!beautician?.email) return;

  const now = new Date();

  for (const email of sequence.emails) {
    const emailKey = `${email.key}_${beauticianId}${context.appointment_id ? `_${context.appointment_id}` : ''}`;

    // Dedup: skip if already scheduled or sent
    const { data: existing } = await supabase
      .from('email_sends')
      .select('id')
      .eq('email_key', emailKey)
      .maybeSingle();

    if (existing) continue;

    const sendAt = new Date(now.getTime() + email.delay_hours * 60 * 60 * 1000);

    await supabase.from('email_sends').insert({
      beautician_id: beauticianId,
      email_key: emailKey,
      sequence: sequenceName,
      subject: typeof email.subject === 'function' ? email.subject(beautician) : email.subject,
      send_at: sendAt.toISOString(),
      status: email.delay_hours === 0 ? 'pending' : 'scheduled',
      context: context,
    });
  }

  // Immediately process any delay_hours=0 emails
  await processEmailQueue();
}

/**
 * Cron entry point — process all due emails.
 * Run this every 15 minutes via setInterval or external cron.
 */
export async function processEmailQueue() {
  const now = new Date().toISOString();

  const { data: due } = await supabase
    .from('email_sends')
    .select('*')
    .in('status', ['pending', 'scheduled'])
    .lte('send_at', now)
    .order('send_at', { ascending: true })
    .limit(50);

  if (!due?.length) return { sent: 0 };

  let sent = 0;

  for (const record of due) {
    try {
      const { data: beautician } = await supabase
        .from('beauticians')
        .select('id, first_name, business_name, email, brand_color, booking_slug, subscription_plan, trial_ends_at')
        .eq('id', record.beautician_id)
        .single();

      if (!beautician?.email) {
        await supabase.from('email_sends').update({ status: 'skipped' }).eq('id', record.id);
        continue;
      }

      // Check if beautician has unsubscribed from marketing emails
      const { data: prefs } = await supabase
        .from('beauticians')
        .select('marketing_emails_enabled')
        .eq('id', record.beautician_id)
        .single();

      if (prefs?.marketing_emails_enabled === false && record.sequence !== 'post_appointment') {
        await supabase.from('email_sends').update({ status: 'skipped' }).eq('id', record.id);
        continue;
      }

      // Find the email builder
      const sequence = SEQUENCES[record.sequence];
      const emailDef = sequence?.emails.find(e => record.email_key.startsWith(e.key));

      if (!emailDef) {
        await supabase.from('email_sends').update({ status: 'failed' }).eq('id', record.id);
        continue;
      }

      const { html, text } = emailDef.build(beautician, record.context || {});

      const result = await sendEmail({
        to: beautician.email,
        subject: record.subject,
        html,
        text,
      });

      await supabase.from('email_sends').update({
        status: result ? 'sent' : 'failed',
        sent_at: result ? new Date().toISOString() : null,
      }).eq('id', record.id);

      if (result) sent++;
    } catch (err) {
      logger.error({ err, emailId: record.id }, 'Email send failed');
      await supabase.from('email_sends').update({ status: 'failed' }).eq('id', record.id);
    }
  }

  return { sent, total: due.length };
}

/**
 * Check for beauticians whose trial expires in 3 days and trigger the sequence.
 * Run daily via cron.
 */
export async function checkTrialExpiry() {
  const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const fourDaysFromNow = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);

  const { data: expiring } = await supabase
    .from('beauticians')
    .select('id')
    .gte('trial_ends_at', threeDaysFromNow.toISOString())
    .lt('trial_ends_at', fourDaysFromNow.toISOString())
    .eq('subscription_plan', 'trial');

  if (!expiring?.length) return { triggered: 0 };

  let triggered = 0;
  for (const b of expiring) {
    await triggerSequence('trial_expiring', b.id);
    triggered++;
  }

  return { triggered };
}


// ── Email templates ─────────────────────────────
// All return { html, text }. Branded wrapper keeps them consistent.

function brandedWrapper(beautician, content) {
  const color = beautician.brand_color || '#92405E';
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#faf8f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f5;padding:32px 16px">
<tr><td align="center">
<table width="100%" style="max-width:540px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06)">
  <tr><td style="padding:32px 36px 24px">
    <img src="https://florrie.ai/logo.png" alt="Florrie" width="100" style="display:block;margin-bottom:24px" />
    ${content}
  </td></tr>
  <tr><td style="padding:16px 36px 28px;border-top:1px solid #f0eeeb">
    <p style="margin:0;color:#a09a93;font-size:12px;text-align:center">
      Florrie — AI-powered beauty business management<br/>
      <a href="https://florrie.ai/unsubscribe" style="color:#a09a93;text-decoration:underline">Unsubscribe</a>
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function ctaButton(text, url, color = '#92405E') {
  return `<table cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td>
    <a href="${url}" style="display:inline-block;padding:12px 28px;background:${color};color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">${text}</a>
  </td></tr></table>`;
}

// ── Welcome sequence ────────────────────────────

function welcomeDay0(b) {
  const name = b.first_name || 'there';
  const dashUrl = `https://florrie.ai/dashboard`;

  const html = brandedWrapper(b, `
    <h1 style="margin:0 0 12px;color:#2d2a26;font-size:22px;font-weight:700">Hey ${name}, welcome to Florrie</h1>
    <p style="margin:0 0 16px;color:#6b6560;font-size:15px;line-height:1.6">
      You've just set up the smartest assistant your beauty business has ever had.
      While you sleep, Florrie answers DMs, handles bookings, chases no-shows,
      and keeps your finances in order.
    </p>
    <p style="margin:0 0 16px;color:#6b6560;font-size:15px;line-height:1.6">
      Your 14-day trial includes every feature — no card needed. Here's what to do first:
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 20px">
      <tr><td style="padding:6px 0;color:#2d2a26;font-size:14px">
        <strong>1.</strong> Add your treatments and prices
      </td></tr>
      <tr><td style="padding:6px 0;color:#2d2a26;font-size:14px">
        <strong>2.</strong> Share your booking link with a client
      </td></tr>
      <tr><td style="padding:6px 0;color:#2d2a26;font-size:14px">
        <strong>3.</strong> Send a test DM and watch Florrie reply
      </td></tr>
    </table>
    ${ctaButton('Open your dashboard', dashUrl, b.brand_color || '#92405E')}
    <p style="margin:0;color:#a09a93;font-size:13px">
      Questions? Just reply to this email — a real person reads every one.
    </p>
  `);

  const text = `Hey ${name}, welcome to Florrie!\n\nYour 14-day trial is live. Here's what to do first:\n1. Add your treatments and prices\n2. Share your booking link with a client\n3. Send a test DM and watch Florrie reply\n\nOpen your dashboard: ${dashUrl}\n\nQuestions? Just reply to this email.`;

  return { html, text };
}

function welcomeDay3(b) {
  const name = b.first_name || 'there';

  const html = brandedWrapper(b, `
    <h1 style="margin:0 0 12px;color:#2d2a26;font-size:22px;font-weight:700">Meet your AI team, ${name}</h1>
    <p style="margin:0 0 20px;color:#6b6560;font-size:15px;line-height:1.6">
      Florrie isn't one thing — it's a team of specialists working behind the scenes. Here's who's got your back:
    </p>

    <table cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px">
      <tr><td style="padding:14px 16px;background:#faf8f5;border-radius:10px;margin-bottom:8px">
        <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#2d2a26">🗓 Front Desk</p>
        <p style="margin:0;font-size:13px;color:#6b6560;line-height:1.5">Answers client messages, checks your calendar, suggests appointment times — all in your voice.</p>
      </td></tr>
      <tr><td style="height:8px"></td></tr>
      <tr><td style="padding:14px 16px;background:#faf8f5;border-radius:10px">
        <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#2d2a26">📸 Content</p>
        <p style="margin:0;font-size:13px;color:#6b6560;line-height:1.5">Turns your before/after photos into Instagram captions. One tap to post.</p>
      </td></tr>
      <tr><td style="height:8px"></td></tr>
      <tr><td style="padding:14px 16px;background:#faf8f5;border-radius:10px">
        <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#2d2a26">💰 Money</p>
        <p style="margin:0;font-size:13px;color:#6b6560;line-height:1.5">Tracks income, scans receipts, calculates your tax — quarterly set-aside, HMRC categories, the lot.</p>
      </td></tr>
      <tr><td style="height:8px"></td></tr>
      <tr><td style="padding:14px 16px;background:#faf8f5;border-radius:10px">
        <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#2d2a26">🔁 Comeback Engine</p>
        <p style="margin:0;font-size:13px;color:#6b6560;line-height:1.5">Predicts when clients are due back and nudges them with a suggested slot. No more "I forgot to rebook."</p>
      </td></tr>
    </table>

    ${ctaButton('See them in action', 'https://florrie.ai/dashboard', b.brand_color || '#92405E')}
  `);

  const text = `Hey ${name}, meet your AI team:\n\n🗓 Front Desk — answers DMs in your voice\n📸 Content — turns photos into captions\n💰 Money — tracks income + tax\n🔁 Comeback Engine — nudges clients to rebook\n\nSee them in action: https://florrie.ai/dashboard`;

  return { html, text };
}

function welcomeDay7(b) {
  const name = b.first_name || 'there';

  const html = brandedWrapper(b, `
    <h1 style="margin:0 0 12px;color:#2d2a26;font-size:22px;font-weight:700">One week in — how's it going?</h1>
    <p style="margin:0 0 16px;color:#6b6560;font-size:15px;line-height:1.6">
      ${name}, you've been on Florrie for a week now. Here's what beauticians like you are saying:
    </p>

    <table cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px">
      <tr><td style="padding:16px 20px;background:#faf8f5;border-radius:12px;border-left:3px solid ${b.brand_color || '#92405E'}">
        <p style="margin:0 0 8px;font-size:14px;color:#2d2a26;line-height:1.5;font-style:italic">
          "I used to spend my whole Sunday night replying to DMs and doing my accounts.
          Now Florrie handles the messages and my tax is sorted. I actually had a Sunday off."
        </p>
        <p style="margin:0;font-size:12px;color:#a09a93;font-weight:600">— Ellie, Brow & Lash Specialist, Manchester</p>
      </td></tr>
    </table>

    <p style="margin:0 0 16px;color:#6b6560;font-size:15px;line-height:1.6">
      Have you tried sharing your booking link yet? That's usually the moment it clicks.
    </p>
    ${b.booking_slug ? ctaButton('Your booking page', `https://florrie.ai/book/${b.booking_slug}`, b.brand_color || '#92405E') : ''}
  `);

  const text = `Hey ${name}, one week in! Here's what beauticians are saying:\n\n"I used to spend my whole Sunday night replying to DMs. Now Florrie handles everything." — Ellie, Manchester\n\nHave you tried sharing your booking link yet? That's usually the moment it clicks.`;

  return { html, text };
}

function welcomeDay14(b) {
  const name = b.first_name || 'there';

  const html = brandedWrapper(b, `
    <h1 style="margin:0 0 12px;color:#2d2a26;font-size:22px;font-weight:700">Halfway through your trial, ${name}</h1>
    <p style="margin:0 0 16px;color:#6b6560;font-size:15px;line-height:1.6">
      You've had two weeks with Florrie. Your trial runs for another 14 days —
      plenty of time to see the full picture.
    </p>
    <p style="margin:0 0 16px;color:#6b6560;font-size:15px;line-height:1.6">
      If there's anything you haven't tried yet, now's the time:
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 20px">
      <tr><td style="padding:5px 0;color:#2d2a26;font-size:14px">☐ Upload a before/after photo → get an instant caption</td></tr>
      <tr><td style="padding:5px 0;color:#2d2a26;font-size:14px">☐ Scan a receipt → watch it categorise for HMRC</td></tr>
      <tr><td style="padding:5px 0;color:#2d2a26;font-size:14px">☐ Check your Tax tab → see your quarterly set-aside</td></tr>
      <tr><td style="padding:5px 0;color:#2d2a26;font-size:14px">☐ Add a deposit requirement → cut no-shows overnight</td></tr>
    </table>
    ${ctaButton('Explore your dashboard', 'https://florrie.ai/dashboard', b.brand_color || '#92405E')}
  `);

  const text = `Hey ${name}, you're halfway through your Florrie trial.\n\nThings to try before it ends:\n- Upload a before/after photo for an instant caption\n- Scan a receipt for HMRC categorisation\n- Check your tax tab\n- Add deposit requirements\n\nExplore: https://florrie.ai/dashboard`;

  return { html, text };
}

// ── Trial lifecycle ─────────────────────────────

function trialWarning(b) {
  const name = b.first_name || 'there';

  const html = brandedWrapper(b, `
    <h1 style="margin:0 0 12px;color:#2d2a26;font-size:22px;font-weight:700">Your trial ends in 3 days</h1>
    <p style="margin:0 0 16px;color:#6b6560;font-size:15px;line-height:1.6">
      Hey ${name}, just a heads up — your Florrie trial wraps up on
      ${b.trial_ends_at ? new Date(b.trial_ends_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : 'soon'}.
    </p>
    <p style="margin:0 0 16px;color:#6b6560;font-size:15px;line-height:1.6">
      Your data, clients, and settings are all safe — nothing gets deleted.
      But the AI features will pause until you pick a plan.
    </p>
    <p style="margin:0 0 16px;color:#6b6560;font-size:15px;line-height:1.6">
      Plans start at £19/month. That's less than one brow appointment —
      and it saves you 8+ hours a week.
    </p>
    ${ctaButton('Choose a plan', 'https://florrie.ai/settings#billing', b.brand_color || '#92405E')}
  `);

  const text = `Hey ${name}, your Florrie trial ends in 3 days. Your data is safe — but AI features will pause. Plans start at £19/month. Choose a plan: https://florrie.ai/settings#billing`;

  return { html, text };
}

function trialExpired(b) {
  const name = b.first_name || 'there';

  const html = brandedWrapper(b, `
    <h1 style="margin:0 0 12px;color:#2d2a26;font-size:22px;font-weight:700">Your trial has ended</h1>
    <p style="margin:0 0 16px;color:#6b6560;font-size:15px;line-height:1.6">
      Hey ${name}, your 14-day trial has finished. Here's what happens now:
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 20px">
      <tr><td style="padding:6px 0;color:#2d2a26;font-size:14px">✅ Your data, clients, and bookings are <strong>safe</strong></td></tr>
      <tr><td style="padding:6px 0;color:#2d2a26;font-size:14px">✅ Clients can still book through your link</td></tr>
      <tr><td style="padding:6px 0;color:#2d2a26;font-size:14px">⏸ AI replies, content creation, and insights are <strong>paused</strong></td></tr>
      <tr><td style="padding:6px 0;color:#2d2a26;font-size:14px">⏸ Smart scheduling and reminders are <strong>paused</strong></td></tr>
    </table>
    <p style="margin:0 0 16px;color:#6b6560;font-size:15px;line-height:1.6">
      Upgrade any time to pick up right where you left off. No setup needed —
      everything is exactly as you left it.
    </p>
    ${ctaButton('Upgrade now', 'https://florrie.ai/settings#billing', b.brand_color || '#92405E')}
  `);

  const text = `Hey ${name}, your Florrie trial has ended.\n\nYour data is safe. Clients can still book. But AI features are paused.\n\nUpgrade any time: https://florrie.ai/settings#billing`;

  return { html, text };
}

// ── Post-appointment ────────────────────────────

function reviewRequest(b, ctx) {
  const clientName = ctx.client_name || 'there';
  const treatmentName = ctx.treatment_name || 'your treatment';
  const bizName = b.business_name || b.first_name;
  const googleUrl = ctx.google_review_url || `https://search.google.com/local/writereview?placeid=`;

  const html = brandedWrapper(b, `
    <h1 style="margin:0 0 12px;color:#2d2a26;font-size:22px;font-weight:700">How was your ${treatmentName}?</h1>
    <p style="margin:0 0 16px;color:#6b6560;font-size:15px;line-height:1.6">
      Hey ${clientName}, thanks for visiting ${bizName} today.
      If you loved your results, a quick review would mean the world:
    </p>
    ${ctaButton('Leave a review ⭐', googleUrl, b.brand_color || '#92405E')}
    <p style="margin:16px 0 0;color:#a09a93;font-size:13px">
      Not happy? Reply to this email and we'll make it right.
    </p>
  `);

  const text = `Hey ${clientName}, how was your ${treatmentName} at ${bizName}? If you loved it, a quick review would mean the world: ${googleUrl}`;

  return { html, text };
}
