import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { clientQuestionScenario, diaryReleaseAnswer, diaryReleaseScope } from '../../src/lib/client-question.js';
import { answerClientQuestion } from '../../src/services/client-answers.js';
import { INSTAGRAM_STORY_UNAVAILABLE_MARKER } from '../../src/lib/instagram-story-context.js';

const fixture = vi.hoisted(() => ({ db: {}, writes: [], notes: [], delivered: [], bookingCalls: [], modelCalls: [], mode: 'florrie' }));
function builder(table) {
  let action = null; let payload; let head = false; let descending = false; let fields;
  const filters = [];
  const rows = () => (fixture.db[table] || []).filter(row => filters.every(filter => filter(row)));
  const settle = () => {
    let data = rows();
    if (action) fixture.writes.push({ table, action, payload });
    if (action === 'update') data.forEach(row => Object.assign(row, payload));
    if (action === 'insert') {
      data = (Array.isArray(payload) ? payload : [payload]).map((row, index) => ({ id: `${table}-${index}`, ...row }));
      (fixture.db[table] ||= []).push(...data);
    }
    if (descending) data = [...data].reverse();
    // Match the real transcript projection: metadata that the read does not
    // request must not accidentally make these route tests pass.
    if (table === 'messages' && fields && fields !== '*') data = data.map(row => Object.fromEntries(fields.split(',').map(key => key.trim()).filter(key => key in row).map(key => [key, row[key]])));
    return { data: head ? null : data, count: data.length, error: null };
  };
  const query = {
    select(value, options) { fields = value; head = options?.head === true; return query; },
    update(value) { action = 'update'; payload = value; return query; },
    insert(value) { action = 'insert'; payload = value; return query; },
    eq(key, value) { filters.push(row => row[key] === value); return query; },
    neq(key, value) { filters.push(row => row[key] !== value); return query; },
    in(key, values) { filters.push(row => values.includes(row[key])); return query; },
    is() { return query; }, not() { return query; }, or() { return query; },
    gte() { return query; }, lte() { return query; }, gt() { return query; }, lt() { return query; },
    order(_key, options) { descending = options?.ascending === false; return query; }, limit() { return query; },
    single() { const result = settle(); return Promise.resolve({ ...result, data: result.data?.[0] || null }); },
    maybeSingle() { return query.single(); },
    then(resolve, reject) { return Promise.resolve(settle()).then(resolve, reject); },
  };
  return query;
}
vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class {
  constructor() { this.messages = { create: async request => {
    fixture.modelCalls.push(request);
    if (/intent classifier/i.test(request.system)) return { content: [{ text: JSON.stringify({ intent: 'booking_request', confidence: 0.99, extracted: {} }) }] };
    throw new Error('Unapproved model reply must not be requested by an unknown diary announcement');
  } }; }
} }));
vi.mock('../../src/lib/knowledge.js', () => ({ retrieveKnowledge: async () => fixture.notes, renderKnowledgeBlock: () => '', arrivalNoteFrom: () => '', writtenNotesFrom: () => '' }));
vi.mock('../../src/services/conversational-booking.js', () => ({ advanceBookingConversation: async args => { fixture.bookingCalls.push(args); return null; } }));
vi.mock('../../src/services/notifications.js', () => {
  const send = async args => { fixture.delivered.push(args); return true; };
  return { notifyBookingConfirmed: send, sendMessage: send, sendInstagramDM: send, sendWhatsAppText: send, sendSMS: send };
});
vi.mock('../../src/services/push-notifications.js', () => ({ pushEscalation: async () => true, pushTeamUpdate: async () => true, pushAtTheDoor: async () => true }));
vi.mock('../../src/services/live-activity.js', () => ({ refreshLiveActivity: async () => true }));
vi.mock('../../src/services/automations.js', () => ({ createBookingSuggestion: async () => { throw new Error('No booking suggestion allowed'); } }));
vi.mock('../../src/services/loyalty.js', () => ({ getLoyaltyConfig: async () => null, getClientPoints: async () => 0, loyaltyProximity: () => null }));
vi.mock('../../src/lib/promos.js', () => ({ getActivePromos: async () => [], describePromo: () => '' }));
vi.mock('../../src/lib/free-slots.js', () => ({ getFreeSlots: async () => [] }));
vi.mock('../../src/lib/schema-probe.js', () => ({ hasColumn: async () => false }));
vi.mock('../../src/lib/inbound-budget.js', () => ({ inboundBudget: () => ({ allowed: true }) }));
vi.mock('../../src/lib/outbound-guard.js', () => ({ clientAutonomyOverride: async () => fixture.mode, guardedSend: async () => ({ decision: 'allow' }), classifyTier: () => 'service' }));

