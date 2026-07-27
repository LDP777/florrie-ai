/**
 * Agent Status API - powers the iOS widget + dashboard agent avatars.
 *
 * Returns live status for each of Florrie's 6 AI agents:
 *   1. Front Desk      - replies, bookings, diary management, no-show handling
 *   2. Content Studio  - drafts posts, captions, stories
 *   3. Client Intel    - rebook nudges, predictive outreach
 *   4. Bookkeeper      - logs income, flags expenses, drafts tax returns
 *   5. Biz Coach       - revenue insights, pricing tips
 *   6. Guardian        - review requests, follow-ups, compliance
 *
 * GET /api/agents/status  - full status for dashboard
 * GET /api/agents/widget  - lightweight payload for iOS widget
 */
import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { isMissingColumnError } from '../lib/junk-classifier.js';
import logger from '../lib/logger.js';

const router = Router();

// Agent definitions - each maps to action_types in ai_actions table
const AGENTS = [
  {
    id: 'front_desk',
    name: 'Front Desk',
    avatar: '💬',
    colour: '#C76B8A',
    actionTypes: ['message_replied', 'message_escalated', 'booking_confirmed', 'booking_rescheduled', 'booking_cancelled', 'booking_auto_cancelled'],
    sleepLabel: 'Waiting for messages',
    activeVerbs: ['Replied to a client', 'Booked an appointment', 'Escalated a message', 'Confirmed a booking', 'Rescheduled an appointment', 'Cancelled a booking', 'Freed up a no-show slot'],
  },
  {
    id: 'content_creator',
    name: 'Content Studio',
    avatar: '🎨',
    colour: '#D4943A',
    actionTypes: ['content_drafted', 'content_posted', 'gap_post'],
    sleepLabel: 'Brainstorming content',
    activeVerbs: ['Drafted a post', 'Published to Instagram', 'Created a gap-filler post'],
  },
  {
    id: 'client_intel',
    name: 'Client Intel',
    avatar: '🔮',
    colour: '#7B6BA8',
    actionTypes: ['rebook_nudge', 'predictive_nudge'],
    sleepLabel: 'Analysing client patterns',
    activeVerbs: ['Sent a rebook nudge', 'Predicted a client need', 'Spotted a lapsed regular'],
  },
  {
    id: 'bookkeeper',
    name: 'Bookkeeper',
    avatar: '💷',
    colour: '#5BA97B',
    actionTypes: ['income_logged', 'expense_logged', 'tax_drafted', 'receipt_processed'],
    sleepLabel: 'Balancing the books',
    activeVerbs: ['Logged an income', 'Flagged an expense', 'Drafted a tax filing', 'Processed a receipt'],
  },
  {
    id: 'business_coach',
    name: 'Biz Coach',
    avatar: '📊',
    colour: '#4A90D9',
    actionTypes: ['value_coaching'],
    sleepLabel: 'Crunching numbers',
    activeVerbs: ['Delivered weekly insights', 'Found a pricing opportunity', 'Spotted a revenue trend'],
  },
  {
    id: 'guardian',
    name: 'Guardian',
    avatar: '🛡️',
    colour: '#C9A96E',
    actionTypes: ['review_request', 'follow_up', 'aftercare_sent'],
    sleepLabel: 'Protecting your reputation',
    activeVerbs: ['Requested a review', 'Sent aftercare instructions', 'Followed up with a client'],
  },
];

