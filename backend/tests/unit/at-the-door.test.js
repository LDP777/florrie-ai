/**
 * 27 AUGUST 2026. THE CONVERSATION THIS FILE REPLAYS.
 *
 *   11:32  in   client  "Im 60 seconds away!"
 *   11:32  out  ai      "Oh I'm ready! I'll come get you xx"     escalated: false
 *   11:33  out  human   "Come through when you're here! It's a bit hecgiv"
 *   11:33  out  human   "Hectic with the festival staff**"
 *
 * It auto-sent. escalated: false means no gate held it. One minute later the
 * owner was writing over the top of her own assistant, to a client already
 * standing at the door.
 *
 * READ THE 11:33 LINE, because it is the specification. A correct answer to a
 * doorstep message EXISTS, Ellie wrote it in nine words, and she should not
 * have had to type it while she was dealing with festival staff. Florrie's
 * failure was not that she spoke. It was that she spoke FROM NOTHING: "I'm
 * ready" about a room she cannot see, "I'll come get you" about a body she does
 * not have, and Ellie had to contradict both.
 *
 * So this file does NOT enforce silence about doorsteps. An earlier version of
 * it did, and that is a worse product: it leaves a client standing outside with
 * nothing at all while the owner finds her phone. What it enforces is the shape
 * the rest of this codebase already uses (lib/free-slots.js, lib/knowledge.js):
 *
 *   Florrie may answer a client at the door FROM A FACT THE OWNER WROTE DOWN,
 *   in the owner's own words, and from nothing else. With no arrival note on
 *   file she says nothing. Either way the owner is buzzed within a second.
 *
 * Three fences, and each one is tested here:
 *
 *   1. the note exists, or Florrie does not speak      (mayFlorrieSend)
 *   2. the note is what she speaks from                (the prompt)
 *   3. the note is checked FACET BY FACET on the way out, so a note about
 *      parking never licenses "come through"           (checkReplyClaims)
 *
 * Every pipeline case scripts the model to write something and asserts on what
 * actually reached the client's phone and what actually reached the owner's.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* ------------------------------------------------------------------ clock --
 * Fixed, because it must be. gatherContext reads "now" to find upcoming
 * bookings, and pushAtTheDoor stamps its duplicate suppressor with Date.now().
 * Three clock-dependent tests were found in this repo in a single day, each
 * green at noon and red at night. This one is pinned to the morning it
 * happened.
 */
const THAT_MORNING = new Date('2026-08-27T11:32:00.000Z');

/* ------------------------------------------------------------------ schema --
 * Columns copied from supabase/migrations for the tables this path writes.
 * A wrong name is rejected by PostgREST for the whole statement and the error
 * is usually swallowed, which is how an escalation becomes a silence.
 *
 *   messages           001_initial_schema.sql (ai_handled, ai_confidence,
 *                      ai_intent, ai_response, tone_match_score, escalated,
 *                      escalated_reason), plus digital_employee and the
 *                      authorship columns.
 *   ai_actions         001_initial_schema.sql, plus `status` from
 *                      20260803_schema_drift_columns.sql. outcome keeps its
 *                      CHECK.
 *   knowledge_entries  20260801_backend019_knowledge_base.sql, with the
 *                      category CHECK widened by
 *                      20260827_backend022_knowledge_arrival.sql. The CHECK is
 *                      modelled here on purpose: without migration 022 an
 *                      arrival note cannot be saved at all and the whole
 *                      feature is dead in production.
 */
const COLUMNS = {
  ai_actions: [
    'id', 'beautician_id', 'action_type', 'digital_employee', 'summary', 'details',
    'confidence', 'autonomous', 'client_id', 'appointment_id', 'message_id',
    'outcome', 'notification_sent', 'notification_text', 'created_at', 'status',
  ],
  knowledge_entries: [
    'id', 'beautician_id', 'category', 'title', 'content', 'is_active',
    'created_at', 'updated_at',
  ],
};
const OUTCOMES = ['success', 'pending', 'failed', 'escalated'];
const KNOWLEDGE_CATEGORIES_IN_DB = [
  'arrival', 'aftercare', 'policy', 'treatment', 'prep', 'faq', 'general',
];

const db = {};
const table = (name) => (db[name] = db[name] || []);

const undefinedColumn = (t, col) => ({
  code: '42703', message: `column ${t}.${col} does not exist`, details: null, hint: null,
});

function checkWrite(t, payload) {
  const known = COLUMNS[t];
  if (!known) return null;
  for (const row of (Array.isArray(payload) ? payload : [payload])) {
    for (const col of Object.keys(row || {})) {
      if (!known.includes(col)) return undefinedColumn(t, col);
    }
    if (t === 'ai_actions' && row?.outcome != null && !OUTCOMES.includes(row.outcome)) {
      return { code: '23514', message: 'new row violates check constraint "ai_actions_outcome_check"' };
    }
    if (t === 'knowledge_entries' && row?.category != null
        && !KNOWLEDGE_CATEGORIES_IN_DB.includes(row.category)) {
      return { code: '23514', message: 'new row violates check constraint "knowledge_entries_category_check"' };
    }
  }
  return null;
}

