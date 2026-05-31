import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * Suggestions API, Day 4 of the 2026-05-28 refactor.
 *
 * GET  /api/suggestions          -> up to 5 active suggestions, priority-sorted
 * POST /api/suggestions/respond  -> yes / no / tweak, logs to florrie_decisions
 *
 * Sources, in priority order:
 *   1. booking_suggestions (suggest-and-confirm bookings from voice / AI Front Desk)
 *   2. rebook_reminders    (clients overdue for a rebook)
 *   3. Empty calendar tomorrow ("gap-fill the waitlist?")
 *   4. Dormant clients with no tag yet ("tag them so Florrie can learn")
 *
 * Falls back to a synthetic "getting to know your salon" set when the tenant
 * is genuinely empty, so the card row never looks broken.
 */

const MAX_SUGGESTIONS = 5;

router.get('/', requireAuth, async (req, res) => {
  const beauticianId = req.beautician.id;
  const suggestions = [];

  try {
    suggestions.push(...await fromBookingSuggestions(beauticianId));
    if (suggestions.length < MAX_SUGGESTIONS) {
      suggestions.push(...await fromRebookReminders(beauticianId));
    }
    if (suggestions.length < MAX_SUGGESTIONS) {
      suggestions.push(...await fromValueCoaching(beauticianId));
    }
    if (suggestions.length < MAX_SUGGESTIONS) {
      suggestions.push(...await fromEmptyTomorrow(beauticianId));
    }
    if (suggestions.length < MAX_SUGGESTIONS) {
      suggestions.push(...await fromUntaggedDormant(beauticianId));
    }
  } catch (err) {
    logger.error({ err }, 'Suggestion source failed, falling back to synthetic');
  }

  // Filter out anything Ellie already responded to in the last 7 days
  const filtered = await filterDismissed(beauticianId, suggestions);

  // If we still have nothing, surface the fresh-tenant defaults so the row
  // doesn't render empty.
  const out = filtered.length > 0 ? filtered : syntheticDefaults(req.beautician);

  res.json({ suggestions: out.slice(0, MAX_SUGGESTIONS), count: out.length });
});

router.post('/respond', requireAuth, async (req, res) => {
  const beauticianId = req.beautician.id;
  const { suggestion_id, suggestion_type, suggestion_payload, response, tweak } = req.body || {};

  if (!response || !['yes', 'no', 'tweak', 'dismissed'].includes(response)) {
    return res.status(400).json({ error: 'Invalid response value' });
  }
  if (!suggestion_type) {
    return res.status(400).json({ error: 'Missing suggestion_type' });
  }

  let actedOn = false;
  let sideEffect = null;

  if (response === 'yes') {
    try {
      sideEffect = await runSideEffect({
        beauticianId,
        suggestionId: suggestion_id,
        suggestionType: suggestion_type,
        payload: suggestion_payload || {},
      });
      actedOn = !!sideEffect?.ok;
    } catch (err) {
      logger.error({ err, suggestion_id, suggestion_type }, 'Suggestion side effect failed');
    }
  }

  const { data, error } = await supabase
    .from('florrie_decisions')
    .insert({
      beautician_id: beauticianId,
      suggestion_type,
      suggestion_payload: suggestion_payload || {},
      response,
      tweak_payload: response === 'tweak' ? (tweak || null) : null,
      acted_on: actedOn,
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to record florrie_decision');
    // Don't fail the request, the user already tapped, we don't want to crash the UI.
  }

  res.json({
    ok: true,
    decision_id: data?.id || null,
    acted_on: actedOn,
    side_effect: sideEffect,
  });
});

// ============================================================
// Sources
// ============================================================

async function fromBookingSuggestions(beauticianId) {
  const { data, error } = await supabase
    .from('booking_suggestions')
    .select('id, treatment_name, suggested_date, suggested_time, client_id, clients(first_name, last_name)')
    .eq('beautician_id', beauticianId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(3);

  if (error || !data) return [];

  return data.map(row => {
    const first = row.clients?.first_name?.trim() || 'a client';
    const date = formatShortDate(row.suggested_date);
    const time = row.suggested_time ? ` at ${row.suggested_time.slice(0, 5)}` : '';
    return {
      id: `booking-${row.id}`,
      type: 'booking_suggestion',
      icon: '📅',
      summary: `${first} wants ${row.treatment_name || 'a treatment'}${date ? ` on ${date}` : ''}${time}. Book it in?`,
      action_label: 'Book it',
      payload: { booking_suggestion_id: row.id },
      link_to: '/today',
    };
  });
}

async function fromRebookReminders(beauticianId) {
  // Only surface clients who are lapsed but still re-engageable. A 4-week lower
  // bound stops nagging about recent visits; a ~6-month upper bound kills the
  // absurd "208 weeks" suggestions - past 6 months the relationship has ended,
  // not lapsed, and a comeback offer reads as out of touch.
  const minCutoff = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();   // 4 weeks
  const maxCutoff = new Date(Date.now() - 182 * 24 * 60 * 60 * 1000).toISOString();  // ~6 months

  const { data, error } = await supabase
    .from('clients')
    .select('id, first_name, last_name, last_visit_at')
    .eq('beautician_id', beauticianId)
    .lt('last_visit_at', minCutoff)
    .gte('last_visit_at', maxCutoff)
    .order('last_visit_at', { ascending: false }) // freshest lapses first - best re-engagement odds
    .limit(2); // cap rebook so it doesn't flood "Florrie thinks" - leave room for variety

  if (error || !data) return [];

  return data.map(client => {
    const weeks = Math.floor(
      (Date.now() - new Date(client.last_visit_at).getTime()) / (7 * 24 * 60 * 60 * 1000)
    );
    const first = client.first_name?.trim() || 'A client';
    // Tier the tone: a recent lapse is a gentle nudge, a longer one is a comeback.
    const summary = weeks <= 8
      ? `${first} is due a rebook (last in ${weeks} weeks ago). Send a friendly nudge?`
      : `${first} hasn't been in for ${weeks} weeks. Send a comeback offer?`;
    return {
      id: `rebook-${client.id}`,
      type: 'rebook_reminder',
      icon: '💕',
      summary,
      action_label: 'Send offer',
      payload: { client_id: client.id, weeks_since: weeks },
      link_to: `/inbox?client=${client.id}`,
    };
  });
}

async function fromValueCoaching(beauticianId) {
  // Pricing / revenue insights Florrie has spotted. Different flavour from
  // rebook nudges, so "Florrie thinks" feels varied rather than all-rebook.
  const { data, error } = await supabase
    .from('ai_actions')
    .select('id, summary, created_at')
    .eq('beautician_id', beauticianId)
    .eq('action_type', 'value_coaching')
    .order('created_at', { ascending: false })
    .limit(2);

  if (error || !data) return [];

  return data.map(row => ({
    id: `coaching-${row.id}`,
    type: 'value_coaching',
    icon: '💡',
    summary: row.summary,
    action_label: 'See',
    payload: { ai_action_id: row.id },
    link_to: '/money',
  }));
}

async function fromEmptyTomorrow(beauticianId) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const dayEnd = new Date(tomorrow);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const { data, error } = await supabase
    .from('appointments')
    .select('id')
    .eq('beautician_id', beauticianId)
    .gte('starts_at', tomorrow.toISOString())
    .lt('starts_at', dayEnd.toISOString())
    .neq('status', 'cancelled');

  if (error) return [];
  if ((data || []).length > 0) return [];

  // Empty day. Suggest gap-fill.
  return [{
    id: 'gap-fill-tomorrow',
    type: 'gap_fill_tomorrow',
    icon: '🌷',
    summary: 'Tomorrow is quiet. Want Florrie to offer your waitlist a slot?',
    action_label: 'Offer it',
    payload: { date: tomorrow.toISOString().slice(0, 10) },
    link_to: '/smart-schedule',
  }];
}

async function fromUntaggedDormant(beauticianId) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Count untagged dormant clients
  const { data: clients, error } = await supabase
    .from('clients')
    .select('id')
    .eq('beautician_id', beauticianId)
    .lt('last_visit_at', cutoff)
    .limit(10);

  if (error || !clients || clients.length === 0) return [];

  return [{
    id: 'tag-dormant',
    type: 'tag_dormant',
    icon: '🏷️',
    summary: `You have ${clients.length} client${clients.length === 1 ? '' : 's'} going quiet. Tag them so Florrie can learn?`,
    action_label: 'Tag them',
    payload: { count: clients.length },
    link_to: '/clients?filter=cooling',
  }];
}

