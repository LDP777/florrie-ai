import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ results: {}, calls: [] }));
vi.mock('../../src/config.js', () => ({
  supabase: {
    from(table) {
      const call = { table, columns: null, filters: [] };
      state.calls.push(call);
      const settle = () => {
        const key = table === 'outbound_sends'
          ? (call.filters.some(([column, values]) => column === 'status' && values.includes('pending_approval')) ? 'recent' : 'monthly')
          : table;
        const result = state.results[key];
        if (result instanceof Error) return Promise.reject(result);
        return Promise.resolve(result || { data: null, error: null, count: 0 });
      };
      const query = {
        select(columns) { call.columns = columns; return query; },
        eq(column, value) { call.filters.push([column, value]); return query; },
        in(column, value) { call.filters.push([column, value]); return query; },
        gte() { return query; },
        maybeSingle: settle,
        then(resolve, reject) { return settle().then(resolve, reject); },
      };
      return query;
    },
  },
}));
vi.mock('../../src/lib/logger.js', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../src/services/whatsapp-metering.js', () => ({
  getMonthlyUsage: async () => ({ total_sent: 0, free_limit: 120 }),
}));

const { isKnownClient, clientAutonomyOverride, evaluateOutbound } = await import('../../src/lib/outbound-guard.js');
const client = { id: 'c1', marketing_consent: true, marketing_opted_out_at: null, messaging_autonomy: 'florrie' };
const input = { beauticianId: 'b1', clientId: 'c1', client, messageType: 'rebook_nudge', channel: 'instagram' };

beforeEach(() => {
  state.calls = [];
  state.results = {
    appointments: { count: 0, error: null },
    clients: { data: { ...client }, error: null },
    beauticians: { data: { timezone: 'Europe/London', autonomy: { proactive: 'auto' } }, error: null },
    recent: { count: 0, error: null },
    monthly: { count: 0, error: null },
  };
  vi.useFakeTimers({ now: new Date('2026-09-06T11:00:00Z'), toFake: ['Date'] });
});
afterEach(() => vi.useRealTimers());

describe('a failed permission read cannot authorize an autonomous send', () => {
  it.each([
    { count: null, error: { message: 'database unavailable' } },
    { count: null, error: null },
    new Error('network unavailable'),
  ])('holds unknown client history for review: %j', async result => {
    state.results.appointments = result;
    expect(await isKnownClient('b1', 'c1')).toBe(true);
    const decision = await evaluateOutbound({ ...input, messageType: 'ai_reply' });
    expect(decision.decision).toBe('approve');
  });

  it('distinguishes a successful zero count from unknown history', async () => {
    expect(await isKnownClient('b1', 'c1')).toBe(false);
    expect(state.calls[0].filters).toContainEqual(['beautician_id', 'b1']);
    expect(state.calls[0].filters).toContainEqual(['client_id', 'c1']);
  });

  it.each([
    { data: null, error: { message: 'database unavailable' } },
    { data: null, error: null },
    { data: {}, error: null },
    new Error('network unavailable'),
  ])('drafts when the client override cannot be read: %j', async result => {
    state.results.clients = result;
    expect(await clientAutonomyOverride('b1', 'c1')).toBe('drafts');
  });

  it('retains an explicitly unset or saved human-only override', async () => {
    state.results.clients = { data: { messaging_autonomy: null }, error: null };
    expect(await clientAutonomyOverride('b1', 'c1')).toBe(null);
    expect(await clientAutonomyOverride('b1', 'c1', { messaging_autonomy: 'just_me' })).toBe('just_me');
  });
});

describe('proactive delivery requires consent and readable frequency limits', () => {
  it.each([false, null])('does not contact a client with consent=%j', async consent => {
    const verdict = await evaluateOutbound({ ...input, client: { ...client, marketing_consent: consent } });
    expect(verdict).toMatchObject({ decision: 'block', reason: 'no_consent' });
  });

  it('re-reads missing consent and blocks if the stored answer is false', async () => {
    const incomplete = { ...client };
    delete incomplete.marketing_consent;
    state.results.clients.data.marketing_consent = false;
    expect(await evaluateOutbound({ ...input, client: incomplete })).toMatchObject({ decision: 'block', reason: 'no_consent' });
    expect(state.calls.some(c => c.table === 'clients' && c.columns.includes('marketing_consent'))).toBe(true);
  });

  it.each(['recent', 'monthly'])('blocks when the %s send history is unreadable', async key => {
    state.results[key] = { count: null, error: { message: 'database unavailable' } };
    expect(await evaluateOutbound(input)).toMatchObject({ decision: 'block', reason: 'frequency_unavailable' });
  });

  it('still permits explicitly trusted, consented outreach with zero previous sends', async () => {
    expect(await evaluateOutbound(input)).toMatchObject({ decision: 'send', reason: 'client_trusted_florrie' });
  });

  it('does not apply marketing permission to a booking confirmation', async () => {
    expect(await evaluateOutbound({ ...input, messageType: 'booking_confirmation', client: { ...client, marketing_consent: false } }))
      .toMatchObject({ decision: 'send', reason: 'transactional' });
  });
});
