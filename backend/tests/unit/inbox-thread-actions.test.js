/**
 * "HOW WILL I KNOW IF IT ACTIONED THIS?"
 *
 * Ellie's question, 26 August 2026, after Florrie told a client "i'll send you
 * a new one now" and nothing was sent. The honest answer was that she could
 * not know. The only record that anything happened, or failed to happen, is an
 * ai_actions row, and the thread view never showed one, so a message that
 * claimed an action and a message that took one looked identical in her inbox.
 *
 * GET /api/inbox/thread now returns, on every message, an `actions` array:
 *
 *   actions: [{ id, action_type, summary, created_at, ok }]
 *
 * `ok` is true for a completed action and false for an attempted one that
 * failed. A failed resend has to be as visible as a successful one: a silent
 * failure here recreates the exact bug.
 *
 * Two things this file exists to hold still:
 *   1. the shape, because the frontend is built against it;
 *   2. ONE query for the whole thread, not one per message. A 200-message
 *      thread is the normal case and 200 round trips is not.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ------------------------------------------------------------------ schema --
 * ai_actions columns from 001_initial_schema.sql plus `status` from
 * 20260803_schema_drift_columns.sql. PostgREST rejects the WHOLE select if one
 * column does not exist, and resolves with { data: null, error } rather than
 * throwing, so a typo here reads at the call site as "this thread has no
 * actions" and the strip is silently empty forever.
 */
const COLUMNS = {
  ai_actions: [
    'id', 'beautician_id', 'action_type', 'digital_employee', 'summary', 'details',
    'confidence', 'autonomous', 'client_id', 'appointment_id', 'message_id',
    'outcome', 'notification_sent', 'notification_text', 'created_at', 'status',
  ],
};

const db = { clients: [], messages: [], appointments: [], ai_actions: [], outbound_sends: [] };
const queries = [];
const replyChecks = [];

function splitTop(spec) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(spec)) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

function checkSelect(table, spec) {
  const known = COLUMNS[table];
  if (!known || !spec || spec === '*') return null;
  for (const item of splitTop(spec)) {
    if (/^[\w]+\s*\(/.test(item)) continue;
    const col = item.includes(':') ? item.split(':').pop().trim() : item;
    if (col === '*') continue;
    if (!known.includes(col)) {
      return { code: '42703', message: `column ${table}.${col} does not exist`, details: null, hint: null };
    }
  }
  return null;
}

function builder(table) {
  const filters = [];
  let pending = null;
  let err = null;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (err) return { data: null, error: err };
    if (pending?.op === 'update') { for (const r of rows()) Object.assign(r, pending.payload); return { data: rows(), error: null }; }
    return { data: rows(), error: null };
  };
  const b = {
    select(spec = '*') { queries.push({ table, spec }); err = err || checkSelect(table, spec); return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    gt(c, v) { filters.push(r => String(r[c] ?? '') > String(v)); return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_q, _s, next) => next() }));
vi.mock('../../src/services/ai-front-desk.js', () => ({
  generateReplySuggestions: async () => [],
  replyIsOwed: (text) => { replyChecks.push(text); return !/^(?:❤️|thanks lovely xx)$/i.test(text); },
}));

const router = (await import('../../src/routes/inbox.js')).default;

/** Drive the handler straight, no HTTP server. */
async function getThread(clientId) {
  const layer = router.stack.find(l => l.route?.path === '/thread/:client_id' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(p) { out.body = p; return res; } };
  await handler({ params: { client_id: clientId }, query: {}, body: {}, beautician: { id: 'b1' } }, res);
  return out;
}

const ts = (mins) => new Date(Date.UTC(2026, 7, 26, 14, mins)).toISOString();

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  queries.length = 0;
  replyChecks.length = 0;
  db.clients.push({ id: 'c1', beautician_id: 'b1', first_name: 'Sophie', phone: '+447700900123' });
  db.messages.push(
    { id: 'm_asked', beautician_id: 'b1', client_id: 'c1', direction: 'inbound', channel: 'sms', content: "don't think I got a confirmation", created_at: ts(52) },
    { id: 'm_replied', beautician_id: 'b1', client_id: 'c1', direction: 'outbound', channel: 'sms', content: "just sent you a new one, should be there in a minute", created_at: ts(53), ai_handled: true },
    { id: 'm_thanks', beautician_id: 'b1', client_id: 'c1', direction: 'inbound', channel: 'sms', content: 'Thanks', created_at: ts(54) },
  );
});

async function callInboxRoute(path, method = 'get') {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(p) { out.body = p; return res; } };
  await handler({ params: {}, query: {}, body: {}, beautician: { id: 'b1' } }, res);
  return out;
}

