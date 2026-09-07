import { supabase } from '../config.js';
import { agentEvidence, EVIDENCE_JOBS, jobEvidence } from '../lib/agent-evidence.js';
import { businessInsights } from '../lib/business-insights.js';
import { briefCache } from '../lib/brief-cache.js';
import { nowInSalonWall } from '../lib/free-slots.js';

/** Shared, read-only evidence for Today, Insights and Voice Commander. */
export async function buildIntelligenceBrief(owner, db = supabase, now = Date.now(), { loadPriorities = async () => {
  const { getFlorrieThoughts } = await import('./florrie-thinking.js');
  return getFlorrieThoughts(owner);
} } = {}) {
  const bid = owner.id;
  const wallNow = nowInSalonWall(owner.timezone || 'Europe/London');
  const bounded = query => query.abortSignal(AbortSignal.timeout(6000));
  let priorityTimer;
  const priorities = Promise.race([
    Promise.resolve().then(loadPriorities),
    new Promise((_, reject) => { priorityTimer = setTimeout(() => reject(new Error('Priorities unavailable')), 8000); }),
  ]).then(data => ({ data, error: null })).catch(() => ({ error: true })).finally(() => clearTimeout(priorityTimer));
  const sources = {
    priorities,
    actions: bounded(db.from('ai_actions').select('id,action_type,outcome,summary,created_at,details')
      .eq('beautician_id', bid).gte('created_at', new Date(now - 7 * 86400000).toISOString()).order('created_at', { ascending: false }).limit(300)),
    jobs: bounded(db.from('job_runs').select('job_name,last_success_at,consecutive_failures').in('job_name', EVIDENCE_JOBS)),
    owner: bounded(db.from('beauticians').select('voice_profile,voice_profile_updated_at,tone_model,auto_reply_enabled')
      .eq('id', bid).single()),
    clients: bounded(db.from('client_intelligence').select('updated_at', { count: 'exact' })
      .eq('beautician_id', bid).order('updated_at', { ascending: false }).limit(1)),
    pending: bounded(db.from('outbound_sends').select('id', { count: 'exact', head: true })
      .eq('beautician_id', bid).eq('status', 'pending_approval')),
    appointments: bounded(db.from('appointments').select('client_id,treatment_id,starts_at,ends_at,price_cents,status')
      .eq('beautician_id', bid).eq('status', 'completed').gte('starts_at', new Date(+wallNow - 56 * 86400000).toISOString().slice(0, 19))
      .lte('ends_at', wallNow.toISOString().slice(0, 19)).order('starts_at', { ascending: false }).limit(3000)),
    treatments: bounded(db.from('treatments').select('id,name,price_cents,is_active')
      .eq('beautician_id', bid).eq('is_active', true).limit(300)),
  };
  const entries = await Promise.all(Object.entries(sources).map(async ([name, query]) => {
    try { const result = await query; return [name, result.error ? null : result]; }
    catch { return [name, null]; }
  }));
  const r = Object.fromEntries(entries);
  const profile = r.owner?.data?.voice_profile;
  const writing = r.owner?.data;
  const rawActions = r.actions?.data || [];
  const actions = rawActions.filter(a => !a.details?.heartbeat);
  const agents = agentEvidence(actions, r.jobs?.data, { now, actionsAvailable: !!r.actions, jobsAvailable: !!r.jobs });
  const insightsAvailable = !!r.appointments && !!r.treatments;
  const actionsTruncated = rawActions.length >= 300;
  return {
    checked_at: new Date(now).toISOString(),
    partial: entries.some(([, result]) => !result) || r.priorities?.data?.partial === true,
    priorities: r.priorities?.data?.cards || [],
    priorities_available: !!r.priorities && !r.priorities.data?.partial,
    unavailable: entries.filter(([, result]) => !result).map(([name]) => name),
    permissions: { auto_reply_enabled: writing ? writing.auto_reply_enabled === true : null },
    learning: {
      available: !!r.owner,
      human_samples: writing ? (profile?.provenance === 'human' ? profile.sample_count || 0 : 0) : null,
      provenance: profile?.provenance || null,
      updated_at: writing?.voice_profile_updated_at || null,
      saved_corrections: writing ? writing.tone_model?.corrections?.length || 0 : null,
      client_profiles: r.clients ? r.clients.count ?? null : null,
      client_updated_at: r.clients?.data?.[0]?.updated_at || null,
      check: jobEvidence('voice-profile-refresh-v2', r.jobs?.data?.find(j => j.job_name === 'voice-profile-refresh-v2'), now),
    },
    activity: {
      available: !!r.actions,
      completed: r.actions ? actions.filter(a => a.outcome === 'success').length : null,
      failed: r.actions ? actions.filter(a => a.outcome === 'failed').length : null,
      pending_approval: r.pending ? r.pending.count ?? null : null,
      sampled: actionsTruncated,
      period_days: 7,
      checks: r.actions ? rawActions.filter(a => a.details?.heartbeat).length : null,
    },
    agents,
    insights: insightsAvailable ? businessInsights(r.appointments.data, r.treatments.data, { now: +wallNow }) : [],
    insights_available: insightsAvailable,
    insights_sampled: (r.appointments?.data?.length || 0) >= 3000 || (r.treatments?.data?.length || 0) >= 300,
  };
}

export const getIntelligenceBrief = briefCache(owner => buildIntelligenceBrief(owner));