let idCounter = 0;
function builder(name) {
  const filters = [];
  let pending = null;
  let head = false;
  let err = null;
  const rows = () => table(name).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (err) return { data: null, error: err, count: null };
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: `${name}_${++idCounter}`, created_at: new Date().toISOString(), ...p }));
      table(name).push(...created);
      return { data: created, error: null, count: created.length };
    }
    if (pending?.op === 'update') { for (const r of rows()) Object.assign(r, pending.payload); return { data: rows(), error: null }; }
    if (head) return { data: null, error: null, count: rows().length };
    return { data: rows(), error: null, count: rows().length };
  };
  const b = {
    select(spec = '*', opts) { if (opts?.head) head = true; return b; },
    insert(p) { err = err || checkWrite(name, p); pending = { op: 'insert', payload: p }; return b; },
    update(p) { err = err || checkWrite(name, p); pending = { op: 'update', payload: p }; return b; },
    delete() { pending = { op: 'delete' }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not() { return b; },
    or() { return b; },
    filter() { return b; },
    gt(c, v) { filters.push(r => String(r[c] ?? '') > String(v)); return b; },
    gte(c, v) { filters.push(r => String(r[c] ?? '') >= String(v)); return b; },
    lt(c, v) { filters.push(r => String(r[c] ?? '') < String(v)); return b; },
    lte(c, v) { filters.push(r => String(r[c] ?? '') <= String(v)); return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));

/* -------------------------------------------------------------------- LLM --
 * Scripted, and it writes THE PRODUCTION SENTENCE by default. Every model call
 * is recorded on the timeline below, so the test can assert that the owner was
 * buzzed BEFORE any of them, which is the difference between a notification
 * that beats her to the door and one that does not.
 */
const timeline = [];
const prompts = [];
const script = {
  classification: { intent: 'greeting', confidence: 0.99, extracted: {} },
  reply: "Oh I'm ready! I'll come get you xx",
};
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      this.messages = {
        create: async ({ system }) => {
          if (/intent classifier/i.test(system)) {
            timeline.push('model:classify');
            return { content: [{ text: JSON.stringify(script.classification) }] };
          }
          if (/evaluating how well a generated response matches/i.test(system)) {
            return { content: [{ text: '0.9' }] };
          }
          timeline.push('model:write');
          prompts.push(system);
          return { content: [{ text: script.reply }] };
        },
      };
    }
  },
}));

/* ------------------------------------------------- what reaches the client --
 * Every outbound channel, captured, so "did anything reach her" is answered by
 * the wire rather than by a database row.
 */
const delivered = [];
vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async () => ({ sent: true, channels: ['email'] }),
  sendMessage: async (args) => { delivered.push({ channel: 'message', ...args }); return { channel: 'sms' }; },
  sendInstagramDM: async (args) => { delivered.push({ channel: 'instagram', ...args }); return true; },
  sendWhatsAppText: async (args) => { delivered.push({ channel: 'whatsapp', ...args }); return true; },
  sendSMS: async (args) => { delivered.push({ channel: 'sms', ...args }); return { channel: 'sms' }; },
}));

/* -------------------------------------------------- what reaches the owner --
 * pushAtTheDoor is the one under test at the pipeline level: was it called, with
 * her words, before anything slow. Its own delivery behaviour (no toggle can
 * silence it, no throttle holds it, SMS when no device takes it) is a separate
 * file, at-the-door-alert.test.js, because it needs the real module.
 */
const doorPushes = [];
const escalationPushes = [];
vi.mock('../../src/services/push-notifications.js', () => ({
  pushEscalation: async (id, name, preview) => { timeline.push('push:escalation'); escalationPushes.push({ id, name, preview }); return true; },
  pushTeamUpdate: async () => true,
  pushAtTheDoor: async (id, name, preview, opts) => {
    timeline.push('push:at-the-door');
    doorPushes.push({ id, name, preview, opts });
    return { delivered: 1, channel: 'push' };
  },
}));

vi.mock('../../src/services/live-activity.js', () => ({ refreshLiveActivity: async () => true }));
vi.mock('../../src/services/automations.js', () => ({ createBookingSuggestion: async () => ({ id: 's1' }) }));
vi.mock('../../src/services/conversational-booking.js', () => ({ advanceBookingConversation: async () => null }));
vi.mock('../../src/services/loyalty.js', () => ({
  getLoyaltyConfig: async () => null, getClientPoints: async () => 0, loyaltyProximity: () => null,
}));
vi.mock('../../src/lib/promos.js', () => ({ getActivePromos: async () => [], describePromo: () => null }));
vi.mock('../../src/lib/free-slots.js', () => ({ getFreeSlots: async () => [] }));
vi.mock('../../src/services/whatsapp-metering.js', () => ({ getMonthlyUsage: async () => null }));
vi.mock('../../src/lib/marketing-guard.js', () => ({ inMarketingQuietHours: () => false }));

