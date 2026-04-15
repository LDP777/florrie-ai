import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();

// In-memory cache per beautician, 60s TTL
const cache = new Map();
const CACHE_TTL = 60_000;

/**
 * GET /api/widget-state
 *
 * Returns a lightweight snapshot for the iOS home-screen widget:
 *   - active_agents: array of { name, status, last_action_at }
 *   - today_stats: { revenue_pence, bookings, actions_count }
 *   - recent_actions: last 3 one-liner descriptions
 *   - next_appointment: { client_name, treatment, starts_at } | null
 */
router.get('/', requireAuth, async (req, res) => {
  const bid = req.beautician.id;

  // Check cache
  const cached = cache.get(bid);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const now = new Date().toISOString();

    // Fire all queries in parallel
    const [appointmentsRes, transactionsRes, aiActionsRes, agentsRes] = await Promise.all([
      // Today's appointments
      supabase
        .from('appointments')
        .select('id, starts_at, status, clients(first_name, last_name), treatments(name)')
        .eq('beautician_id', bid)
        .gte('starts_at', todayStart.toISOString())
        .lte('starts_at', todayEnd.toISOString())
        .order('starts_at', { ascending: true }),

      // Today's transactions (revenue)
      supabase
        .from('transactions')
        .select('amount_pence')
        .eq('beautician_id', bid)
        .eq('type', 'payment')
        .gte('created_at', todayStart.toISOString())
        .lte('created_at', todayEnd.toISOString()),

      // Last 3 AI actions for the beautician
      supabase
        .from('ai_actions')
        .select('id, action_type, summary, created_at')
        .eq('beautician_id', bid)
        .order('created_at', { ascending: false })
        .limit(3),

      // Active agents (AI modules that have acted today)
      supabase
        .from('ai_actions')
        .select('agent_name, created_at')
        .eq('beautician_id', bid)
        .gte('created_at', todayStart.toISOString())
        .order('created_at', { ascending: false }),
    ]);

    const appointments = appointmentsRes.data || [];
    const transactions = transactionsRes.data || [];
    const aiActions = aiActionsRes.data || [];
    const agentRows = agentsRes.data || [];

    const bookedCount = appointments.filter(a => a.status !== 'cancelled').length;
    const revenuePence = transactions.reduce((sum, t) => sum + (t.amount_pence || 0), 0);

    const agentMap = new Map();
    for (const row of agentRows) {
      if (!agentMap.has(row.agent_name)) {
        agentMap.set(row.agent_name, {
          name: row.agent_name,
          status: 'active',
          last_action_at: row.created_at,
        });
      }
    }
    // Always include the core agent names even if they haven't fired today
    const CORE_AGENTS = ['Receptionist', 'Stylist', 'Bookkeeper', 'Marketer'];
    for (const name of CORE_AGENTS) {
      if (!agentMap.has(name)) {
        agentMap.set(name, { name, status: 'idle', last_action_at: null });
      }
    }
    const activeAgents = Array.from(agentMap.values());

    const recentActions = aiActions.map(a => ({
      action_type: a.action_type,
      summary: a.summary || a.action_type,
      created_at: a.created_at,
    }));

    const upcoming = appointments.find(a =>
      a.status !== 'cancelled' && new Date(a.starts_at) > new Date(now)
    );
    const nextAppointment = upcoming ? {
      client_name: upcoming.clients
        ? `${upcoming.clients.first_name} ${upcoming.clients.last_name}`.trim()
        : 'Unknown',
      treatment: upcoming.treatments?.name || 'Appointment',
      starts_at: upcoming.starts_at,
    } : null;

    const payload = {
      active_agents: activeAgents,
      today_stats: {
        revenue_pence: revenuePence,
        bookings: bookedCount,
        actions_count: agentRows.length,
      },
      recent_actions: recentActions,
      next_appointment: nextAppointment,
    };

    // Cache it
    cache.set(bid, { data: payload, ts: Date.now() });

    res.json(payload);
  } catch (err) {
    logger.error({ err }, 'Widget state fetch failed');
    res.status(500).json({ error: 'Failed to load widget state' });
  }
});

export default router;