/**
 * GET /api/agents/status — full agent status for dashboard widget
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const beauticianId = req.beautician.id;
    const now = new Date();
    const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    // Pull last 7 days of ai_actions for this beautician
    const { data: actions, error } = await supabase
      .from('ai_actions')
      .select('id, action_type, status, created_at, details')
      .eq('beautician_id', beauticianId)
      .gte('created_at', sevenDaysAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch agent data' });
    }

    const agents = AGENTS.map((agent) => {
      const agentActions = (actions || []).filter((a) =>
        agent.actionTypes.includes(a.action_type)
      );

      const last24h = agentActions.filter(
        (a) => new Date(a.created_at) >= twentyFourHoursAgo
      );

      const lastAction = agentActions[0] || null;
      const isActive = last24h.length > 0;

      // Pick a human-readable status line
      let statusLine = agent.sleepLabel;
      if (lastAction) {
        const verb = agent.activeVerbs[
          agent.actionTypes.indexOf(lastAction.action_type)
        ] || agent.activeVerbs[0];
        const ago = timeAgo(new Date(lastAction.created_at), now);
        statusLine = `${verb} ${ago}`;
      }

      return {
        id: agent.id,
        name: agent.name,
        avatar: agent.avatar,
        colour: agent.colour,
        isActive,
        actionsToday: last24h.length,
        actionsThisWeek: agentActions.length,
        statusLine,
        lastActionAt: lastAction?.created_at || null,
      };
    });

    // Overall summary
    const totalToday = agents.reduce((sum, a) => sum + a.actionsToday, 0);
    const activeCount = agents.filter((a) => a.isActive).length;

    res.json({
      agents,
      summary: {
        totalActionsToday: totalToday,
        activeAgents: activeCount,
        totalAgents: agents.length,
        headline: activeCount === 0
          ? 'Your team is resting'
          : `${activeCount} agent${activeCount > 1 ? 's' : ''} working — ${totalToday} actions today`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Agent status failed' });
  }
});

/**
 * GET /api/agents/widget — lightweight payload for iOS home screen widget.
 *
 * Returns minimal data to keep widget refreshes fast:
 *   - 6 agents with avatar, name, isActive, one-liner status
 *   - headline summary
 *
 * iOS WidgetKit fetches this via timeline provider (Capacitor bridge or direct URL).
 */
