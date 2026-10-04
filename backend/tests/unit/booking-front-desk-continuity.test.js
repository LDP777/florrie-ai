import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ db: {}, writes: [], modelCalls: [], delivered: [], slots: [], override: 'florrie', intent: 'general_question', reads: [] }));
function builder(table) {
  fixture.reads.push(table);
  let action; let payload; let fields; let head = false; let order; let limit = Infinity;
  const filters = [];
  const settle = () => {
    let rows = (fixture.db[table] || []).filter(row => filters.every(filter => filter(row)));
    if (action) fixture.writes.push({ table, action, payload });
    if (action === 'update') rows.forEach(row => Object.assign(row, payload));
    if (action === 'delete') fixture.db[table] = (fixture.db[table] || []).filter(row => !rows.includes(row));
    if (action === 'insert') {
      rows = (Array.isArray(payload) ? payload : [payload]).map((row, i) => ({ id: `${table}-${fixture.db[table]?.length || 0}-${i}`, created_at: new Date().toISOString(), ...row }));
      (fixture.db[table] ||= []).push(...rows);
    }
    if (action === 'upsert') {
      let saved = (fixture.db[table] || []).find(row => row.beautician_id === payload.beautician_id && row.client_id === payload.client_id);
      if (saved) Object.assign(saved, payload);
      else { saved = { id: `${table}-state`, ...payload }; (fixture.db[table] ||= []).push(saved); }
      rows = [saved];
    }
    if (order) rows = [...rows].sort((a, b) => String(a[order.key]).localeCompare(String(b[order.key])) * (order.asc ? 1 : -1));
    rows = rows.slice(0, limit);
    if (fields && fields !== '*' && !fields.includes('(')) rows = rows.map(row => Object.fromEntries(fields.split(',').map(key => key.trim()).filter(key => key in row).map(key => [key, row[key]])));
    return { data: head ? null : rows, count: rows.length, error: null };
  };
  const q = {
    select(value, options) { fields = value; head = options?.head === true; return q; },
    insert(value) { action = 'insert'; payload = value; return q; },
    upsert(value) { action = 'upsert'; payload = value; return q; },
    update(value) { action = 'update'; payload = value; return q; },
    delete() { action = 'delete'; return q; },
    eq(key, value) { filters.push(row => row[key] === value); return q; },
    neq(key, value) { filters.push(row => row[key] !== value); return q; },
    in(key, values) { filters.push(row => values.includes(row[key])); return q; },
    gte() { return q; }, lte() { return q; }, gt() { return q; }, lt() { return q; },
    is() { return q; }, not() { return q; }, or() { return q; },
    order(key, options) { order = { key, asc: options?.ascending !== false }; return q; },
    limit(value) { limit = value; return q; },
    single() { const result = settle(); return Promise.resolve({ ...result, data: result.data?.[0] || null }); },
    maybeSingle() { return q.single(); },
    then(resolve, reject) { return Promise.resolve(settle()).then(resolve, reject); },
  };
  return q;
}
vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class {
  constructor() { this.messages = { create: async request => {
    fixture.modelCalls.push(request);
    if (/intent classifier/i.test(request.system)) return { content: [{ text: JSON.stringify({ intent: fixture.intent, confidence: 0.99, extracted: {}, participation: { decision: 'service', evidence: fixture.db.messages.at(-1)?.content || '' } }) }] };
    return { content: [{ type: 'text', text: 'Amazing, which treatment you thinking xxx' }] };
  } }; }
} }));
vi.mock('stripe', () => ({ default: class { constructor() { this.checkout = { sessions: { create: async () => { throw new Error('No payment session should be created'); } } }; } } }));
vi.mock('../../src/lib/knowledge.js', () => ({ retrieveKnowledge: async () => [], renderKnowledgeBlock: () => '', arrivalNoteFrom: () => '', writtenNotesFrom: () => '' }));
vi.mock('../../src/lib/free-slots.js', () => ({ getFreeSlots: async () => fixture.slots, nowInSalonWall: () => new Date('2026-10-01T11:00:00Z') }));
vi.mock('../../src/lib/schema-probe.js', () => ({ hasColumn: async () => true }));
vi.mock('../../src/lib/inbound-budget.js', () => ({ inboundBudget: () => ({ allowed: true }) }));
vi.mock('../../src/lib/outbound-guard.js', () => ({ clientAutonomyOverride: async () => fixture.override, guardedSend: async ({ send }) => { if (send) await send(); return { decision: 'allow', sent: true }; }, classifyTier: () => 'service' }));
vi.mock('../../src/services/notifications.js', () => {
  const send = async args => { fixture.delivered.push(args); return true; };
  return { notifyBookingConfirmed: send, sendMessage: send, sendInstagramDM: send, sendWhatsAppText: send, sendSMS: send };
});
vi.mock('../../src/services/push-notifications.js', () => ({ pushEscalation: async () => true, pushTeamUpdate: async () => true, pushAtTheDoor: async () => true }));
vi.mock('../../src/services/booking-confirmed-alert.js', () => ({ announceBookingConfirmed: async () => { throw new Error('No booking should be confirmed'); }, claimConfirmed: async () => ({ won: false }), BOOKING_CONFIRMED_ACTION: 'booking_confirmed' }));
vi.mock('../../src/services/live-activity.js', () => ({ refreshLiveActivity: async () => true }));
vi.mock('../../src/services/automations.js', () => ({ createBookingSuggestion: async () => { throw new Error('No booking suggestion allowed'); } }));
vi.mock('../../src/services/loyalty.js', () => ({ getLoyaltyConfig: async () => null, getClientPoints: async () => 0, loyaltyProximity: () => null }));
vi.mock('../../src/lib/promos.js', () => ({ getActivePromos: async () => [], describePromo: () => '' }));

