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
 * GET /api/agents/counts
 * Single-call badge counter for the Hub agent grid.
 * Returns: { inbox, content, churn, bookkeeper, insights, compliance, total }
 *
 * inbox      - unresolved escalated messages (Front Desk action needed)
 * content    - draft content posts awaiting approval
 * churn      - clients flagged as high churn risk
 * bookkeeper - bookkeeper actions in the last 7 days (income, expenses, tax)
 * insights   - coaching actions in the last 7 days (Biz Coach activity)
 * compliance - pending patch tests + pending consultation responses
 */
router.get('/counts', requireAuth, async (req, res) => {
  try {
    const beauticianId = req.beautician.id;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      escalationsRes,
      contentRes,
      churnRes,
      bookkeeperRes,
      insightsRes,
      patchTestsRes,
      consultationRes,
      outboundPendingRes,
    ] = await Promise.all([
      // Inbox: unresolved escalated messages
      supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', beauticianId)
        .eq('escalated', true)
        .eq('resolved', false),

      // Content: draft posts awaiting approval
      supabase
        .from('content_posts')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', beauticianId)
        .eq('status', 'draft'),

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
        .eq('status', 'pending'),

      // Compliance part 2: consultation responses awaiting signature
      supabase
        .from('consultation_responses')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', beauticianId)
        .eq('status', 'pending'),

      // Approvals: proactive messages Florrie is holding for the owner's OK
      supabase
        .from('outbound_sends')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', beauticianId)
        .eq('status', 'pending_approval'),
    ]);

    const inbox      = escalationsRes.count  ?? 0;
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
