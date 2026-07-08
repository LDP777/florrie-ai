-- Per-tenant monthly margin picture (run in Supabase SQL editor).
-- Unit costs: WhatsApp utility ~1.6p, SMS ~4.5p, AI ~0.8p per handled message
-- (July 2026 research; see FLORRIE_LAUNCH_STRATEGY_2026-07-08.md).
SELECT
  b.business_name,
  mu.month,
  mu.whatsapp_sent,
  mu.sms_sent,
  mu.whatsapp_sent + mu.sms_sent AS total_sent,
  ROUND(100.0 * mu.sms_sent / GREATEST(mu.whatsapp_sent + mu.sms_sent, 1)) AS sms_share_pct,
  mu.overage_total_pence,
  -- estimated channel cost in pence (utility-rate assumption for WA)
  ROUND(mu.whatsapp_sent * 1.6 + mu.sms_sent * 4.5) AS est_channel_cost_pence,
  -- margin on GBP29 with ~124p fixed (Stripe + infra)
  ROUND(100.0 * (2900 - 124 - (mu.whatsapp_sent * 1.6 + mu.sms_sent * 4.5)) / 2900, 1) AS est_margin_pct
FROM message_usage mu
JOIN beauticians b ON b.id = mu.beautician_id
ORDER BY mu.month DESC, est_margin_pct ASC;
