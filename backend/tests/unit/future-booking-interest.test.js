import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTAGRAM_STORY_UNAVAILABLE_MARKER } from '../../src/lib/instagram-story-context.js';
import { looksLikeABookingOpening } from '../../src/lib/booking-rules.js';
import { declinesBookingNow, hasExplicitBookingRequest, isPassiveBookingInterest } from '../../src/lib/booking-request.js';
import { isBookingProblem } from '../../src/lib/booking-problem.js';
import { clientQuestionScenario } from '../../src/lib/client-question.js';

const fixture = vi.hoisted(() => ({ db: {}, writes: [], modelCalls: [], delivered: [], slots: [] }));
function builder(table) {
  let action; let payload; let fields; let head = false; let order; let limit = Infinity;
  const filters = [];
  const settle = () => {
    let rows = (fixture.db[table] || []).filter(row => filters.every(filter => filter(row)));
    if (action) fixture.writes.push({ table, action, payload });
    if (action === 'update') rows.forEach(row => Object.assign(row, payload));
    if (action === 'delete') fixture.db[table] = (fixture.db[table] || []).filter(row => !rows.includes(row));
    if (action === 'insert') {
      rows = (Array.isArray(payload) ? payload : [payload]).map((row, i) => ({ id: `${table}-${i}`, ...row }));
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
    if (/intent classifier/i.test(request.system)) return { content: [{ text: JSON.stringify({ intent: 'booking_request', confidence: 0.99, extracted: {} }) }] };
    return { content: [{ type: 'text', text: 'Amazing, which treatment you thinking xxx' }] };
  } }; }
} }));
vi.mock('stripe', () => ({ default: class { constructor() { this.checkout = { sessions: { create: async () => { throw new Error('No payment session should be created'); } } }; } } }));
vi.mock('../../src/lib/knowledge.js', () => ({ retrieveKnowledge: async () => [], renderKnowledgeBlock: () => '', arrivalNoteFrom: () => '', writtenNotesFrom: () => '' }));
vi.mock('../../src/lib/free-slots.js', () => ({ getFreeSlots: async () => fixture.slots, nowInSalonWall: () => new Date('2026-10-01T11:00:00Z') }));
vi.mock('../../src/lib/schema-probe.js', () => ({ hasColumn: async () => true }));
vi.mock('../../src/lib/inbound-budget.js', () => ({ inboundBudget: () => ({ allowed: true }) }));
vi.mock('../../src/lib/outbound-guard.js', () => ({ clientAutonomyOverride: async () => 'florrie', guardedSend: async ({ send }) => { if (send) await send(); return { decision: 'allow', sent: true }; }, classifyTier: () => 'service' }));
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