async function filterDismissed(beauticianId, suggestions) {
  if (!suggestions.length) return suggestions;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('florrie_decisions')
    .select('suggestion_type, suggestion_payload')
    .eq('beautician_id', beauticianId)
    .in('response', ['no', 'dismissed', 'yes'])
    .gte('created_at', sevenDaysAgo);

  if (!data || data.length === 0) return suggestions;

  const blocked = new Set();
  for (const d of data) {
    blocked.add(stableKey(d.suggestion_type, d.suggestion_payload));
  }

  return suggestions.filter(s => !blocked.has(stableKey(s.type, s.payload)));
}

function stableKey(type, payload) {
  if (!payload || typeof payload !== 'object') return `${type}:`;
  // Use whichever id-ish fields the payload has, so we de-dupe per-target.
  const id =
    payload.booking_suggestion_id ||
    payload.client_id ||
    payload.date ||
    JSON.stringify(payload);
  return `${type}:${id}`;
}

function syntheticDefaults(beautician) {
  const firstName = beautician?.first_name?.trim() || 'there';
  return [
    {
      id: 'synth-import',
      type: 'synth_import_clients',
      icon: '📇',
      summary: 'Got an existing client list? Import it so Florrie can start learning.',
      action_label: 'Import',
      payload: {},
      link_to: '/import',
    },
    {
      id: 'synth-templates',
      type: 'synth_check_templates',
      icon: '💌',
      summary: 'Check your message templates so Florrie sounds like you.',
      action_label: 'Open',
      payload: {},
      link_to: '/templates',
    },
    {
      id: 'synth-booking',
      type: 'synth_share_booking',
      icon: '🔗',
      summary: `Share your booking link, ${firstName}. Clients book in, Florrie does the rest.`,
      action_label: 'Copy link',
      payload: {},
      link_to: '/business',
    },
  ];
}

// ============================================================
// Yes-button side effects
// ============================================================

async function runSideEffect({ beauticianId, suggestionId, suggestionType, payload }) {
  switch (suggestionType) {
    case 'booking_suggestion': {
      const id = payload?.booking_suggestion_id;
      if (!id) return { ok: false, reason: 'Missing booking_suggestion_id' };
      const { error } = await supabase
        .from('booking_suggestions')
        .update({ status: 'approved', reviewed_at: new Date().toISOString() })
        .eq('id', id)
        .eq('beautician_id', beauticianId);
      return { ok: !error, action: 'booking_suggestion_approved' };
    }

    case 'rebook_reminder':
    case 'gap_fill_tomorrow':
    case 'tag_dormant':
      // These open a UI flow rather than firing a side effect server-side, so
      // we just record intent. The frontend handles the navigation.
      return { ok: true, action: 'recorded_intent' };

    default:
      // Synthetic defaults, or anything else, just record.
      return { ok: true, action: 'recorded_intent' };
  }
}

function formatShortDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch { return ''; }
}

export default router;