router.get('/widget', requireAuth, async (req, res) => {
  try {
    const beauticianId = req.beautician.id;
    const now = new Date();
    const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);

    const { data: actions, error } = await supabase
      .from('ai_actions')
      .select('action_type, created_at')
      .eq('beautician_id', beauticianId)
      .gte('created_at', twentyFourHoursAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return res.status(500).json({ error: 'Widget data failed' });
    }

    const agents = AGENTS.map((agent) => {
      const agentActions = (actions || []).filter((a) =>
        agent.actionTypes.includes(a.action_type)
      );
      const isActive = agentActions.length > 0;
      const lastAction = agentActions[0] || null;

      let micro = isActive ? '✓' : '—';
      if (lastAction) {
        micro = shortTimeAgo(new Date(lastAction.created_at), now);
      }

      return {
        id: agent.id,
        name: agent.name,
        avatar: agent.avatar,
        colour: agent.colour,
        isActive,
        count: agentActions.length,
        micro, // "2h" or "15m" — fits widget space
      };
    });

    const activeCount = agents.filter((a) => a.isActive).length;
    const totalToday = agents.reduce((s, a) => s + a.count, 0);

    res.json({
      agents,
      headline: activeCount === 0
        ? 'Team resting'
        : `${activeCount}/${agents.length} active · ${totalToday} actions`,
      updatedAt: now.toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Widget data failed' });
  }
});

function timeAgo(date, now) {
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortTimeAgo(date, now) {
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return '<1m';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * How many people are actually waiting on a human reply right now.
 *
 * The old count was rows in `messages` where escalated and not resolved, with
 * no upper bound in time. One chatty client could put five points on the
 * badge, and nothing ever fell off, so it climbed to "99+" and stayed there.
 * This counts distinct clients instead, drops anything the junk classifier
 * flagged, and ignores escalations older than `sinceIso`.
 *
 * Fails soft to 0: a badge is never worth breaking the Hub over. Also falls
 * back to the pre-migration shape if `is_junk` is not there yet.
 */
const ESCALATION_ROW_CAP = 2000;

async function openEscalations(beauticianId, sinceIso) {
  let { data, error } = await supabase
    .from('messages')
    .select('client_id, is_junk')
    .eq('beautician_id', beauticianId)
    .eq('escalated', true)
    .eq('resolved', false)
    .gte('created_at', sinceIso)
    .limit(ESCALATION_ROW_CAP);

  if (error && isMissingColumnError(error)) {
    ({ data, error } = await supabase
      .from('messages')
      .select('client_id')
      .eq('beautician_id', beauticianId)
      .eq('escalated', true)
      .eq('resolved', false)
      .gte('created_at', sinceIso)
      .limit(ESCALATION_ROW_CAP));
  }

  if (error) {
    logger.warn({ err: error, beauticianId }, 'agents.counts open escalations failed');
    return 0;
  }

  const clients = new Set();
  for (const row of data || []) {
    if (row.is_junk) continue;
    if (row.client_id) clients.add(row.client_id);
  }
  return clients.size;
}

/**
 * GET /api/agents/counts
 * Single-call badge counter for the Hub agent grid.
 * Returns: { inbox, content, churn, bookkeeper, insights, compliance, total }
 *
 * A badge is a promise about how much work is waiting. These counts used to
 * accumulate for ever, so every one of them drifted past 99 and the UI just
 * showed "99+", which told Ellie nothing at all. Anything that represents
 * outstanding human work is now scoped to the last 30 days, because a thing
 * she has not touched in a month is not today's work, and the inbox count is
 * per conversation rather than per message.
 *
 * inbox      - distinct clients with an open escalation in the last 30 days,
 *              junk excluded (one badge point per person who is waiting)
 * content    - draft content posts from the last 30 days
 * churn      - clients flagged as high churn risk
 * bookkeeper - bookkeeper actions in the last 7 days (income, expenses, tax)
 * insights   - coaching actions in the last 7 days (Biz Coach activity)
 * compliance - pending patch tests + pending consultation responses,
 *              last 30 days
 */
router.get('/counts', requireAuth, async (req, res) => {
  try {
    const beauticianId = req.beautician.id;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [
      inboxCount,
      contentRes,
      churnRes,
      bookkeeperRes,
      insightsRes,
      patchTestsRes,
      consultationRes,
      outboundPendingRes,
    ] = await Promise.all([
      // Inbox: open escalations, as rows rather than a head-count, because the
      // badge is one point per waiting CLIENT and junk does not count at all.
      // Bounded by date and by row cap so this stays a cheap badge query.
      openEscalations(beauticianId, thirtyDaysAgo),

      // Content: draft posts awaiting approval. A draft she ignored for a
      // month is not a pending decision, it is an abandoned idea.
      supabase
        .from('content_posts')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', beauticianId)
        .eq('status', 'draft')
        .gte('created_at', thirtyDaysAgo),

      // Churn: clients flagged high risk
      supabase
        .from('clients')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', beauticianId)
        .eq('churn_risk', 'high'),

      // Bookkeeper: income, expense, tax actions in last 7 days
      supabase
        .from('ai_actions')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', beauticianId)
        .in('action_type', ['income_logged', 'expense_logged', 'tax_drafted', 'receipt_processed'])
        .gte('created_at', sevenDaysAgo),

      // Insights: coaching ai_actions in last 7 days
      supabase
        .from('ai_actions')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', beauticianId)
        .eq('action_type', 'value_coaching')
        .gte('created_at', sevenDaysAgo),

      // Compliance part 1: pending patch tests
      supabase
        .from('patch_tests')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', beauticianId)
        .eq('status', 'pending')
        .gte('created_at', thirtyDaysAgo),

      // Compliance part 2: consultation responses awaiting signature
      supabase
        .from('consultation_responses')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', beauticianId)
        .eq('status', 'pending')
        .gte('created_at', thirtyDaysAgo),

      // Approvals: proactive messages Florrie is holding for the owner's OK
      supabase
        .from('outbound_sends')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', beauticianId)
        .eq('status', 'pending_approval')
        .gte('created_at', thirtyDaysAgo),
    ]);

    const inbox      = inboxCount;
    const content    = contentRes.count      ?? 0;
    const churn      = churnRes.count        ?? 0;
    const bookkeeper = bookkeeperRes.count   ?? 0;
    const insights   = insightsRes.count     ?? 0;
    const compliance = (patchTestsRes.count ?? 0) + (consultationRes.count ?? 0);
    // Approvals waiting on the owner's yes/no: held proactive messages plus the
    // escalated replies to clients she knows (those land in `inbox` already).
    const heldProactive = outboundPendingRes.count ?? 0;
    const approvals  = heldProactive + inbox;
    const total      = inbox + content + churn + bookkeeper + insights + compliance;

    res.json({ inbox, content, churn, bookkeeper, insights, compliance, approvals, total });
  } catch (err) {
    // Fail silently - badge counts are non-critical
    res.json({ inbox: 0, content: 0, churn: 0, bookkeeper: 0, insights: 0, compliance: 0, approvals: 0, total: 0 });
  }
});

export default router;