const { processInboundMessage } = await import('../../src/services/ai-front-desk.js');
const { __setAuthorshipAvailable } = await import('../../src/lib/authorship.js');

const NOW = new Date('2026-10-01T21:00:00Z');
const REQUEST = 'Hey, hope you’re well! I’m struggling to get onto your website for some reason and just wondered if you have any availability this month for after 4/4:30? I assume not as you’re always pretty booked but I’m unable to see, sorry!x';
const ANSWER = 'A brow lamination if possible x';
const owner = { id: 'fictional-salon', first_name: 'Mara', business_name: 'Fictional Salon', timezone: 'Europe/London', booking_slug: 'fictional-salon', confidence_threshold: 0.9, booking_policy: {}, autonomy: { grounded_replies: false }, tone_model: {}, client_reminder_prefs: {} };
const client = { id: 'fictional-client', beautician_id: owner.id, first_name: 'Client', instagram_id: 'fictional-ig', preferred_channel: 'instagram', email: 'fictional@example.test', blocked_at: null };
const treatments = [{ id: 'lamination', beautician_id: owner.id, name: 'Brow lamination', is_active: true, booking_enabled: true, duration_minutes: 45, price_cents: 3500, deposit_cents: 0, requires_patch_test: false, requires_consultation: false }];
const row = (id, content, extra = {}) => ({ id, beautician_id: owner.id, client_id: client.id, channel: 'instagram', direction: 'inbound', content, created_at: NOW.toISOString(), ...extra });
const bookingWrites = () => fixture.writes.filter(write => ['appointments', 'booking_conversations'].includes(write.table));
function seedQuestion() {
  fixture.db.messages.push(
    row('request', REQUEST, { created_at: '2026-10-01T20:50:00Z' }),
    row('question', 'Hey girl! Which treatment are you after, xx', { direction: 'outbound', authored_by: 'ai', ai_handled: true, digital_employee: 'front_desk', created_at: '2026-10-01T20:50:05Z' }),
  );
}
async function receive(text = ANSWER, salon = owner) {
  fixture.db.messages.push(row('answer', text));
  return processInboundMessage('answer', salon, client, text, 'instagram');
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  __setAuthorshipAvailable(true);
  fixture.db = { clients: [{ ...client }], treatments: structuredClone(treatments), messages: [], booking_conversations: [] };
  fixture.writes = []; fixture.delivered = []; fixture.modelCalls = []; fixture.reads = [];
  fixture.override = 'florrie'; fixture.intent = 'general_question';
  fixture.slots = ['14:00', '16:30', '17:30'].map(time => ({ date: '2026-10-05', time, iso: `2026-10-05T${time}:00.000Z` }));
});
afterEach(() => { __setAuthorshipAvailable(false); vi.useRealTimers(); });