/* lib/knowledge.js is deliberately NOT mocked. The whole fix turns on one entry
 * being retrieved for a message it shares no keywords with, so a stub that just
 * hands back an array would test nothing. Real retrieval, against the fake
 * knowledge_entries table above. */

process.env.ANTHROPIC_API_KEY = 'sk-test';

const { processInboundMessage, mayFlorrieSend, replyIsOwed } =
  await import('../../src/services/ai-front-desk.js');
const { checkReplyClaims, HOLDING_REPLY, safeReply } =
  await import('../../src/lib/reply-claims-guard.js');
const { atTheDoorPhrase, isGroundedReply } = await import('../../src/lib/grounded-reply.js');
const { arrivalNoteFrom, writtenNotesFrom } = await import('../../src/lib/knowledge.js');

/* ------------------------------------------------------------------ world -- */
const SHE_WROTE = 'Im 60 seconds away!';
const MSG_ID = 'msg_1132';

// What Ellie actually said at 11:33, turned into the note she should only ever
// have to write once.
const HER_NOTE = 'Come through when you get here, no need to knock.';
const PARKING_ONLY = 'Parking is on Mill Street, two minutes walk away.';

let beautician;
let client;

/** Put one of Ellie's own notes on file. */
function writeNote(content, category = 'arrival') {
  table('knowledge_entries').push({
    id: `k_${table('knowledge_entries').length + 1}`,
    beautician_id: 'b1', category, title: 'When you arrive',
    content, is_active: true,
  });
}