const { processInboundMessage } = await import('../../src/services/ai-front-desk.js');
const owner = { id: 'fictional-salon', first_name: 'Mara', business_name: 'Fictional Salon', timezone: 'Europe/London', booking_policy: { max_advance_days: 60 }, confidence_threshold: 0.9, autonomy: {}, client_reminder_prefs: {}, tone_model: {} };
const now = new Date('2026-10-01T10:00:00Z');
const screenshotQuestion = 'When is December dates out!! Need to book in asap xx';
const announcement = { id: 'december-policy', category: 'policy', title: 'December diary announcement', content: 'December appointments open on 12 October 2026 at 18:00. Availability is only confirmed when a booking is completed.', is_active: true };
const modelFor = note => vi.fn(async () => ({ content: [{ text: JSON.stringify({ covered: true, reply: 'December is a long way off. I can get you in sooner.', evidence: [{ id: note.id, quote: note.content }] }) }] }));
const answer = ({ message = screenshotQuestion, notes = [], scenario = clientQuestionScenario(message), askModel = vi.fn(), ...other } = {}) => answerClientQuestion({ message, scenario, context: { knowledge: notes, conversation: [] }, beautician: owner, now, askModel, ...other });

it('does not reuse a previous-year announcement when only the title carries its year', async () => {
  const note = { ...announcement, title: 'December 2025 diary opening', content: 'December appointments open on 12 October at 18:00.' };
  const askModel = modelFor(note);
  expect(await answer({ notes: [note], askModel })).toMatchObject({ canAnswer: false, reason: 'diary_release:announcement_unconfirmed' });
  expect(askModel).not.toHaveBeenCalled();
});

