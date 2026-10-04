import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ db: {}, writes: [], modelCalls: [], delivered: [], slots: [], override: 'florrie', intent: 'general_question', participation: null, confidence: 0.95, reads: [], pushes: [], onWriter: null, writerResponse: null, failConversationReads: false, bookingHook: null }));
function builder(table) {
  fixture.reads.push(table);
  let action; let payload; let fields; let head = false; let order; let limit = Infinity;
  const filters = [];
  const settle = () => {
    if (table === 'messages' && !action && fixture.failConversationReads) return { data: null, error: { message: 'Synthetic thread read failure' } };
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
    if (/intent classifier/i.test(request.system)) return { content: [{ text: JSON.stringify({ intent: fixture.intent, confidence: fixture.confidence, extracted: {}, ...(fixture.participation ? { participation: fixture.participation } : {}) }) }] };
    if (fixture.onWriter) { const callback = fixture.onWriter; fixture.onWriter = null; await callback(); }
    return { content: [{ type: 'text', text: fixture.writerResponse || 'Amazing, which treatment you thinking xxx' }] };
  } }; }
} }));
vi.mock('stripe', () => ({ default: class { constructor() { this.checkout = { sessions: { create: async () => { throw new Error('No payment session should be created'); } } }; } } }));
vi.mock('../../src/services/conversational-booking.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, advanceBookingConversation: async args => fixture.bookingHook
    ? fixture.bookingHook(args) : actual.advanceBookingConversation(args) };
});
vi.mock('../../src/lib/knowledge.js', () => ({ retrieveKnowledge: async () => [], renderKnowledgeBlock: () => '', arrivalNoteFrom: () => '', writtenNotesFrom: () => '' }));
vi.mock('../../src/lib/free-slots.js', () => ({ getFreeSlots: async () => fixture.slots, nowInSalonWall: () => new Date('2026-10-01T11:00:00Z') }));
vi.mock('../../src/lib/schema-probe.js', () => ({ hasColumn: async () => true }));
vi.mock('../../src/lib/inbound-budget.js', () => ({ inboundBudget: () => ({ allowed: true }) }));
vi.mock('../../src/lib/outbound-guard.js', () => ({ clientAutonomyOverride: async () => fixture.override, guardedSend: async ({ send }) => { if (send) await send(); return { decision: 'allow', sent: true }; }, classifyTier: () => 'service' }));
vi.mock('../../src/services/notifications.js', () => {
  const send = async args => { fixture.delivered.push(args); return true; };
  return { notifyBookingConfirmed: send, sendMessage: send, sendInstagramDM: send, sendWhatsAppText: send, sendSMS: send };
});
vi.mock('../../src/services/push-notifications.js', () => ({ pushEscalation: async (...args) => { fixture.pushes.push({ kind: 'escalation', args }); return true; }, pushTeamUpdate: async () => true, pushAtTheDoor: async (...args) => { fixture.pushes.push({ kind: 'arrival', args }); return true; } }));
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
const owner = { id: 'fictional-salon', first_name: 'Mara', business_name: 'Fictional Salon', timezone: 'Europe/London', booking_slug: 'fictional-salon', confidence_threshold: 0.9, booking_policy: {}, autonomy: { grounded_replies: true }, tone_model: {}, client_reminder_prefs: {} };
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
  fixture.override = 'florrie'; fixture.intent = 'general_question'; fixture.participation = null; fixture.confidence = 0.95; fixture.pushes = []; fixture.onWriter = null; fixture.writerResponse = null; fixture.failConversationReads = false; fixture.bookingHook = null;
  fixture.slots = ['14:00', '16:30', '17:30'].map(time => ({ date: '2026-10-05', time, iso: `2026-10-05T${time}:00.000Z` }));
});
afterEach(() => { __setAuthorshipAvailable(false); vi.useRealTimers(); });


const BIRTHDAY_THANKS = 'Thank you gorg ♥️♥️';
const responseModelCalls = () => fixture.modelCalls.filter(request => !/intent classifier/i.test(request.system));
const storedInbound = () => fixture.db.messages.find(message => message.id === 'answer');
function expectQuietWithoutSideEffects(result, writerCalls = 0) {
  expect(result.error).toBeUndefined();
  expect(result.handled).not.toBe(true);
  expect(result.quiet).toBe(true);
  expect(result.drafted).not.toBe(true);
  expect(fixture.delivered).toEqual([]);
  expect(responseModelCalls()).toHaveLength(writerCalls);
  expect(bookingWrites()).toEqual([]);
  expect(fixture.db.booking_conversations).toEqual([]);
  expect(fixture.writes.some(write => write.table === 'ai_actions')).toBe(false);
  expect(fixture.writes.some(write => write.table === 'clients')).toBe(false);
  expect(fixture.pushes).toEqual([]);
  expect(storedInbound()?.escalated).toBe(false);
  expect(storedInbound()?.ai_response ?? null).toBeNull();
  expect(fixture.db.messages.filter(message => message.direction === 'outbound' && message.authored_by === 'ai')).toEqual([]);
}

