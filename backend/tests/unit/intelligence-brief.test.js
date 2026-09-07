import { it, expect, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ supabase: {} }));
const { buildIntelligenceBrief } = await import('../../src/services/intelligence-brief.js');

function database(failed = []) {
  const calls = [];
  const from = table => {
    const call = { table, filters: [], writes: false }; calls.push(call);
    const q = {};
    for (const method of ['select', 'eq', 'gte', 'lte', 'in', 'order', 'limit', 'single', 'abortSignal']) {
      q[method] = (...args) => { call.filters.push([method, ...args]); return q; };
    }
    q.then = resolve => {
      const values = {
        ai_actions: [{ outcome: 'success', action_type: 'booking_confirmed', created_at: new Date().toISOString() }, { outcome: 'success', action_type: 'client_profile_updated', details: { heartbeat: true } }, { outcome: 'failed' }],
        beauticians: { auto_reply_enabled: false, voice_profile: { provenance: 'human', sample_count: 23, examples: ['PRIVATE'] }, tone_model: { corrections: [{ corrected: 'PRIVATE' }] } },
        client_intelligence: [{ updated_at: new Date().toISOString() }],
      };
      return Promise.resolve(resolve({ data: values[table] || [], count: 2, error: failed.includes(table) ? { message: 'PRIVATE provider error' } : null }));
    };
    return q;
  };
  return { from, calls };
}

it('scopes every business read, returns no raw writing, and keeps permission settings unchanged', async () => {
  const db = database();
  const brief = await buildIntelligenceBrief({ id: 'salon-A' }, db, Date.now(), { loadPriorities: async () => ({ cards: [], partial: false }) });
  for (const call of db.calls.filter(c => c.table !== 'job_runs')) {
    expect(call.filters).toContainEqual(['eq', call.table === 'beauticians' ? 'id' : 'beautician_id', 'salon-A']);
    expect(call.filters.some(([method]) => method === 'abortSignal')).toBe(true);
  }
  expect(brief.permissions.auto_reply_enabled).toBe(false);
  expect(brief.learning).toMatchObject({ human_samples: 23, saved_corrections: 1, client_profiles: 2 });
  expect(brief.activity).toMatchObject({ completed: 1, checks: 1, failed: 1 });
  expect(JSON.stringify(brief)).not.toContain('PRIVATE');
});

it('shows unavailable evidence without fake zeros or a healthy status', async () => {
  const brief = await buildIntelligenceBrief({ id: 'salon-B' }, database(['ai_actions', 'job_runs', 'beauticians', 'appointments', 'outbound_sends']), Date.now(), { loadPriorities: async () => { throw new Error('Offline'); } });
  expect(brief.partial).toBe(true);
  expect(brief.activity.completed).toBeNull();
  expect(brief.activity.pending_approval).toBeNull();
  expect(brief.learning.human_samples).toBeNull();
  expect(brief.permissions.auto_reply_enabled).toBeNull();
  expect(brief.insights_available).toBe(false);
  expect(brief.agents[0].checks.every(c => c.state === 'unknown')).toBe(true);
});

vi.mock('../../src/services/florrie-thinking.js', () => ({ getFlorrieThoughts: async () => ({ cards: [{ id: 'priority', summary: 'A reply awaits review' }], partial: false }) }));
it('puts shared evidence into the voice model tool result, not only the UI metadata', async () => {
  const { executeTool } = await import('../../src/services/voice-tools.js');
  const result = await executeTool('get_florrie_brief', {}, { id: 'salon-A' }, database());
  const evidence = JSON.parse(result.result);
  expect(evidence.brief.learning.human_samples).toBe(23);
  expect(evidence.brief.priorities[0].id).toBe('priority');
  expect(evidence.brief.permissions.auto_reply_enabled).toBe(false);
});