describe('the front desk finishes the treatment question it actually asked', () => {
  it('recovers the exact two-turn exchange without a guessed classifier or a booking write', async () => {
    seedQuestion();
    const result = await receive();
    expect(result.error).toBeUndefined();
    expect(result.handled).toBe(true);
    expect(fixture.modelCalls).toEqual([]);
    expect(fixture.delivered).toHaveLength(1);
    const state = fixture.db.booking_conversations[0];
    expect(state.step).toBe('awaiting_pick');
    expect(state.offered.length).toBeGreaterThan(0);
    expect(state.offered.every(slot => slot.date.startsWith('2026-10-') && slot.time >= '16:30')).toBe(true);
    expect(fixture.writes.some(write => write.table === 'appointments')).toBe(false);
    expect(result.response).not.toMatch(/confirmed|booked you|booking is booked/i);
  });
  it('asks which lamination version when the actual menu leaves a choice', async () => {
    fixture.db.treatments = [
      { ...treatments[0], id: 'tint', name: 'Brow Lamination & tint' },
      { ...treatments[0], id: 'hybrid', name: 'Brow Lamination & Hybrid stain' },
    ];
    seedQuestion();
    const result = await receive();
    expect(result.handled).toBe(true);
    expect(result.response).toMatch(/tint/);
    expect(result.response).toMatch(/Hybrid stain/);
    expect(fixture.db.booking_conversations[0].step).toBe('awaiting_treatment');
    expect(fixture.writes.some(write => write.table === 'appointments')).toBe(false);
  });
  it.each(['just_me', 'drafts'])('honours the owner’s %s setting on a proven answer', async override => {
    seedQuestion(); fixture.override = override;
    const result = await receive();
    expect(result.handled).not.toBe(true);
    expect(result.escalated).toBe(true);
    expect(fixture.delivered).toEqual([]);
    expect(bookingWrites()).toEqual([]);
  });
  it('honours paused messaging', async () => {
    seedQuestion();
    const result = await receive(ANSWER, { ...owner, client_reminder_prefs: { paused: true } });
    expect(result.handled).not.toBe(true);
    expect(fixture.delivered).toEqual([]);
    expect(bookingWrites()).toEqual([]);
  });
  it('does not take over from an intervening human answer', async () => {
    seedQuestion();
    fixture.db.messages.push(row('human', 'I will check this for you', { direction: 'outbound', authored_by: 'human', created_at: '2026-10-01T20:59:00Z' }));
    const result = await receive();
    expect(result.handled).not.toBe(true);
    expect(fixture.delivered).toEqual([]);
    expect(bookingWrites()).toEqual([]);
  });
  it('does not revive the earlier erroneous story/diary treatment question', async () => {
    seedQuestion();
    fixture.db.messages[0].content = 'When is December dates out!! Need to book in asap xx';
    fixture.intent = 'booking_request';
    const result = await receive();
    expect(result.handled).not.toBe(true);
    expect(fixture.delivered).toEqual([]);
    expect(bookingWrites()).toEqual([]);
  });
  it('does not suppress a question about safety in order to continue booking', async () => {
    seedQuestion();
    const result = await receive('Is brow lamination safe while pregnant?');
    expect(result.handled).not.toBe(true);
    expect(fixture.delivered).toEqual([]);
    expect(bookingWrites()).toEqual([]);
  });
  it('starts a remembered treatment question for a new availability request', async () => {
    fixture.intent = 'availability_check';
    const result = await receive(REQUEST);
    expect(result.handled).toBe(true);
    expect(fixture.db.booking_conversations[0]?.step).toBe('awaiting_treatment');
    expect(fixture.db.ai_actions.at(-1).summary).toBe('Asked which treatment the client wants');
    expect(fixture.db.ai_actions.at(-1).details.booking_step).toBe('awaiting_treatment');
    expect(fixture.modelCalls).toHaveLength(1);
    expect(fixture.modelCalls[0].system).toMatch(/intent classifier/);
    expect(fixture.writes.some(write => write.table === 'appointments')).toBe(false);
  });
});
