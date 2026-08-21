/**
 * Knowing whether a message arrived.
 *
 * The webhook threw every delivery receipt away on one line — `return; // Not
 * a message event (could be status update)` — so send_status, delivered_at and
 * read_at have been columns with no values in them since the schema was
 * written. On 21 August Lucy Walker said she had never received her booking
 * link and there was nothing in the app that could confirm or deny it.
 *
 * The two things worth testing here are both about not making it worse:
 * receipts arrive OUT OF ORDER, and a failure must never be overwritten by a
 * late success.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = { messages: [] };
const updates = [];
vi.mock('../../src/config.js', () => {
  function makeBuilder(table) {
    const preds = []; let pending = null;
    const rows = () => (db[table] || []).filter(r => preds.every(p => p(r)));
    const b = {
      select() { return b; },
      update(p) { pending = p; return b; },
      eq(c, v) {
        preds.push(r => r[c] === v);
        if (pending) {
          const hit = rows();
          for (const r of hit) Object.assign(r, pending);
          if (hit.length) updates.push({ patch: pending, ids: hit.map(r => r.id) });
          return Promise.resolve({ data: hit, error: null });
        }
        return b;
      },
      maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
      then(res) { return Promise.resolve({ data: rows(), error: null }).then(res); },
    };
    return b;
  }
  const supabase = { from: (t) => makeBuilder(t) };
  return { supabase, supabaseAdmin: supabase };
});
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));

const { receiptPatch, applyWhatsAppStatuses } = await import('../../src/services/delivery-receipts.js');

const AT = '2026-08-21T10:00:00.000Z';
const receipt = (status, id = 'wamid.1', extra = {}) => ({ id, status, timestamp: '1787306400', ...extra });

beforeEach(() => {
  db.messages = [{ id: 'm1', whatsapp_message_id: 'wamid.1', send_status: 'sent', client_id: 'c1', beautician_id: 'b1' }];
  updates.length = 0;
});

describe('a receipt only ever moves a message forward', () => {
  it('sent -> delivered', () => {
    expect(receiptPatch('delivered', 'sent', AT)).toEqual({ send_status: 'delivered', delivered_at: AT });
  });

  it('delivered -> read, and backfills the delivery it implies', () => {
    // If she read it, it was delivered, whatever receipt did or did not arrive.
    expect(receiptPatch('read', 'delivered', AT)).toEqual({ send_status: 'read', read_at: AT, delivered_at: AT });
  });

  it('refuses to walk backwards when receipts arrive out of order', () => {
    // A `delivered` landing after a `read` is normal and must change nothing.
    expect(receiptPatch('delivered', 'read', AT)).toBeNull();
    expect(receiptPatch('sent', 'delivered', AT)).toBeNull();
  });

  it('ignores a repeat of the status it already has', () => {
    expect(receiptPatch('delivered', 'delivered', AT)).toBeNull();
  });

  it('accepts anything when the row has no status yet', () => {
    expect(receiptPatch('read', null, AT)?.send_status).toBe('read');
  });

  it('ignores a status it does not recognise', () => {
    expect(receiptPatch('accepted', 'sent', AT)).toBeNull();
    expect(receiptPatch('', 'sent', AT)).toBeNull();
  });
});

describe('a failure is the one thing that always wins', () => {
  it('overrides a delivered', () => {
    // A failure after a delivery is real news. Hiding it is how a client
    // silently gets nothing.
    expect(receiptPatch('failed', 'delivered', AT)).toEqual({ send_status: 'failed' });
  });

  it('is never overwritten by a late success', () => {
    expect(receiptPatch('delivered', 'failed', AT)).toBeNull();
    expect(receiptPatch('read', 'failed', AT)).toBeNull();
  });

  it('can be reported twice without complaint', () => {
    expect(receiptPatch('failed', 'failed', AT)).toEqual({ send_status: 'failed' });
  });
});

describe('applying a webhook payload', () => {
  it('marks the message delivered', async () => {
    const out = await applyWhatsAppStatuses([receipt('delivered')]);
    expect(out.applied).toBe(1);
    expect(db.messages[0].send_status).toBe('delivered');
    expect(db.messages[0].delivered_at).toBeTruthy();
  });

  it('uses the timestamp Meta gave, not the time we processed it', async () => {
    await applyWhatsAppStatuses([receipt('delivered')]);
    expect(db.messages[0].delivered_at).toBe(new Date(1787306400 * 1000).toISOString());
  });

  it('counts a failure separately, because it is the one worth acting on', async () => {
    const out = await applyWhatsAppStatuses([
      receipt('failed', 'wamid.1', { errors: [{ code: 131047, title: 'Re-engagement message' }] }),
    ]);
    expect(out.failedSends).toBe(1);
    expect(db.messages[0].send_status).toBe('failed');
  });

  it('counts what it could not match rather than inventing a row', async () => {
    // Every message sent before the id was recorded is unmatchable. That is
    // expected and finite, and it must not turn into writes against nothing.
    const out = await applyWhatsAppStatuses([receipt('delivered', 'wamid.unknown')]);
    expect(out).toEqual({ applied: 0, failedSends: 0, unmatched: 1 });
    expect(updates).toHaveLength(0);
  });

  it('handles a batch in one webhook', async () => {
    db.messages.push({ id: 'm2', whatsapp_message_id: 'wamid.2', send_status: 'sent' });
    const out = await applyWhatsAppStatuses([receipt('delivered', 'wamid.1'), receipt('read', 'wamid.2')]);
    expect(out.applied).toBe(2);
  });

  it('shrugs off a malformed payload rather than throwing at a webhook', async () => {
    // This runs after we have already answered 200, so throwing here would
    // make Meta retry a message we have processed.
    await expect(applyWhatsAppStatuses(null)).resolves.toEqual({ applied: 0, failedSends: 0, unmatched: 0 });
    await expect(applyWhatsAppStatuses([{}, { status: 'delivered' }, { id: 'x' }])).resolves.toEqual({ applied: 0, failedSends: 0, unmatched: 0 });
  });
});