/** Reset the world without re-running the whole beforeEach. */
function freshWorld(content = SHE_WROTE) {
  for (const t of Object.keys(db)) delete db[t];
  delivered.length = 0;
  doorPushes.length = 0;
  escalationPushes.length = 0;
  timeline.length = 0;
  prompts.length = 0;
  table('beauticians').push(beautician);
  table('clients').push(client);
  table('messages').push({
    id: MSG_ID, beautician_id: 'b1', client_id: 'c1', direction: 'inbound',
    content, created_at: THAT_MORNING.toISOString(),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(THAT_MORNING);
  idCounter = 0;
  script.classification = { intent: 'greeting', confidence: 0.99, extracted: {} };
  script.reply = "Oh I'm ready! I'll come get you xx";

  beautician = {
    id: 'b1', first_name: 'Ellie', business_name: 'Ell Indigo', booking_slug: 'ellindigo',
    confidence_threshold: 0.9, tone_model: {}, autonomy: {}, working_hours: null,
    timezone: 'Europe/London', client_reminder_prefs: {}, voice_profile: null,
  };
  client = {
    id: 'c1', first_name: 'Nicole', phone: '+447700900123', preferred_channel: 'sms',
    messaging_autonomy: null, marketing_consent: true, marketing_opted_out_at: null,
  };
  freshWorld();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Everything that actually left for the client, on any channel. */
const textsToClient = () => delivered.map(d => d.body || d.text).filter(Boolean);
const outboundRows = () => table('messages').filter(m => m.direction === 'outbound');
const messageRow = () => table('messages').find(m => m.id === MSG_ID);
const escalations = () => table('ai_actions').filter(a => a.action_type === 'message_escalated');

/* ====================================== 11:32, with nothing written down ==== */
describe('11:32, a client sixty seconds from the door, and no arrival note', () => {
  it('sends her nothing, because there is nothing true to say', async () => {
    await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);

    // Not the production sentence, not an invented one, not anything. Nobody
    // had written down what happens when a client arrives, so every word of an
    // answer would have been Florrie's own invention. That is what "I'm ready"
    // was.
    expect(textsToClient(), 'Florrie sent the client something').toEqual([]);
    expect(outboundRows(), 'an outbound message was recorded').toEqual([]);

    // The owner was told, in the client's own words.
    expect(doorPushes).toHaveLength(1);
    expect(doorPushes[0].id).toBe('b1');
    expect(doorPushes[0].name).toBe('Nicole');
    expect(doorPushes[0].preview).toBe(SHE_WROTE);
    expect(doorPushes[0].opts?.clientId).toBe('c1');
  });

  it('records it honestly, with escalated true and the real reason', async () => {
    await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);

    const row = messageRow();
    // escalated: false is the line in the production export that says nothing
    // held this. It has to read the other way now.
    expect(row.escalated).toBe(true);
    expect(row.ai_handled).toBe(false);
    expect(row.escalated_reason).toMatch(/at_the_door/i);

    expect(escalations()).toHaveLength(1);
    expect(escalations()[0].details.reason).toMatch(/at_the_door/i);
    expect(escalations()[0].details.alerted_by).toBe('push');
    expect(escalations()[0].notification_text).toMatch(/at the door now/i);
  });

  it('buzzes her before it spends a second on anything else', async () => {
    await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);

    // A draft in a queue is worth nothing to somebody already on the step, and
    // the ordinary escalation path runs a classifier and then a second model
    // call to write a draft BEFORE it notifies anybody. The doorstep alert
    // jumps all of it.
    expect(timeline[0]).toBe('push:at-the-door');
    expect(timeline).toContain('model:classify');
    expect(timeline.indexOf('push:at-the-door')).toBeLessThan(timeline.indexOf('model:classify'));
  });

  it('does not buzz her twice for the same message', async () => {
    await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);
    // pushEscalation is the generic "Needs you", which is on 142 messages a
    // month. A second notification for the same client teaches her to ignore
    // both, so the doorstep alert replaces it rather than joining it.
    expect(escalationPushes).toEqual([]);
  });

  it('holds it even when the model is certain and the thread is whitelisted', async () => {
    // The 27 August message was auto-sent with nothing standing in the way.
    // Confidence is irrelevant when the fact is missing: the model can be
    // completely certain and still have nothing behind it.
    client.messaging_autonomy = 'florrie';
    script.classification = { intent: 'greeting', confidence: 1.0, extracted: {} };

    await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);

    expect(textsToClient()).toEqual([]);
    expect(messageRow().escalated).toBe(true);
    expect(doorPushes).toHaveLength(1);
  });

  it('holds it whatever the classifier decides it was', async () => {
    // The label is not the evidence. Every one of these was a real possibility
    // for "Im 60 seconds away!", and two of them (greeting, booking_lookup) are
    // grounded intents that Florrie answers on her own in two seconds.
    for (const intent of ['greeting', 'general_question', 'booking_lookup', 'price_enquiry', 'review_thanks', 'unknown']) {
      freshWorld();
      script.classification = { intent, confidence: 0.99, extracted: {} };

      await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);

      expect(textsToClient(), `sent something when the intent was ${intent}`).toEqual([]);
      expect(doorPushes, `did not tell the owner when the intent was ${intent}`).toHaveLength(1);
    }
  });

  it('does not go quiet on her instead, which is the other way to fail', async () => {
    // "Im 60 seconds away!" has no question mark and reads as a greeting, and a
    // short greeting falls through to the branch where Florrie reads a message,
    // records it and says nothing to anybody. That branch would leave the client
    // outside AND leave Ellie unaware, which is worse than the auto-send.
    const out = await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);

    expect(out.quiet).not.toBe(true);
    expect(messageRow().escalated).toBe(true);
    expect(replyIsOwed(SHE_WROTE, { intent: 'greeting' })).toBe(true);
  });

  it('still writes her a draft to tap, when the draft is one she could send', async () => {
    // An earlier version of this fix shipped NO draft for a doorstep message,
    // reasoning that anything worth saying is a fact only she holds. She would
    // still rather tap than type with somebody on the step, so the draft is
    // back: it is written under the doorstep tone rule and re-checked, and only
    // a draft the guard refuses is dropped.
    script.reply = 'Two minutes lovely.';

    await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);

    expect(textsToClient(), 'a draft is not a send').toEqual([]);
    expect(messageRow().ai_response).toBeTruthy();
    expect(escalations()[0].details.suggested_response).toBeTruthy();
  });

  it('ships no draft at all rather than one she is not allowed to send', async () => {
    // The production sentence, offered back to her as a one-tap, would be the
    // same lie with an extra step. The holding reply is not the answer either:
    // "let me check my book and come straight back to you" is sensible about a
    // diary question and nonsense to somebody standing outside.
    script.reply = "Oh I'm ready! I'll come get you xx";

    await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);

    expect(messageRow().ai_response ?? null).toBeNull();
    expect(escalations()[0].details.suggested_response ?? null).toBeNull();
    expect(textsToClient()).toEqual([]);
  });
});