describe('Instagram story questions in the shared inbox buckets', () => {
  const marker = '[Reply to an Instagram story; story content unavailable to Florrie]';
  const storyRow = (id, content, extra = {}) => ({
    id, beautician_id: 'b1', client_id: id, direction: 'inbound', channel: 'instagram',
    content, ai_intent: 'general_question', escalated: true, resolved: false, read_at: null,
    escalated_reason: 'story_context:unavailable', media_type: 'story_reply',
    created_at: new Date().toISOString(), clients: { id, first_name: 'Fictional', instagram_id: `ig-${id}` },
    ...extra,
  });

  it.each([true, false])('keeps a new diary enquiry in Needs you and out of bulk clear (story metadata: %s)', async withStory => {
    const question = 'When is December dates out!! Need to book in asap xx';
    db.messages = [storyRow('new-lead', withStory ? `${question}\n${marker}` : question)];
    const { body } = await callInboxRoute('/threads');
    expect(body.threads[0]).toMatchObject({ space: 'instagram', segment: 'needs', is_social_lead: true, is_known_client: false });
    expect(body.threads[0]).not.toHaveProperty('_latestInboundLead');
    expect(body.threads[0]).not.toHaveProperty('_latestInboundReplyOwed');
    const cleared = await callInboxRoute('/clear-social', 'post');
    expect(cleared.body).toEqual({ cleared: 0, messages_resolved: 0 });
    expect(db.messages[0]).toMatchObject({ resolved: false, read_at: null });
  });

  it('classifies the full story question even when it falls beyond the displayed preview', async () => {
    const prefix = 'I have just been looking through the lovely results on your page and the story you shared this morning. ';
    db.messages = [storyRow('long-lead', `${prefix}How much is this xx\n${marker}`)];
    const { body } = await callInboxRoute('/threads');
    expect(body.threads[0].last_inbound_preview).not.toContain('How much');
    expect(body.threads[0].last_inbound_preview).not.toContain(marker);
    expect(body.threads[0].is_social_lead).toBe(true);
    expect((await callInboxRoute('/clear-social', 'post')).body.cleared).toBe(0);
  });

  it('retains a held follow-up whose missing story is recorded only in its escalation reason', async () => {
    db.messages = [storyRow('follow-up', 'Can I book that xx', { media_type: null })];
    const { body } = await callInboxRoute('/threads');
    expect(body.threads[0]).toMatchObject({ space: 'instagram', segment: 'needs', is_social_lead: true });
    expect((await callInboxRoute('/clear-social', 'post')).body.cleared).toBe(0);
    expect(db.messages[0]).toMatchObject({ resolved: false, read_at: null });
  });

  it('clears ordinary social reactions but leaves genuine questions and other salons untouched', async () => {
    db.messages = [
      storyRow('lead', `How much is this xx\n${marker}`),
      storyRow('reaction', `❤️\n${marker}`, { escalated: false, escalated_reason: null }),
      storyRow('elsewhere', `❤️\n${marker}`, { beautician_id: 'b2' }),
    ];
    const { body } = await callInboxRoute('/clear-social', 'post');
    expect(body).toMatchObject({ cleared: 1, messages_resolved: 0 });
    expect(db.messages[0]).toMatchObject({ resolved: false, read_at: null });
    expect(db.messages[1].read_at).toEqual(expect.any(String));
    expect(db.messages[2]).toMatchObject({ resolved: false, read_at: null });
  });

  it('asks whether a reply is owed from client words, without story metadata', async () => {
    db.messages = [storyRow('known-client', `Thanks lovely xx\n${marker}`, {
      escalated: false, escalated_reason: null,
      clients: { id: 'known-client', first_name: 'Fictional', phone: '+447700900123' },
    })];
    const { body } = await callInboxRoute('/threads');
    expect(replyChecks).toContain('Thanks lovely xx');
    expect(replyChecks.some(text => text.includes(marker))).toBe(false);
    expect(body.threads[0]).toMatchObject({ space: 'clients', segment: 'client', is_social_lead: false });
  });
});

const byId = (body, id) => body.messages.find(m => m.id === id);

it('keeps an acknowledged appointment change in the Needs you inbox', async () => {
  const base = { beautician_id: 'b1', client_id: 'c1', channel: 'sms', clients: db.clients[0] };
  db.messages = [
    { ...base, id: 'ack', direction: 'outbound', content: 'Your change needs a decision.', created_at: new Date().toISOString(), ai_handled: true },
    { ...base, id: 'request', direction: 'inbound', content: 'Can I reschedule today?',
      created_at: new Date(Date.now() - 60_000).toISOString(), escalated: true, resolved: false,
      escalated_reason: 'appointment_change:short_notice' },
  ];
  const layer = router.stack.find(l => l.route?.path === '/threads' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(p) { out.body = p; return res; } };
  await handler({ query: {}, beautician: { id: 'b1' } }, res);
  expect(out.status).toBe(200);
  expect(out.body.threads[0]).toMatchObject({ segment: 'needs', needs_appointment_decision: true });
  db.messages[1].resolved = true;
  await handler({ query: {}, beautician: { id: 'b1' } }, res);
  expect(out.body.threads[0].segment).not.toBe('needs');
});