beforeEach(() => {
  fixture.db = {}; fixture.writes = []; fixture.notes = []; fixture.delivered = []; fixture.bookingCalls = []; fixture.modelCalls = []; fixture.mode = 'florrie';
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe('diary opening questions are not appointment requests', () => {
  it.each([
    screenshotQuestion,
    'When will you release December appointments?',
    'Are your December dates out yet?',
    'When do you open your diary for Christmas?',
    'Have your Xmas slots been released?',
    'Are your January bookings open yet?',
    'When are dates out?',
  ])('recognises the actual release question: %s', message => {
    expect(clientQuestionScenario(message)?.kind).toBe('diary_release');
  });
  it.each(['Can I book brow lamination on 22 December at 3pm?', 'Please book me 22 December', 'Do you open on Sundays?', 'What time is my December appointment?'])('does not replace an ordinary request with a release answer: %s', message => {
    expect(clientQuestionScenario(message)?.kind).not.toBe('diary_release');
  });
  it('keeps the original month when a client clarifies their release question', async () => {
    const question = 'When will December appointments open?';
    const scenario = { kind: 'diary_release', question: `${question}\nClient clarification: I mean the dates from your announcement` };
    const askModel = vi.fn();
    const result = await answer({ message: 'I mean the dates from your announcement', scenario, askModel });
    expect(result).toMatchObject({ canAnswer: false, reason: 'diary_release:announcement_unconfirmed' });
    expect(askModel).not.toHaveBeenCalled();
  });
});

describe('a booking limit is not a seasonal launch announcement', () => {
  it.each(['When are Dec dates out?', 'Are Sept appointments open yet?'])('does not mistake an abbreviated month for an unscoped booking-limit question: %s', async message => {
    expect(diaryReleaseScope(message)).not.toBeNull();
    expect(diaryReleaseAnswer({ message, beautician: owner, now })).toBeNull();
    expect(await answer({ message })).toMatchObject({ canAnswer: false, reason: 'diary_release:announcement_unconfirmed' });
  });
  it('does not interpret polite May I as a month', () => {
    expect(diaryReleaseScope('May I ask when your diary opens?')).toBeNull();
    expect(diaryReleaseScope('May I ask when December dates are out?')).toBe('december');
  });
  it.each([screenshotQuestion, 'When are Christmas dates released?', 'When are your January bookings open?', 'Your story said December opens soon. When can I book?', 'When does your Christmas promotion start for 20 December?'])('does not infer a launch from max_advance_days: %s', message => {
    expect(diaryReleaseAnswer({ message, beautician: owner, now })).toBeNull();
  });
  it('can explain the configured limit for a single exact date without claiming daily releases', () => {
    const result = diaryReleaseAnswer({ message: 'Can I book 20 December at 3pm?', beautician: owner, now });
    expect(result?.reply).toMatch(/\b60(?:-| )days?\b/);
    expect(result.reply).toContain('21 October');
    expect(result.reply).not.toMatch(/new date released each day|diary opens|book you in sooner/i);
  });
  it('holds a named-month question with no approved announcement and never asks a model to invent one', async () => {
    const askModel = vi.fn();
    const result = await answer({ askModel });
    expect(result).toMatchObject({ canAnswer: false, reason: 'diary_release:announcement_unconfirmed' });
    expect(result.reply).not.toMatch(/60 days|sooner|which treatment|what treatment|quite a way off/i);
    expect(askModel).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'generic-policy', category: 'policy', title: 'Booking policy', content: 'Clients may book up to 60 days ahead.' },
    { id: 'november-policy', category: 'policy', title: 'November dates', content: 'November dates open on 10 October at 18:00.' },
    { ...announcement, is_active: false },
  ])('does not treat an unrelated/inactive note as evidence: $id', async note => {
    const askModel = modelFor(note);
    expect(await answer({ notes: [note], askModel })).toMatchObject({ canAnswer: false, reason: 'diary_release:announcement_unconfirmed' });
    expect(askModel).not.toHaveBeenCalled();
  });
  it('shares the complete approved announcement, preserving its qualification instead of rewriting dates', async () => {
    const result = await answer({ notes: [announcement], askModel: modelFor(announcement) });
    expect(result.canAnswer).toBe(true);
    expect(result.reply).toBe(announcement.content);
    expect(result.sources).toEqual([expect.objectContaining({ id: announcement.id })]);
  });
  it('uses an approved Christmas announcement for an Xmas question without changing its facts', async () => {
    const note = { ...announcement, id: 'christmas-policy', title: 'Christmas diary', content: 'Christmas appointments open on 12 October 2026 at 18:00. Bookings are subject to availability.' };
    const result = await answer({ message: 'When are your Xmas slots out?', notes: [note], askModel: modelFor(note) });
    expect(result).toMatchObject({ canAnswer: true, reply: note.content });
  });
  it.each([
    { ...announcement, id: 'old-december-policy', content: 'December 2025 appointments open on 12 October 2025 at 18:00.' },
    { ...announcement, id: 'december-price', title: 'December treatment prices', content: 'December brow tint appointments cost £15.' },
  ])('does not approve a stale or price-only December note even when the model cites it: $id', async note => {
    const result = await answer({ notes: [note], askModel: modelFor(note) });
    expect(result.canAnswer).toBe(false);
  });
  it('does not use a current-year release to confirm next year\'s appointments', async () => {
    const result = await answer({ message: 'When are December 2027 dates out?', notes: [announcement], askModel: modelFor(announcement) });
    expect(result.canAnswer).toBe(false);
  });
  it('accepts a scoped release note written with the common abbreviated month', async () => {
    const note = { ...announcement, id: 'abbreviated-dec-policy', title: 'Dec diary', content: 'Dec 2026 appointments open on 12 October 2026 at 18:00. Bookings are subject to availability.' };
    const result = await answer({ notes: [note], askModel: modelFor(note) });
    expect(result).toMatchObject({ canAnswer: true, reply: note.content });
  });
  it.each(['today', 'tomorrow'])('does not reuse a relative %s announcement as a current release date', async relative => {
    const note = { ...announcement, content: `December appointments open ${relative} at 18:00.` };
    const askModel = modelFor(note);
    expect(await answer({ notes: [note], askModel })).toMatchObject({ canAnswer: false, reason: 'diary_release:announcement_unconfirmed' });
    expect(askModel).not.toHaveBeenCalled();
  });
  it('accepts an explicit dated release fact when the December scope is in the approved title', async () => {
    const note = { ...announcement, title: 'December 2026 diary announcement', content: 'Appointments open on 12 October 2026 at 18:00. Availability is confirmed when a booking is completed.' };
    const result = await answer({ notes: [note], askModel: modelFor(note) });
    expect(result).toMatchObject({ canAnswer: true, reply: note.content });
  });
});

describe('unseen story context remains uncertain until the salon answers', () => {
  const story = () => ({ direction: 'inbound', content: `Is this available?\n${INSTAGRAM_STORY_UNAVAILABLE_MARKER}`, media_type: 'story_reply', created_at: now.toISOString() });
  it('recognises the stored marker before classifying the client words', async () => {
    const message = `${screenshotQuestion}\n${INSTAGRAM_STORY_UNAVAILABLE_MARKER}`;
    const scenario = clientQuestionScenario(message);
    expect(scenario).toMatchObject({ kind: 'story_context', question: message });
    const askModel = vi.fn();
    expect(await answer({ message, scenario, notes: [announcement], askModel })).toMatchObject({ canAnswer: false, reason: 'story_context:unavailable' });
    expect(askModel).not.toHaveBeenCalled();
  });
  it('keeps a referential follow-up attached to the unseen story', () => {
    expect(clientQuestionScenario('How much is that?', [story()])?.kind).toBe('story_context');
  });
  it.each(['human', 'ai_edited'])('stops carrying missing context after a %s answer', authored_by => {
    const conversation = [story(), { direction: 'outbound', authored_by, content: 'That is our brow tint treatment, £15.', created_at: now.toISOString() }];
    expect(clientQuestionScenario('How much is that?', conversation)?.kind).not.toBe('story_context');
  });
  it('does not use a stale story to reinterpret a later message', () => {
    expect(clientQuestionScenario('How much is that?', [{ ...story(), created_at: new Date(now.getTime() - 49 * 60 * 60 * 1000).toISOString() }])?.kind).not.toBe('story_context');
  });
  it('allows a separate self-contained booking request to leave the story conversation', () => {
    expect(clientQuestionScenario('Can I book brow tint tomorrow?', [story()])?.kind).not.toBe('story_context');
  });
});

describe('the real front desk cannot route an unknown launch into a booking', () => {
  it('retains unresolved story context through a second follow-up using the actually selected transcript fields', async () => {
    const client = { id: 'fictional-client', beautician_id: owner.id, first_name: 'Client', instagram_id: 'fictional-ig', preferred_channel: 'instagram' };
    const row = (id, content, extra = {}) => ({ id, beautician_id: owner.id, client_id: client.id, direction: 'inbound', content, created_at: now.toISOString(), ...extra });
    fixture.db.treatments = [{ id: 'treatment', beautician_id: owner.id, name: 'Hybrid brows', is_active: true, booking_enabled: true, requires_patch_test: false }];
    const message = 'Can I book that tomorrow?';
    fixture.db.messages = [row('story', `How do I book this?\n${INSTAGRAM_STORY_UNAVAILABLE_MARKER}`), row('first-follow-up', 'How much is that?', { escalated: true, escalated_reason: 'story_context:unavailable' }), row('inbound', message)];
    const result = await processInboundMessage('inbound', { ...owner, autonomy: { grounded_replies: false } }, client, message, 'instagram');
    expect(result.error).toBeUndefined();
    expect(result.escalated).toBe(true);
    expect(fixture.modelCalls).toHaveLength(0);
    expect(fixture.bookingCalls).toHaveLength(0);
    expect(fixture.delivered).toHaveLength(0);
    expect(fixture.db.messages.find(row => row.id === 'inbound')).toMatchObject({ escalated: true, escalated_reason: 'story_context:unavailable' });
  });
  it.each([
    { grounded: true, message: screenshotQuestion, reason: 'diary_release:announcement_unconfirmed' },
    { grounded: false, message: screenshotQuestion, reason: 'diary_release:announcement_unconfirmed' },
    { grounded: true, message: `${screenshotQuestion}\n${INSTAGRAM_STORY_UNAVAILABLE_MARKER}`, reason: 'story_context:unavailable' },
    { grounded: false, message: `${screenshotQuestion}\n${INSTAGRAM_STORY_UNAVAILABLE_MARKER}`, reason: 'story_context:unavailable' },
  ])('holds $reason even with explicit Florrie mode and grounded_replies=$grounded', async ({ grounded, message, reason }) => {
    const client = { id: 'fictional-client', beautician_id: owner.id, first_name: 'Client', instagram_id: 'fictional-ig', preferred_channel: 'instagram' };
    fixture.db.treatments = [{ id: 'treatment', beautician_id: owner.id, name: 'Hybrid brows', is_active: true, booking_enabled: true, requires_patch_test: false }];
    fixture.db.messages = [{ id: 'inbound', beautician_id: owner.id, client_id: client.id, direction: 'inbound', content: message, created_at: now.toISOString() }];
    const result = await processInboundMessage('inbound', { ...owner, autonomy: { grounded_replies: grounded } }, client, message, 'instagram');
    expect(result.error).toBeUndefined();
    expect(result.escalated).toBe(true);
    expect(fixture.bookingCalls).toHaveLength(0);
    expect(fixture.delivered).toHaveLength(0);
    expect(fixture.modelCalls).toHaveLength(0);
    expect(fixture.writes.some(write => ['appointments', 'booking_conversations'].includes(write.table))).toBe(false);
    expect(fixture.db.messages[0]).toMatchObject({ ai_intent: 'general_question', escalated: true, escalated_reason: reason });
    expect(fixture.db.messages[0].ai_response).not.toMatch(/sooner|what treatment|quite a way off/i);
  });
});
