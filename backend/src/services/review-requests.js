import { supabase } from '../index.js';
import { sendMessage } from './notifications.js';
import { sendEmail } from './notifications.js';
import logger from '../lib/logger.js';

/**
 * Review Request Service — nudges clients to leave a review after their appointment.
 *
 * Two channels:
 *   1. SMS/WhatsApp/Instagram (via sendMessage) — sent 2 hours after completion
 *   2. Email — sent alongside the SMS for clients who have an email on file
 *
 * Dedup: checks ai_actions to avoid sending multiple review requests per appointment.
 */

/**
 * Schedule a review request for a completed appointment.
 * Called from the appointment completion handler.
 *
 * This doesn't send immediately — it inserts an ai_action with status='scheduled'
 * that the cron picks up after the delay.
 */
export async function scheduleReviewRequest(beauticianId, appointmentId, clientId) {
  // Dedup check
  const { data: existing } = await supabase
    .from('ai_actions')
    .select('id')
    .eq('beautician_id', beauticianId)
    .eq('action_type', 'review_request')
    .eq('client_id', clientId)
    .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .maybeSingle();

  if (existing) return; // Already sent a review request to this client recently

  const sendAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours from now

  await supabase.from('ai_actions').insert({
    beautician_id: beauticianId,
    action_type: 'review_request',
    digital_employee: 'marketing',
    summary: 'Review request scheduled',
    details: {
      appointment_id: appointmentId,
      send_at: sendAt.toISOString(),
    },
    client_id: clientId,
    confidence: 0.95,
    autonomous: true,
    status: 'scheduled',
    outcome: 'pending',
  });
}

/**
 * Process due review requests.
 * Called by the autonomous scheduler cron.
 */
export async function processReviewRequests() {
  const now = new Date().toISOString();

  const { data: due } = await supabase
    .from('ai_actions')
    .select('*')
    .eq('action_type', 'review_request')
    .eq('status', 'scheduled')
    .lte('details->>send_at', now)
    .limit(20);

  if (!due?.length) return { sent: 0 };

  let sent = 0;

  for (const action of due) {
    try {
      const appointmentId = action.details?.appointment_id;

      // Fetch appointment + client + treatment + beautician
      const { data: appt } = await supabase
        .from('appointments')
        .select('*, clients(id, first_name, phone, email, whatsapp_id, instagram_id, preferred_channel), treatments(name), beauticians(first_name, business_name, brand_color, google_place_id)')
        .eq('id', appointmentId)
        .single();

      if (!appt?.clients) {
        await supabase.from('ai_actions').update({ status: 'executed', outcome: 'skipped' }).eq('id', action.id);
        continue;
      }

      const client = appt.clients;
      const biz = appt.beauticians;
      const treatmentName = appt.treatments?.name || 'your treatment';
      const bizName = biz?.business_name || biz?.first_name || 'us';

      // Build review URL — Google if available, otherwise generic
      const googleUrl = biz?.google_place_id
        ? `https://search.google.com/local/writereview?placeid=${biz.google_place_id}`
        : null;

      // SMS/WhatsApp message
      const smsBody = googleUrl
        ? `Hey ${client.first_name}! Hope you're loving your ${treatmentName}. If you've got a sec, a quick Google review would mean everything to me: ${googleUrl} xx`
        : `Hey ${client.first_name}! Hope you're loving your ${treatmentName}. If you had a great experience, it'd mean the world if you could leave a review. Thank you lovely xx`;

      // Send via best channel
      const result = await sendMessage({
        client,
        body: smsBody,
        beauticianId: action.beautician_id,
      });

      // Also send email if client has one
      if (client.email) {
        const color = biz?.brand_color || '#92405E';
        await sendEmail({
          to: client.email,
          subject: `How was your ${treatmentName}?`,
          text: smsBody,
          html: `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#faf8f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f5;padding:32px 16px">
<tr><td align="center">
<table width="100%" style="max-width:520px;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
  <tr><td style="padding:28px 32px">
    <h2 style="margin:0 0 12px;color:#2d2a26;font-size:20px;font-weight:700">How was your ${treatmentName}?</h2>
    <p style="margin:0 0 20px;color:#6b6560;font-size:15px;line-height:1.6">
      Hey ${client.first_name}, thanks for visiting ${bizName}. If you loved your results,
      a quick review would mean the world:
    </p>
    ${googleUrl ? `<table cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr><td>
      <a href="${googleUrl}" style="display:inline-block;padding:12px 28px;background:${color};color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">Leave a review ⭐</a>
    </td></tr></table>` : ''}
    <p style="margin:0;color:#a09a93;font-size:13px">Not happy? Reply to this email and we'll make it right.</p>
  </td></tr>
  <tr><td style="padding:14px 32px;border-top:1px solid #f0eeeb">
    <p style="margin:0;color:#a09a93;font-size:11px;text-align:center">${bizName} — powered by Florrie</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`,
        });
      }

      // Update action
      await supabase.from('ai_actions').update({
        status: 'executed',
        outcome: 'success',
        summary: `Review request sent to ${client.first_name} via ${result?.channel || 'email'}`,
        notification_sent: true,
        notification_text: `Asked ${client.first_name} for a review after their ${treatmentName}`,
      }).eq('id', action.id);

      sent++;
    } catch (err) {
      logger.error({ err, actionId: action.id }, 'Review request send failed');
      await supabase.from('ai_actions').update({ status: 'executed', outcome: 'failed' }).eq('id', action.id);
    }
  }

  return { sent, total: due.length };
}