/* ================================ 11:32, with the note she should have had == */
describe('11:32, with Ellie’s own arrival note on file', () => {
  beforeEach(() => {
    writeNote(HER_NOTE);
    script.reply = 'Come through when you get here, no need to knock.';
  });

  it('answers the client in Ellie’s own words, on its own', async () => {
    const out = await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);

    expect(out.handled).toBe(true);
    expect(textsToClient()).toHaveLength(1);
    expect(textsToClient()[0]).toContain('Come through when you get here');
    expect(messageRow().ai_handled).toBe(true);
    expect(messageRow().escalated).toBe(false);
  });

  it('STILL tells the owner, because somebody is at her door either way', async () => {
    // The alert is not a consolation prize for holding the reply. Ellie is the
    // one who has to look up when the door goes, whether or not Florrie has
    // already told the client to come through.
    await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);

    expect(doorPushes).toHaveLength(1);
    expect(doorPushes[0].preview).toBe(SHE_WROTE);
    expect(timeline[0]).toBe('push:at-the-door');
  });

  it('puts the note in front of the model, and tells it how to write', async () => {
    await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);

    const written = prompts.join('\n');
    // The note reaches the prompt at all, which lexical retrieval alone would
    // not manage: "Im 60 seconds away!" shares no keyword with it.
    expect(written).toContain('Come through when you get here');
    // And the tone rule, which is the half of 27 August that was not a lie.
    // "Oh I'm ready! ... xx" is not how Ellie writes.
    expect(written).toMatch(/ONE short sentence/);
    expect(written).toMatch(/No kisses/i);
  });

  it('does not force the note into an ordinary message', async () => {
    // An arrival note is not standing permission to say "come through" in the
    // middle of a reply about the price of a lash lift.
    freshWorld('How much is a lash lift?');
    writeNote(HER_NOTE);
    script.classification = { intent: 'price_enquiry', confidence: 0.99, extracted: {} };
    script.reply = 'A lash lift is 45 pounds and takes about an hour.';

    await processInboundMessage(MSG_ID, beautician, client, 'How much is a lash lift?');

    expect(doorPushes).toEqual([]);
    expect(prompts.join('\n')).not.toMatch(/ONE short sentence/);
  });

  it('still gives her a draft rather than a send on a thread set to just me', async () => {
    // A note makes the sentence TRUE. It does not overrule her saying she wants
    // this thread herself, so she gets the one-tap and the client gets nothing
    // until she taps it.
    client.messaging_autonomy = 'just_me';

    await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);

    expect(textsToClient()).toEqual([]);
    expect(messageRow().escalated).toBe(true);
    expect(messageRow().ai_response).toContain('Come through');
    expect(doorPushes).toHaveLength(1);
  });

  it('refuses the 27 August sentence even now, because no note can make it true', async () => {
    // The note says come through. It does not say she is ready, and it cannot:
    // she was dealing with festival staff. Both halves of the production reply
    // are refused outright, so the model writing it again changes nothing.
    script.reply = "Oh I'm ready! I'll come get you xx";

    await processInboundMessage(MSG_ID, beautician, client, SHE_WROTE);

    expect(textsToClient(), 'the 27 August reply went out again').toEqual([]);
    expect(messageRow().escalated).toBe(true);
    // Not the holding reply either. "Let me check my book and come straight
    // back to you" is what safeReply substitutes everywhere else, and it is a
    // brush-off to somebody standing on the step.
    expect(messageRow().ai_response ?? null).toBeNull();
    // And she is still told it is her door, not a generic "needs you". This
    // escalation arrives by the held-after-generation route, whose reason says
    // the guard refused the reply rather than naming the doorstep, so reading
    // the reason string here would have got it wrong.
    expect(escalations()[0].notification_text).toMatch(/at the door now/i);
  });
});