describe('conversation participation is decided before permission to answer', () => {
  it('keeps the exact birthday thank-you quiet before any model call, despite a Florrie override and high review confidence', async () => {
    fixture.intent = 'review_thanks';
    fixture.participation = { decision: 'service', evidence: BIRTHDAY_THANKS };
    const result = await receive(BIRTHDAY_THANKS);
    expectQuietWithoutSideEffects(result);
    expect(fixture.modelCalls).toEqual([]);
  });

  it('stays out of the owner’s birthday conversation when the birthday echo is present', async () => {
    fixture.intent = 'review_thanks';
    fixture.db.messages.push(row('owner-birthday', 'Happy birthday queeeen❤️❤️', {
      direction: 'outbound', authored_by: 'human', created_at: '2026-10-01T20:59:00Z',
    }));
    const result = await receive(BIRTHDAY_THANKS);
    expectQuietWithoutSideEffects(result);
    expect(fixture.modelCalls).toEqual([]);
    expect(fixture.db.messages.find(message => message.id === 'owner-birthday').content).toBe('Happy birthday queeeen❤️❤️');
  });

  it('does not let the greeting or thanks prefix silence an actual booking request', async () => {
    const text = 'Thanks gorg ♥️ can I book a brow lamination this month after 4pm please?';
    fixture.intent = 'booking_request';
    fixture.participation = { decision: 'service', evidence: 'can I book a brow lamination this month after 4pm please?' };
    const result = await receive(text);
    expect(result.error).toBeUndefined();
    expect(result.handled).toBe(true);
    expect(fixture.delivered).toHaveLength(1);
    expect(fixture.db.booking_conversations[0]?.step).toBe('awaiting_pick');
    expect(fixture.db.booking_conversations[0].offered.every(slot => slot.time >= '16:00')).toBe(true);
    expect(fixture.writes.some(write => write.table === 'appointments')).toBe(false);
    expect(responseModelCalls()).toEqual([]);
  });

  it('keeps a semantically personal question quiet even though it contains a question mark', async () => {
    const text = 'How was your birthday meal last night?';
    fixture.intent = 'general_question';
    fixture.participation = { decision: 'social', evidence: text };
    const result = await receive(text);
    expectQuietWithoutSideEffects(result);
    expect(fixture.modelCalls.length).toBeLessThanOrEqual(1);
  });

  it.each([
    ['uncertain participation', { decision: 'uncertain', evidence: 'What do you think about that?' }],
    ['missing participation', null],
    ['evidence copied from another message', { decision: 'service', evidence: 'Can I book a brow lamination?' }],
  ])('holds %s for review without inventing a reply', async (_label, participation) => {
    const text = 'What do you think about that?';
    fixture.intent = 'general_question';
    fixture.participation = participation;
    const result = await receive(text);
    expect(result.error).toBeUndefined();
    expect(result.handled).not.toBe(true);
    expect(result.drafted).not.toBe(true);
    expect(fixture.delivered).toEqual([]);
    expect(fixture.modelCalls).toHaveLength(1);
    expect(responseModelCalls()).toEqual([]);
    expect(bookingWrites()).toEqual([]);
    expect(storedInbound()?.escalated).toBe(true);
    expect(storedInbound()?.ai_response ?? null).toBeNull();
  });

  it('preserves a proven answer to Florrie’s treatment question without requiring a model opinion', async () => {
    seedQuestion();
    const result = await receive(ANSWER, { ...owner, autonomy: { grounded_replies: false } });
    expect(result.error).toBeUndefined();
    expect(result.handled).toBe(true);
    expect(fixture.delivered).toHaveLength(1);
    expect(fixture.modelCalls).toEqual([]);
    expect(fixture.db.booking_conversations[0]?.step).toBe('awaiting_pick');
    expect(fixture.writes.some(write => write.table === 'appointments')).toBe(false);
  });
});