describe('GET /api/inbox/thread returns what Florrie actually did', () => {
  it('attaches a completed action to the message that claimed it', async () => {
    db.ai_actions.push({
      id: 'act_1', beautician_id: 'b1', client_id: 'c1', message_id: 'm_replied',
      appointment_id: 'appt_1', action_type: 'booking_confirmation_resent',
      summary: "Resent Sophie's booking confirmation for Monday 2 September at 10:30 by email",
      outcome: 'success', created_at: ts(53),
    });

    const { status, body } = await getThread('c1');
    expect(status).toBe(200);
    expect(byId(body, 'm_replied').actions).toEqual([{
      id: 'act_1',
      action_type: 'booking_confirmation_resent',
      summary: "Resent Sophie's booking confirmation for Monday 2 September at 10:30 by email",
      created_at: ts(53),
      ok: true,
    }]);
  });

  it('shows a failed attempt, and shows it as failed', async () => {
    // The whole reason the failure is logged at all: "I tried to resend and it
    // bounced" is information Ellie needs, and a silent failure here is the
    // bug being fixed.
    db.ai_actions.push({
      id: 'act_2', beautician_id: 'b1', client_id: 'c1', message_id: 'm_replied',
      action_type: 'booking_confirmation_resent',
      summary: "Tried to resend Sophie's booking confirmation and it did not go (no_contact_details)",
      outcome: 'failed', created_at: ts(53),
    });

    const { body } = await getThread('c1');
    const [action] = byId(body, 'm_replied').actions;
    expect(action.ok).toBe(false);
    expect(action.summary).toMatch(/did not go/);
  });

  it('treats an escalation as not-completed', async () => {
    db.ai_actions.push({
      id: 'act_3', beautician_id: 'b1', client_id: 'c1', message_id: 'm_asked',
      action_type: 'booking_confirmation_resent', summary: 'Could not find a booking to resend',
      outcome: 'escalated', created_at: ts(52),
    });
    const { body } = await getThread('c1');
    expect(byId(body, 'm_asked').actions[0].ok).toBe(false);
  });

  it('gives every message an array, even when nothing was logged', async () => {
    const { body } = await getThread('c1');
    for (const m of body.messages) expect(Array.isArray(m.actions)).toBe(true);
    expect(byId(body, 'm_thanks').actions).toEqual([]);
  });

  it('carries more than one action on the same message, oldest first', async () => {
    db.ai_actions.push(
      { id: 'act_a', beautician_id: 'b1', client_id: 'c1', message_id: 'm_replied', action_type: 'booking_confirmation_resent', summary: 'Resent it', outcome: 'success', created_at: ts(53) },
      { id: 'act_b', beautician_id: 'b1', client_id: 'c1', message_id: 'm_replied', action_type: 'message_replied', summary: 'Handled a message', outcome: 'success', created_at: ts(53) },
    );
    const { body } = await getThread('c1');
    expect(byId(body, 'm_replied').actions.map(a => a.id)).toEqual(['act_a', 'act_b']);
  });

  it('never leaks another salon or another thread', async () => {
    db.ai_actions.push(
      { id: 'act_other_salon', beautician_id: 'b2', client_id: 'c1', message_id: 'm_replied', action_type: 'x', summary: 'not hers', outcome: 'success', created_at: ts(53) },
      { id: 'act_other_thread', beautician_id: 'b1', client_id: 'c9', message_id: 'm_elsewhere', action_type: 'x', summary: 'another thread', outcome: 'success', created_at: ts(53) },
    );
    const { body } = await getThread('c1');
    const ids = body.messages.flatMap(m => m.actions.map(a => a.id));
    expect(ids).toEqual([]);
  });

  it('asks ai_actions exactly once for the whole thread', async () => {
    db.ai_actions.push({ id: 'act_1', beautician_id: 'b1', client_id: 'c1', message_id: 'm_replied', action_type: 'x', summary: 's', outcome: 'success', created_at: ts(53) });
    await getThread('c1');
    expect(queries.filter(q => q.table === 'ai_actions')).toHaveLength(1);
  });

  it('names only columns that exist, or the whole select is rejected', async () => {
    db.ai_actions.push({ id: 'act_1', beautician_id: 'b1', client_id: 'c1', message_id: 'm_replied', action_type: 'x', summary: 's', outcome: 'success', created_at: ts(53) });
    const { body } = await getThread('c1');
    // If any column in the select were wrong the fake would return 42703 for
    // the whole statement, the route would log and carry on, and this would be
    // an empty array indistinguishable from "nothing happened".
    expect(byId(body, 'm_replied').actions).toHaveLength(1);
  });
});
