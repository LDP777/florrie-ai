/**
 * Closing the escalations that stopped being work.
 *
 * Ellie's queue on 21 August: 237 open, 107 of them more than thirty days old,
 * and 14 of the last 177 inbound messages ever marked resolved. Every one of
 * those rows carries a draft reply and an approve button, so the queue was not
 * just noise — one tap on a five-week-old draft answers a question from July.
 *
 * outbound-expiry.js already does this sweep for proactive sends, and its
 * comment describes the identical failure (103 pending, oldest 15 days, badge
 * stuck at 99+). Nobody carried it across to messages.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = { messages: [] };
const updates = [];
let failTable = null;

function makeBuilder(table) {
  const preds = [];
  let pending = null;
  const rows = () => (db[table] || []).filter(r => preds.every(p => p(r)));
  const settle = () => {
    if (failTable === table) return { data: null, error: { message: 'boom' } };
    if (pending) {
      const hit = rows();
      for (const r of hit) Object.assign(r, pending);
      // Only a write that actually matched rows counts as touching anything.
      if (hit.length) updates.push({ patch: pending, ids: hit.map(r => r.id) });
      return { data: hit.map(r => ({ id: r.id })), error: null };
    }
    return { data: rows(), error: null };
  };
  const b = {
    select() { return b; },
    update(p) { pending = p; return b; },
    eq(c, v) { preds.push(r => r[c] === v); return b; },
    in(c, vs) { preds.push(r => vs.includes(r[c])); return b; },
    gte(c, v) { preds.push(r => String(r[c]) >= String(v)); return b; },
    lt(c, v) { preds.push(r => String(r[c]) < String(v)); return b; },
    order() { return b; },
    limit() { return b; },
    then(res) { return Promise.resolve(settle()).then(res); },
  };
  return b;
}
const supabase = { from: (t) => makeBuilder(t) };
vi.mock('../../src/config.js', () => ({ supabase, supabaseAdmin: supabase }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));

const { expireStaleEscalations, movedOn, escalationCutoff, ESCALATION_WINDOW_DAYS } =
  await import('../../src/services/escalation-expiry.js');

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

const escalation = (id, days, clientId = 'c1') => ({
  id, client_id: clientId, direction: 'inbound', escalated: true, resolved: false,
  created_at: daysAgo(days),
});
const outbound = (days, clientId = 'c1') => ({
  id: `o${Math.random()}`, client_id: clientId, direction: 'outbound', created_at: daysAgo(days),
});

beforeEach(() => { db.messages = []; updates.length = 0; failTable = null; });

describe('the window', () => {
  it('is a week, matching the sweep that already existed for proactive sends', () => {
    expect(ESCALATION_WINDOW_DAYS).toBe(7);
  });

  it('cuts off seven days back', () => {
    const cut = new Date(escalationCutoff(Date.parse('2026-08-21T12:00:00Z')));
    expect(cut.toISOString()).toBe('2026-08-14T12:00:00.000Z');
  });
});

describe('a thread that moved on', () => {
  it('is closed when something went out afterwards', () => {
    const esc = [escalation('m1', 3)];
    expect(movedOn(esc, { c1: daysAgo(2) })).toHaveLength(1);
  });

  it('is left alone when the only outbound came BEFORE it', () => {
    // The confirmation that started the conversation is not an answer to it.
    expect(movedOn([escalation('m1', 3)], { c1: daysAgo(4) })).toHaveLength(0);
  });

  it('is left alone when nothing went out at all', () => {
    expect(movedOn([escalation('m1', 3)], {})).toHaveLength(0);
  });

  it('does not confuse one client with another', () => {
    expect(movedOn([escalation('m1', 3, 'c1')], { c2: daysAgo(1) })).toHaveLength(0);
  });

  it('ignores a row with no client', () => {
    expect(movedOn([escalation('m1', 3, null)], { null: daysAgo(1) })).toHaveLength(0);
  });
});

describe('the sweep', () => {
  it('closes a recent escalation the thread moved past', async () => {
    db.messages = [escalation('m1', 3), outbound(2)];
    const out = await expireStaleEscalations();
    expect(out.movedOn).toBe(1);
    expect(db.messages.find(m => m.id === 'm1').resolved).toBe(true);
    expect(db.messages.find(m => m.id === 'm1').escalated_reason).toBe('thread_moved_on');
  });

  it('closes anything past the window whatever happened in the thread', async () => {
    // 107 of hers were over thirty days old.
    db.messages = [escalation('old', 40)];
    const out = await expireStaleEscalations();
    expect(out.tooOld).toBe(1);
    expect(db.messages[0].resolved).toBe(true);
    expect(db.messages[0].escalated_reason).toBe('too_old_to_answer');
  });

  it('leaves a fresh, genuinely unanswered one alone', async () => {
    // This is the whole point. Today's waiting client must survive the sweep.
    db.messages = [escalation('today', 1)];
    const out = await expireStaleEscalations();
    expect(out).toEqual({ movedOn: 0, tooOld: 0 });
    expect(db.messages[0].resolved).toBe(false);
  });

  it('never touches a row that was already resolved', async () => {
    db.messages = [{ ...escalation('m1', 40), resolved: true }];
    await expireStaleEscalations();
    expect(updates).toHaveLength(0);
  });

  it('never touches an outbound message', async () => {
    db.messages = [{ ...outbound(40), escalated: true, resolved: false }];
    await expireStaleEscalations();
    expect(updates).toHaveLength(0);
  });

  it('records why, rather than erasing it', async () => {
    // The history of what was asked and what went unanswered has to survive.
    db.messages = [escalation('m1', 40)];
    await expireStaleEscalations();
    expect(db.messages[0].escalated_reason).toBeTruthy();
    expect(db.messages).toHaveLength(1);
  });

  it('does not throw when the database is unhappy', async () => {
    failTable = 'messages';
    await expect(expireStaleEscalations()).resolves.toEqual({ movedOn: 0, tooOld: 0 });
  });
});