const { processInboundMessage, replyIsOwed } = await import('../../src/services/ai-front-desk.js');
const { advanceBookingConversation } = await import('../../src/services/conversational-booking.js');
const NOW = new Date('2026-10-01T10:00:00Z');
const FIRST = 'Haven’t been able to find a time/date I can do in October but this has helped for what I’m booking December 😂xx';
const SECOND = 'Keeping an eye out on December 7th 😂 xx';
const CHANGES = ["I can't make my appointment tomorrow. I'll book December instead xx", 'Keeping an eye out on December 7th. I need to move my appointment tomorrow xx'];
const DECLINES = ['Please don’t book me yet', 'I don’t want you to book me', 'Don’t book me in yet, I’ll keep an eye out for December'];
const PROBLEMS = ['Keeping an eye out for December, but the website won’t let me book', 'I’ll book December but I can’t finish my booking'];
const owner = { id: 'fictional-salon', first_name: 'Mara', business_name: 'Fictional Salon', timezone: 'Europe/London', booking_slug: 'fictional-salon', confidence_threshold: 0.9, booking_policy: {}, autonomy: { grounded_replies: false }, tone_model: {}, client_reminder_prefs: {} };
const client = { id: 'fictional-client', beautician_id: owner.id, first_name: 'Client', instagram_id: 'fictional-ig', preferred_channel: 'instagram', email: 'fictional@example.test', blocked_at: null };
const treatments = [{ id: 'hybrid', beautician_id: owner.id, name: 'Hybrid brows', is_active: true, booking_enabled: true, duration_minutes: 30, price_cents: 3000, deposit_cents: 0, requires_patch_test: false, requires_consultation: false }];
const liveState = () => ({ id: 'conversation', beautician_id: owner.id, client_id: client.id, step: 'awaiting_treatment', offered: [{ treatment_id: 'hybrid', name: 'Hybrid brows' }], asked_count: 1, expires_at: new Date(NOW.getTime() + 3600000).toISOString() });
const row = (id, content, extra = {}) => ({ id, beautician_id: owner.id, client_id: client.id, channel: 'instagram', direction: 'inbound', content, created_at: NOW.toISOString(), ...extra });
const bookingWrites = () => fixture.writes.filter(write => ['appointments', 'booking_conversations'].includes(write.table));
const advance = message => advanceBookingConversation({ beautician: owner, client, message, classification: { intent: 'booking_request', confidence: 0.99 }, context: { treatments, clientUpcoming: [], conversation: [] } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  fixture.db = { clients: [{ ...client }], treatments: structuredClone(treatments), messages: [], booking_conversations: [] };
  fixture.writes = []; fixture.delivered = []; fixture.modelCalls = [];
  fixture.slots = ['14:00', '15:00'].map(time => ({ date: '2026-10-02', time, iso: `2026-10-02T${time}:00.000Z` }));
});
afterEach(() => vi.useRealTimers());

describe('future interest is not a request to begin booking', () => {
  it.each(DECLINES)('does not turn a refusal into a positive booking request: %s', message => {
    expect(declinesBookingNow(message)).toBe(true);
    expect(hasExplicitBookingRequest(message)).toBe(false);
    expect(looksLikeABookingOpening(message, treatments)).toBe(false);
  });
  it.each(PROBLEMS)('recognises a booking failure mixed with a future plan: %s', message => {
    expect(isBookingProblem(message)).toBe(true);
    expect(isPassiveBookingInterest(message)).toBe(false);
    expect(clientQuestionScenario(message)?.kind).toBe('booking_problem');
  });
  it.each(CHANGES)('keeps a current appointment change actionable despite future-interest wording: %s', message => {
    expect(isPassiveBookingInterest(message)).toBe(false);
    expect(replyIsOwed(message, { intent: 'reschedule' })).toBe(true);
  });
  it.each(['I’m waiting for the verification code', 'Still waiting for my confirmation email', 'I’m waiting for a reply', 'I’m watching for redness around my brows', 'Keeping an eye out for December dates but my confirmation hasn’t arrived'])('does not hide an unresolved problem as passive future interest: %s', message => {
    expect(isPassiveBookingInterest(message)).toBe(false);
  });
  it.each([FIRST, SECOND, 'I’ll keep an eye out for December dates xx', 'Just planning my Christmas brows for now', 'This helps me decide what I’ll book in December'])('does not treat this statement as a new booking opening: %s', message => {
    expect(looksLikeABookingOpening(message, treatments)).toBe(false);
  });
  it.each([FIRST, SECOND, 'I’ll keep an eye out for December dates xx', 'This helps me decide what I’ll book in December'])('recognises passive future interest before consulting a model: %s', message => {
    expect(isPassiveBookingInterest(message)).toBe(true);
  });
  it.each(['Can I book Hybrid brows tomorrow?', 'Please book me Hybrid brows', 'I would like to book in for December 7th', 'Any appointments free tomorrow?'])('preserves a direct request: %s', message => {
    expect(looksLikeABookingOpening(message, treatments)).toBe(true);
  });
  it.each(['I’m watching for December dates, but can I book Hybrid brows tomorrow?', 'Keeping an eye out for Christmas. Please book me Hybrid brows first.', 'I’ll decide about December later, do you have appointments tomorrow?'])('does not silence a separate explicit request mixed with future interest: %s', message => {
    expect(looksLikeABookingOpening(message, treatments)).toBe(true);
    expect(isPassiveBookingInterest(message)).toBe(false);
    expect(hasExplicitBookingRequest(message)).toBe(true);
  });
});