describe('a generated reply cannot talk over a newer conversation turn', () => {
  const priceRequest = 'Can you send over your price list please?';
  function readyPriceReply() {
    fixture.intent = 'price_enquiry';
    fixture.participation = { decision: 'service', evidence: priceRequest };
    fixture.writerResponse = 'Brow lamination costs £35.';
  }
  it('does not answer an old inbound when a newer client message was already in the first context read', async () => {
    readyPriceReply();
    fixture.db.messages.push(row('already-newer', 'I have found the answer now', {
      created_at: '2026-10-01T21:00:01Z', authored_by: 'client',
    }));
    const result = await receive(priceRequest);
    expectQuietWithoutSideEffects(result);
    expect(fixture.modelCalls).toEqual([]);
    expect(storedInbound().escalated_reason).toBe('participation:newer_client_message');
  });

  it.each([
    ['owner reply', 'outbound', 'human'],
    ['new client message', 'inbound', 'client'],
  ])('stops an old reply when a same-channel %s arrives during generation', async (_label, direction, authored_by) => {
    readyPriceReply();
    fixture.onWriter = () => fixture.db.messages.push(row('new-turn', 'I have sorted it now', {
      direction, authored_by, created_at: '2026-10-01T21:00:01Z', send_status: 'sent',
    }));
    const result = await receive(priceRequest);
    expectQuietWithoutSideEffects(result, 1);
    expect(fixture.modelCalls).toHaveLength(2);
    expect(storedInbound().escalated_reason).toMatch(/owner_replied_during_processing|newer_client_message/);
  });

  it('does not let another channel’s owner message interrupt this Instagram reply', async () => {
    readyPriceReply();
    fixture.onWriter = () => fixture.db.messages.push(row('other-channel', 'I have sorted it now', {
      direction: 'outbound', authored_by: 'human', channel: 'whatsapp', created_at: '2026-10-01T21:00:01Z', send_status: 'sent',
    }));
    const result = await receive(priceRequest);
    expect(result.error).toBeUndefined();
    expect(result.handled).toBe(true);
    expect(fixture.delivered).toHaveLength(1);
    expect(fixture.delivered[0].text).toContain('Brow lamination costs £35.');
    expect(fixture.modelCalls).toHaveLength(2);
  });

  it('does not let another salon’s new message interrupt this tenant’s reply', async () => {
    readyPriceReply();
    fixture.onWriter = () => fixture.db.messages.push(row('other-owner', 'I have sorted it now', {
      beautician_id: 'different-fictional-salon', direction: 'outbound', authored_by: 'human',
      created_at: '2026-10-01T21:00:01Z', send_status: 'sent',
    }));
    const result = await receive(priceRequest);
    expect(result.error).toBeUndefined();
    expect(result.handled).toBe(true);
    expect(fixture.delivered).toHaveLength(1);
    expect(fixture.modelCalls).toHaveLength(2);
  });

  it('holds for owner review without a draft if the final conversation read fails', async () => {
    readyPriceReply();
    fixture.onWriter = () => { fixture.failConversationReads = true; };
    const result = await receive(priceRequest);
    expect(result.error).toBeUndefined();
    expect(result.handled).not.toBe(true);
    expect(result.drafted).not.toBe(true);
    expect(fixture.delivered).toEqual([]);
    expect(fixture.modelCalls).toHaveLength(2);
    expect(storedInbound()?.escalated).toBe(true);
    expect(storedInbound()?.escalated_reason).toBe('thread_refresh_unavailable');
    expect(storedInbound()?.ai_response ?? null).toBeNull();
    expect(bookingWrites()).toEqual([]);
  });
});


describe('completed service work remains visible when a newer message prevents its reply', () => {
  it.each([
    ['owner reply', 'outbound', 'human', 'owner_replied_during_processing'],
    ['new client message', 'inbound', 'client', 'newer_client_message'],
  ])('preserves the factual booking handoff after a %s arrives during the booking operation', async (_label, direction, authored_by, reason) => {
    const text = 'Can I book brow lamination please?';
    const factualReply = 'Your appointment is held pending the deposit: https://payments.fictional.test/held-booking';
    fixture.intent = 'booking_request';
    fixture.confidence = 0.99;
    fixture.participation = { decision: 'service', evidence: text };
    fixture.bookingHook = async () => {
      await builder('appointments').insert({ id: 'committed-hold', beautician_id: owner.id,
        client_id: client.id, status: 'pending', starts_at: '2026-10-05T16:30:00Z',
        payment_link: 'https://payments.fictional.test/held-booking' });
      fixture.db.messages.push(row('new-turn-during-hold', 'I will take it from here', {
        direction, authored_by, created_at: '2026-10-01T21:00:01Z', send_status: 'sent',
      }));
      return { reply: factualReply, actionPerformed: true, appointmentId: 'committed-hold',
        allowedTimes: ['16:30'], step: 'held', handOver: false };
    };
    const result = await receive(text);
    expect(result.error).toBeUndefined();
    expect(result.handled).not.toBe(true);
    expect(result.quiet).not.toBe(true);
    expect(result.escalated).toBe(true);
    expect(fixture.delivered).toEqual([]);
    expect(responseModelCalls()).toEqual([]);
    expect(fixture.db.appointments).toHaveLength(1);
    expect(fixture.db.appointments[0].id).toBe('committed-hold');
    expect(storedInbound().escalated).toBe(true);
    expect(storedInbound().escalated_reason).toBe(`${reason}:service_action_completed`);
    expect(storedInbound().ai_response).toBe(factualReply);
    expect(fixture.db.ai_actions.at(-1).action_type).toBe('message_escalated');
    expect(fixture.db.ai_actions.at(-1).details.suggested_response).toBe(factualReply);
    expect(fixture.pushes.some(push => push.kind === 'escalation')).toBe(true);
  });
});