/* ====================================================== the gate, directly == */
describe('the gate that decides whether a machine speaks', () => {
  it('refuses a doorstep message with no note and allows one with a note', () => {
    const dials = {
      classification: { intent: 'greeting', confidence: 1.0 },
      groundedDecision: { grounded: true, reason: 'grounded:arrival_note' },
      known: true,
      autonomyOverride: null,
      threshold: 0.9,
      message: SHE_WROTE,
    };
    expect(mayFlorrieSend({ ...dials, arrivalNote: '' })).toBe(false);
    expect(mayFlorrieSend({ ...dials, arrivalNote: '   ' })).toBe(false);
    expect(mayFlorrieSend({ ...dials, arrivalNote: HER_NOTE })).toBe(true);
  });

  it('never sends a training enquiry itself, whatever the dials say', () => {
    // "It's messing up me trying to get the training people enrolled."
    // A course sale is Ellie's conversation. Every dial says yes here; the
    // gate still says draft.
    const dials = {
      classification: { intent: 'pricing', confidence: 1.0 },
      groundedDecision: { grounded: true, reason: 'grounded:price_list' },
      known: true,
      autonomyOverride: 'florrie',
      threshold: 0.5,
      arrivalNote: HER_NOTE,
    };
    expect(mayFlorrieSend({ ...dials, message: 'hi how much is your beginner course? x' })).toBe(false);
    expect(mayFlorrieSend({ ...dials, message: 'do you do any lash training' })).toBe(false);
    // "of course" is Ellie's own phrase and her clients' too: not a course.
    expect(mayFlorrieSend({ ...dials, message: 'of course! see you thursday, how much is a lift x' })).toBe(true);
  });

  it('drafts, never sends, for a salon with nothing written down or nobody paying', () => {
    const dials = {
      classification: { intent: 'pricing', confidence: 1.0 },
      groundedDecision: { grounded: true, reason: 'grounded:price_list' },
      known: true,
      autonomyOverride: 'florrie',
      threshold: 0.5,
      arrivalNote: HER_NOTE,
      message: 'how much is a lash lift? x',
    };
    expect(mayFlorrieSend({ ...dials })).toBe(true);
    // A brand-new account, Instagram connected on day one, no treatments yet.
    expect(mayFlorrieSend({ ...dials, salonHasAMenu: false })).toBe(false);
    // A trial that ended in March, with the enforcement flag on.
    expect(mayFlorrieSend({ ...dials, subscriptionLapsed: true })).toBe(false);
  });

  it('lets the ordinary dials have the last word once a note exists', () => {
    // 'just_me' is her saying not in this thread, and it still wins.
    expect(mayFlorrieSend({
      classification: { intent: 'greeting', confidence: 1.0 },
      groundedDecision: { grounded: true, reason: 'grounded:arrival_note' },
      known: true, autonomyOverride: 'just_me', threshold: 0.9,
      message: SHE_WROTE, arrivalNote: HER_NOTE,
    })).toBe(false);
  });

  it('is ungrounded without a note, and says so in the reason', () => {
    const verdict = isGroundedReply({
      intent: 'greeting', message: SHE_WROTE, context: {}, beauticianFirstName: 'Ellie',
    });
    expect(verdict.grounded).toBe(false);
    expect(verdict.reason).toMatch(/at_the_door_with_no_arrival_note/);
  });

  it('is grounded with a note, whatever the classifier called the message', () => {
    for (const intent of ['greeting', 'unknown', 'general_question', 'booking_request']) {
      const verdict = isGroundedReply({
        intent, message: SHE_WROTE, context: {}, beauticianFirstName: 'Ellie',
        arrivalNote: HER_NOTE,
      });
      expect(verdict.grounded, `not grounded when the intent was ${intent}`).toBe(true);
      expect(verdict.reason).toBe('grounded:arrival_note');
    }
  });

  it('still holds a note-backed reply that promises the owner will do something', () => {
    // "Ellie will come and get you" is a commitment made on somebody else's
    // behalf, in a building this process cannot see. No note covers that.
    const verdict = isGroundedReply({
      intent: 'greeting', message: SHE_WROTE, context: {},
      reply: 'Ellie will come and get you in a second',
      beauticianFirstName: 'Ellie', arrivalNote: HER_NOTE,
    });
    expect(verdict.grounded).toBe(false);
    expect(verdict.reason).toBe('reply_promises_a_human_action');
  });

  it('reads everything she has written for the guard, not only the arrival note', () => {
    // The GATE asks whether she wrote an arrival instruction. The GUARD asks
    // whether a given sentence is hers, and a parking FAQ written in March is
    // hers too. Handing the guard the arrival note alone refused "free parking
    // on Mill Road" on an ordinary question about parking, which is a message
    // that has nothing to do with a doorstep.
    const entries = [
      { category: 'faq', content: 'Free parking on Mill Road, two minutes walk from the door.' },
      { category: 'general', content: 'We are on the first floor above the bakery.' },
    ];
    expect(arrivalNoteFrom(entries)).toBe('');
    const notes = writtenNotesFrom(entries);

    for (const reply of ['There is free parking on Mill Road.', 'We are on the first floor.']) {
      expect(checkReplyClaims(reply, { allowedTimes: [] }).ok, `${reply} with nothing written down`).toBe(false);
      expect(checkReplyClaims(reply, { allowedTimes: [], arrivalNote: notes }).ok, reply).toBe(true);
    }
  });

  it('reads the note off the retrieved entries, and only the arrival ones', () => {
    expect(arrivalNoteFrom([])).toBe('');
    expect(arrivalNoteFrom([{ category: 'policy', content: 'Deposits are non refundable.' }])).toBe('');
    expect(arrivalNoteFrom([
      { category: 'policy', content: 'Deposits are non refundable.' },
      { category: 'arrival', content: HER_NOTE },
    ])).toBe(HER_NOTE);
    // A note she has switched off is a note she took down.
    expect(arrivalNoteFrom([{ category: 'arrival', content: HER_NOTE, is_active: false }])).toBe('');
  });
});

/* ================================================== the rest of the class == */
describe('the other things people say when they are already there', () => {
  const AT_THE_DOOR = [
    'Im 60 seconds away!',
    "I'm outside",
    "I'm here",
    'im here x',
    "I can't find you",
    "I'm running 10 minutes late",
    "I'm in the car park",
    'just parked up',
    'on my way now',
    'which door is it?',
    "I've knocked but no answer",
    'the door is locked',
    'shall I come in?',
    'stuck in traffic, so sorry',
    'where do I park?',
    'be there in 5',
  ];

  for (const words of AT_THE_DOOR) {
    it(`holds "${words}" and tells the owner when nothing is written down`, async () => {
      freshWorld(words);

      await processInboundMessage(MSG_ID, beautician, client, words);

      expect(textsToClient(), 'something reached the client').toEqual([]);
      expect(doorPushes, 'the owner was not told').toHaveLength(1);
      expect(messageRow().escalated).toBe(true);
    });
  }
});