describe('the actual front desk stays quiet on future/watch statements', () => {
  it.each(PROBLEMS)('holds a mixed booking failure for support without sending or booking: %s', async message => {
    fixture.db.messages.push(row('inbound', message));
    const result = await processInboundMessage('inbound', owner, client, message, 'instagram');
    expect(result.error).toBeUndefined();
    expect(result.quiet).not.toBe(true);
    expect(result.escalated).toBe(true);
    expect(fixture.db.messages.find(row => row.id === 'inbound')).toMatchObject({ escalated: true, escalated_reason: 'booking_support:booking_problem' });
    expect(fixture.delivered).toHaveLength(0);
    expect(bookingWrites()).toEqual([]);
    expect(fixture.modelCalls).toHaveLength(0);
  });
  it.each(DECLINES.flatMap(message => [false, true].map(existingState => ({ message, existingState }))))('respects refusal with an existing booking state=$existingState: $message', async ({ message, existingState }) => {
    if (existingState) fixture.db.booking_conversations.push(liveState());
    const before = structuredClone(fixture.db.booking_conversations);
    expect(await advance(message)).toBeNull();
    fixture.db.messages.push(row('inbound', message));
    const result = await processInboundMessage('inbound', owner, client, message, 'instagram');
    expect(result.error).toBeUndefined();
    expect(result.handled).not.toBe(true);
    expect(fixture.delivered).toHaveLength(0);
    expect(bookingWrites()).toEqual([]);
    expect(fixture.db.booking_conversations).toEqual(before);
  });
  it.each(CHANGES)('keeps a mixed appointment-change request visible to the owner: %s', async message => {
    fixture.db.messages.push(row('inbound', message));
    const result = await processInboundMessage('inbound', owner, client, message, 'instagram');
    expect(result.error).toBeUndefined();
    expect(result.quiet).not.toBe(true);
    expect(result.escalated).toBe(true);
    expect(fixture.db.messages.find(row => row.id === 'inbound').escalated).toBe(true);
    expect(bookingWrites()).toEqual([]);
  });
  it.each(['blocked_client', 'empty_menu'])('does not replace an explicit request declined by the booking path with a generated reply: %s', async reason => {
    if (reason === 'blocked_client') fixture.db.clients[0].blocked_at = NOW.toISOString();
    if (reason === 'empty_menu') fixture.db.treatments = [];
    const message = 'Can I book Hybrid brows tomorrow?';
    fixture.db.messages.push(row('inbound', message));
    const result = await processInboundMessage('inbound', owner, client, message, 'instagram');
    expect(result.error).toBeUndefined();
    expect(result.handled).not.toBe(true);
    expect(result.escalated).toBe(true);
    expect(fixture.delivered).toHaveLength(0);
    expect(bookingWrites()).toEqual([]);
    expect(fixture.modelCalls).toHaveLength(1);
    expect(fixture.modelCalls[0].system).toMatch(/intent classifier/i);
    expect(fixture.db.messages.find(row => row.id === 'inbound')).toMatchObject({ escalated: true, escalated_reason: 'booking_request:unclear', ai_response: null });
  });
  it.each(['I’m waiting for the verification code', 'Still waiting for my confirmation email', 'Keeping an eye out for December dates. I want to speak to Mara', 'Keeping an eye out for December dates but I am nervous about my brows'])('does not silently clear a support or human request: %s', async message => {
    fixture.db.messages.push(row('inbound', message));
    const result = await processInboundMessage('inbound', owner, client, message, 'instagram');
    expect(result.error).toBeUndefined();
    expect(result.quiet).not.toBe(true);
    expect(fixture.db.messages.find(row => row.id === 'inbound').escalated).toBe(true);
    expect(bookingWrites()).toEqual([]);
  });
  it.each([false, true])('does not progress either screenshot statement with an existing booking state=%s', async existingState => {
    if (existingState) fixture.db.booking_conversations.push(liveState());
    const before = structuredClone(fixture.db.booking_conversations);
    for (const [i, message] of [FIRST, SECOND].entries()) {
      const id = `inbound-${i}`;
      fixture.db.messages.push(row(id, message));
      const result = await processInboundMessage(id, owner, client, message, 'instagram');
      expect(result.error).toBeUndefined();
      expect(result.quiet).toBe(true);
    }
    expect(fixture.delivered).toHaveLength(0);
    expect(fixture.modelCalls).toHaveLength(0);
    expect(bookingWrites()).toEqual([]);
    expect(fixture.db.booking_conversations).toEqual(before);
  });
  it('does not revive a booking when the watch statement follows a marked story', async () => {
    fixture.db.messages.push(row('story', `This helped with December\n${INSTAGRAM_STORY_UNAVAILABLE_MARKER}`, { media_type: 'story_reply', escalated: true, escalated_reason: 'story_context:unavailable' }), row('inbound', SECOND));
    const result = await processInboundMessage('inbound', owner, client, SECOND, 'instagram');
    expect(result.error).toBeUndefined();
    expect(result.quiet).toBe(true);
    expect(fixture.delivered).toHaveLength(0);
    expect(fixture.modelCalls).toHaveLength(0);
    expect(bookingWrites()).toEqual([]);
  });
  it('does not use a generic generated booking prompt when the engine rejects a bare date', async () => {
    const message = 'December 7th 😂 xx';
    fixture.db.messages.push(row('inbound', message));
    const result = await processInboundMessage('inbound', owner, client, message, 'instagram');
    expect(result.error).toBeUndefined();
    expect(result.handled).not.toBe(true);
    expect(fixture.delivered).toHaveLength(0);
    expect(bookingWrites()).toEqual([]);
  });
});

