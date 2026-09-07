import { describe, it, expect } from 'vitest';
import { visitPatterns, intelligenceId } from '../../src/lib/client-learning.js';
import { businessInsights } from '../../src/lib/business-insights.js';
import { agentEvidence, jobEvidence } from '../../src/lib/agent-evidence.js';
import { correctionVoiceHints } from '../../src/lib/voice-corrections.js';
import { briefCache } from '../../src/lib/brief-cache.js';

const now = Date.parse('2026-09-07T12:00:00Z');
const appointment = (date, over = {}) => ({ client_id: 'c1', treatment_id: 't1', starts_at: `${date}T10:00:00Z`, ends_at: `${date}T11:00:00Z`, status: 'completed', price_cents: 3000, ...over });
const treatments = [{ id: 't1', name: 'Brows', price_cents: 3000 }, { id: 't2', name: 'Lashes', price_cents: 4000 }];

describe('learning from completed client visits', () => {
  it('groups same-day treatments and ignores future, cancelled and unfinished work', () => {
    const result = visitPatterns([
      appointment('2026-06-01'), appointment('2026-06-01', { treatment_id: 't2' }),
      appointment('2026-07-01'), appointment('2026-07-31'),
      appointment('2026-08-01', { status: 'cancelled' }), appointment('2026-09-08'),
      appointment('2026-09-07', { ends_at: '2026-09-07T13:00:00Z' }),
    ], new Date(now));
    expect(result.visits).toBe(3);
    expect(result.rebooking_rhythm_days).toBe(30);
    expect(result.rebooking_consistency).toBe(1);
    expect(result.avg_spend_cents).toBe(4000);
    expect(result.next_predicted_visit).toBe('2026-08-30');
  });
  it('does not invent a rhythm from one visit', () => {
    expect(visitPatterns([appointment('2026-08-01')], new Date(now))).toMatchObject({ rebooking_rhythm_days: null, rebooking_consistency: 0, next_predicted_visit: null });
  });
  it('converges first writes without crossing salon boundaries', () => {
    expect(intelligenceId('owner1', 'client1')).toBe(intelligenceId('owner1', 'client1'));
    expect(intelligenceId('owner1', 'client1')).not.toBe(intelligenceId('owner2', 'client1'));
    expect(intelligenceId('owner1', 'client1')).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-5[a-f\d]{3}-a[a-f\d]{3}-[a-f\d]{12}$/);
  });
});

describe('business evidence', () => {
  it('never calls two clients a treatment combination', () => {
    const rows = ['2026-08-11', '2026-08-18', '2026-08-25'].flatMap(d => [appointment(d), appointment(d, { client_id: 'c2', treatment_id: 't2', starts_at: `${d}T11:00:00Z`, ends_at: `${d}T12:00:00Z` })]);
    expect(businessInsights(rows, treatments, { now }).find(c => c.type === 'treatment_pair')).toBeUndefined();
    rows.forEach(a => a.client_id = 'same-client');
    expect(businessInsights(rows, treatments, { now }).find(c => c.type === 'treatment_pair')?.summary).toContain('3 client visits');
  });
  it('keeps pricing a labelled scenario for the relevant service only', () => {
    const rows = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'].map(d => appointment(d));
    rows.push(appointment('2026-08-15', { treatment_id: 't2' }), appointment('2026-08-16', { status: 'cancelled' }), appointment('2026-10-01'));
    const card = businessInsights(rows, treatments, { now }).find(c => c.type === 'price_scenario');
    expect(card).toMatchObject({ impact_pence: 1200, confidence: 'scenario' });
    expect(card.summary).toContain('same 4 bookings');
    expect(card.evidence).toContain('not a revenue forecast');
  });
});

describe('honest agent activity and voice preferences', () => {
  it('does not call failures or drafts completed work', () => {
    const actions = ['failed', 'pending', 'success'].map((outcome, i) => ({ outcome, action_type: 'booking_confirmed', created_at: new Date(now - i * 1000).toISOString() }));
    const agent = agentEvidence(actions, [], { now })[0];
    expect(agent).toMatchObject({ actionsToday: 1, actionsThisWeek: 1, failed: 1, pending: 1, statusLine: 'Latest action needs attention' });
    expect(agentEvidence([], [], { actionsAvailable: false })[0].actionsToday).toBeNull();
  });
  it('marks stale and failed background checks, without pretending missing means healthy', () => {
    expect(jobEvidence('reminders', null, now).state).toBe('unknown');
    expect(jobEvidence('reminders', { last_success_at: new Date(now - 5 * 3600000).toISOString() }, now).state).toBe('attention');
    expect(jobEvidence('reminders', { last_success_at: new Date(now).toISOString(), consecutive_failures: 1 }, now).state).toBe('attention');
  });
  it('lets a later sign-off correction supersede an old preference without quoting client facts', () => {
    const hints = correctionVoiceHints({ corrections: [
      { original: 'Hello lovely, see you soon.', corrected: 'hey lovely, see you soon xx' },
      { original: 'hey lovely, see you soon xx', corrected: 'hey lovely, see you soon x' },
    ] });
    expect(hints).toContain('"x"');
    expect(hints).not.toContain('see you soon');
    expect(hints).not.toContain('"xx"');
  });
});

it('coalesces reads per salon and retries failed loads', async () => {
  let calls = 0;
  const read = briefCache(async owner => { calls++; if (owner.id === 'bad') throw new Error('offline'); return owner.id; });
  expect(await Promise.all([read({ id: 'one' }), read({ id: 'one' }), read({ id: 'two' })])).toEqual(['one', 'one', 'two']);
  expect(calls).toBe(2);
  read.invalidate('one'); await read({ id: 'one' }); expect(calls).toBe(3);
  await expect(read({ id: 'bad' })).rejects.toThrow();
  await expect(read({ id: 'bad' })).rejects.toThrow(); expect(calls).toBe(5);
});