describe('the messages that must keep working', () => {
  // The whole point of the grounded path is that Ellie stopped having to
  // approve twenty-one greetings a month. Nothing here may be swept up by a
  // rule about doorsteps.
  const ORDINARY = [
    ['hiya!', 'greeting'],
    ['Thanks lovely, see you Tuesday xx', 'review_thanks'],
    ['How much is a lash lift?', 'price_enquiry'],
    ['Where are you based?', 'general_question'],
    ['I have an appointment with you tomorrow at 6pm correct?', 'booking_lookup'],
  ];

  for (const [words, intent] of ORDINARY) {
    it(`leaves "${words}" alone`, () => {
      expect(atTheDoorPhrase(words)).toBeNull();
      expect(mayFlorrieSend({
        classification: { intent, confidence: 0.99 },
        groundedDecision: { grounded: true, reason: `grounded:${intent}` },
        known: true,
        autonomyOverride: null,
        threshold: 0.9,
        message: words,
      })).toBe(true);
    });
  }
});

/* ================================ the words: never true, whoever asked for it */
describe('what Florrie may never say, note or no note', () => {
  const NEVER = [
    // The two halves of the 27 August reply.
    "Oh I'm ready! I'll come get you xx",
    "I'm ready",
    "I'll come get you",
    // Ready, or not ready. She cannot see the room either way.
    "I'm all ready for you lovely",
    "I'm not quite ready, two mins!",
    'Ready for you!',
    // Here, or on the way.
    "I'm here!",
    "I'm outside",
    "I'm on my way",
    "I'll be right out",
    "I'll be with you shortly",
    // Coming to get, collect, fetch.
    "I'll come and get you",
    "I'm coming down to collect you",
    'Coming to get you now!',
    // Working a door with hands she does not have.
    "I'll let you in",
    "I'll buzz you in",
    "I'll come and open the door",
    // Just finishing up.
    "I'm just finishing up",
    "I'm with a client at the moment",
    // The kettle.
    "I'll put the kettle on",
  ];

  for (const sentence of NEVER) {
    it(`refuses "${sentence}" even with a full arrival note on file`, () => {
      // The note is the most generous one a salon could write and it still
      // cannot make any of these true. That is the whole reason PRESENCE_CLAIMS
      // has no evidence flag when every other list in that file does.
      const generous = 'Come through when you get here, no need to knock. The door is on the latch. Parking is on Mill Street. Take a seat in reception, we are on the first floor, the buzzer is flat 2.';
      const verdict = checkReplyClaims(sentence, { allowedTimes: [], arrivalNote: generous });
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/present or to do something physical/);
    });
  }

  it('refuses them even when a real booking write and a real send happened', () => {
    const verdict = checkReplyClaims("I'll come get you", {
      allowedTimes: ['16:30'], actionPerformed: true, sendPerformed: true, arrivalNote: HER_NOTE,
    });
    expect(verdict.ok).toBe(false);
  });

  it('swaps the draft for the holding reply rather than sending it', () => {
    const out = safeReply("Oh I'm ready! I'll come get you xx", { allowedTimes: [] });
    expect(out.rejected).toBe(true);
    expect(out.text).toBe(HOLDING_REPLY);
  });
});