describe('the actual booking engine requires present booking intent', () => {
  it.each([FIRST, SECOND])('cannot start from a passive statement despite a confident booking label: %s', async message => {
    expect(await advance(message)).toBeNull();
    expect(bookingWrites()).toEqual([]);
  });
  it.each([FIRST, SECOND])('does not advance or abandon active treatment selection on a passive statement: %s', async message => {
    fixture.db.booking_conversations.push(liveState());
    const before = structuredClone(fixture.db.booking_conversations);
    expect(await advance(message)).toBeNull();
    expect(bookingWrites()).toEqual([]);
    expect(fixture.db.booking_conversations).toEqual(before);
  });
  it('still begins a genuine request to book', async () => {
    const result = await advance('Can I book in please?');
    expect(result?.step).toBe('awaiting_treatment');
    expect(fixture.db.booking_conversations[0]?.step).toBe('awaiting_treatment');
  });
  it.each(['Hybrid brows please', 'Yes please', 'The first one'])('still accepts an actual answer during treatment selection: %s', async message => {
    const state = liveState();
    // A numbered choice is only meaningful when the conversation offered a list.
    if (message === 'The first one') state.offered.push({ treatment_id: 'lash', name: 'Lash tint' });
    fixture.db.booking_conversations.push(state);
    const result = await advance(message);
    expect(result?.step).toBe('awaiting_pick');
    expect(fixture.db.booking_conversations[0]?.step).toBe('awaiting_pick');
    expect(fixture.db.booking_conversations[0]?.treatment_id).toBe('hybrid');
    expect(fixture.db.appointments || []).toHaveLength(0);
  });
});