/* ============================== the words: true if she wrote them down ====== */
describe('what the arrival note makes sayable', () => {
  it('lets Ellie’s own sentence through, which is the point of all of this', () => {
    const verdict = checkReplyClaims(HER_NOTE, { allowedTimes: [], arrivalNote: HER_NOTE });
    expect(verdict.ok).toBe(true);
  });

  it('refuses that same sentence when nobody wrote it down', () => {
    const verdict = checkReplyClaims(HER_NOTE, { allowedTimes: [], arrivalNote: '' });
    expect(verdict.ok).toBe(false);
    expect(verdict.facet).toBe('entry');
    expect(verdict.reason).toMatch(/arrival note does not cover entry/);
  });

  it('does not need the note and the reply to use the same words', () => {
    // "come on up" and "head up" mean the same thing to a person on a step and
    // Ellie will only ever have written one of them. Matching wording against
    // wording is the brittle version of this and it fails silently, on the
    // salon that took the trouble to write a note.
    const note = 'Just head up the stairs when you arrive, the door at the top is ours.';
    for (const reply of ['Come on up.', 'Come straight up.', 'Head up when you get here.']) {
      expect(checkReplyClaims(reply, { allowedTimes: [], arrivalNote: note }).ok, reply).toBe(true);
    }
  });

  /* ------------------------------------------------------ facet isolation -- */
  it('does not let a note about parking license "come through"', () => {
    const verdict = checkReplyClaims('Come through when you get here.', {
      allowedTimes: [], arrivalNote: PARKING_ONLY,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.facet).toBe('entry');
  });

  it('does let that same note answer a question about parking', () => {
    const verdict = checkReplyClaims('Parking is on Mill Street.', {
      allowedTimes: [], arrivalNote: PARKING_ONLY,
    });
    expect(verdict.ok).toBe(true);
  });

  it('does not let a note about coming through license "the door is on the latch"', () => {
    const verdict = checkReplyClaims("The door's on the latch, come through.", {
      allowedTimes: [], arrivalNote: HER_NOTE,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.facet).toBe('door_state');
  });

  it('does not let a note about coming through license a parking answer', () => {
    const verdict = checkReplyClaims('You can park right outside.', {
      allowedTimes: [], arrivalNote: HER_NOTE,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.facet).toBe('parking');
  });

  it('does not let a note about coming through license a buzzer or a floor', () => {
    // "Come through when you get here" says nothing whatsoever about there
    // being a buzzer, let alone which one to press.
    for (const reply of ['Press the buzzer for flat 3.', 'We are on the first floor.']) {
      const verdict = checkReplyClaims(reply, { allowedTimes: [], arrivalNote: HER_NOTE });
      expect(verdict.ok, reply).toBe(false);
      expect(verdict.facet).toBe('directions');
    }
  });

  it('does not let a note about coming through license "take a seat"', () => {
    const verdict = checkReplyClaims('Take a seat in reception.', {
      allowedTimes: [], arrivalNote: HER_NOTE,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.facet).toBe('waiting');
  });

  it('leaves opening hours alone, which is the other thing "open" means', () => {
    // "it's open" is not in the door_state list because it is far more often
    // about a Saturday than about a door, and this guard runs on every reply
    // that leaves the building, not just doorstep ones.
    expect(checkReplyClaims("Yes, we're open until five on Saturday.", { allowedTimes: [] }).ok).toBe(true);
    expect(checkReplyClaims('We do not permit changes inside 48 hours.', { allowedTimes: [] }).ok).toBe(true);
  });

  it('covers every facet when she has written the lot', () => {
    const everything = 'Come through when you get here, no need to knock. The door is on the latch. Parking is on Mill Street. Take a seat in reception if I am with someone. We are on the first floor.';
    const sayable = [
      'Come through when you get here.',
      "The door's on the latch.",
      'Parking is on Mill Street.',
      'Take a seat in reception.',
      'We are on the first floor.',
    ];
    for (const reply of sayable) {
      expect(checkReplyClaims(reply, { allowedTimes: [], arrivalNote: everything }).ok, reply).toBe(true);
    }
  });
});

/* ================================== what must not be swept up on the way ==== */
describe('the replies a doorstep rule must not touch', () => {
  const STILL_FINE = [
    // The sanctioned holding reply, which contains the word "come" and is the
    // one sentence the prompts are told to fall back to. If this ever fails,
    // the guard has eaten its own fallback.
    HOLDING_REPLY,
    "I'll check my book and come straight back to you x",
    // Figures of speech, not locations.
    "I'm here to help, just say the word",
    "I'm here if you need anything at all",
    // Stock, not a doorway.
    "I'm out of that shade at the moment, sorry!",
    // Admin, not walking anywhere. "Pop in" is an invitation to visit at some
    // point; "pop through" is only ever said to somebody already on the step.
    'Pop in and we will get you sorted',
    'Pop in any time for a patch test',
    "I'll get you booked in for a patch test first",
    "I'm ready to get you booked in",
    // Third person. Reporting what the owner will do is a different fact with a
    // different owner, and lib/grounded-reply.js holds it as a draft she reads.
    'Ellie will come and get you when you arrive',
    // Ordinary salon English.
    'Your lash lift is 45 pounds and takes an hour',
    'No worries at all, take your time',
  ];

  for (const sentence of STILL_FINE) {
    it(`still allows "${sentence}" with no note at all`, () => {
      expect(checkReplyClaims(sentence, { allowedTimes: [] }).ok).toBe(true);
    });
  }

  it('leaves the confirmation delivery promise to the send guard', () => {
    // "should come through in a min" is about an email arriving, not a person
    // walking through a door, and SEND_CLAIMS already evidences it. The entry
    // patterns are anchored to a clause opening, which is where an imperative
    // lives, so this is untouched by them even when an arrival note is on file
    // that would license the imperative.
    const words = "Hey, i'll send you a new one now. should come through in a min xx";
    expect(checkReplyClaims(words, { allowedTimes: [], sendPerformed: true }).ok).toBe(true);
    expect(checkReplyClaims(words, { allowedTimes: [], sendPerformed: true, arrivalNote: HER_NOTE }).ok).toBe(true);

    const refused = checkReplyClaims(words, { allowedTimes: [], sendPerformed: false, arrivalNote: HER_NOTE });
    expect(refused.ok).toBe(false);
    expect(refused.reason, 'a delivery promise was mistaken for an entry direction')
      .toMatch(/sent when nothing was sent/);
    expect(refused.facet).toBeUndefined();
  });
});
