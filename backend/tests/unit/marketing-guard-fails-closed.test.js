/**
 * THE MARKETING GUARD FAILS CLOSED.
 *
 * 2 September 2026. canSendMarketing selected marketing_consent and never
 * read it, and answered { allowed: true } for a phone number that matched no
 * client at all. The header comment called the fail-open deliberate: phone
 * formats vary, and STOP on the inbound side was the real guarantee. With one
 * pilot salon that held. At national scale it is a per-message PECR reg 22
 * exposure: the sender has to be able to show consent before the text goes,
 * and "no row found" is the absence of that evidence, not a licence.
 *
 * The three reversed assertions below each carry the reason the old answer
 * was the way it was, so the reversal is a decision on the record and not an
 * accident somebody undoes in a year.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** The next clients row findClientByPhone will see, or the error it will get. */
const next = { row: null, error: null };

vi.mock('../../src/config.js', () => {
  const b = {
    select() { return b; }, eq() { return b; }, ilike() { return b; }, limit() { return b; },
    maybeSingle: async () => ({ data: next.error ? null : next.row, error: next.error }),
  };
  return { supabase: { from: () => b }, supabaseAnon: { from: () => b } };
});

const logged = { warn: [] };
vi.mock('../../src/lib/logger.js', () => {
  const rec = (level) => (a, b) => { logged[level]?.push({ ctx: typeof a === 'object' ? a : {}, msg: typeof a === 'string' ? a : b }); };
  return { default: { error: () => {}, warn: rec('warn'), info: () => {}, debug: () => {} } };
});

const guard = await import('../../src/lib/marketing-guard.js');

/** Every test runs at 11:00 in London so quiet hours never get in the way. */
const MIDDAY = new Date('2026-09-02T10:00:00Z');

beforeEach(() => {
  next.row = null;
  next.error = null;
  logged.warn.length = 0;
  vi.useFakeTimers({ now: MIDDAY, toFake: ['Date'] });
});

describe('canSendMarketing', () => {
  it('blocks a number that matches no client', async () => {
    // Was { allowed: true }: the old comment said phone formats vary and a
    // STOP reply would set marketing_opted_out_at anyway. But a stranger who
    // was never a client has nothing to reply STOP to until we have already
    // sent the message the fine is for.
    next.row = null;
    const out = await guard.canSendMarketing('b1', '+447900000001');
    expect(out).toEqual({ allowed: false, reason: 'no_client_match', client: null });
  });

  it('blocks a matched client whose marketing_consent is not true', async () => {
    // Was { allowed: true }: marketing_consent was selected and never read,
    // so a client who left the box unticked on the booking form was treated
    // exactly like one who ticked it.
    next.row = { id: 'c1', first_name: 'Sam', marketing_consent: false, marketing_opted_out_at: null };
    expect((await guard.canSendMarketing('b1', '+447900000001')).reason).toBe('no_consent');

    // null is the column default on every row created from an inbound
    // message, and null is not consent either.
    next.row = { id: 'c1', first_name: 'Sam', marketing_consent: null, marketing_opted_out_at: null };
    const out = await guard.canSendMarketing('b1', '+447900000001');
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe('no_consent');
    expect(out.client?.id).toBe('c1');
  });

  it('still blocks an opt-out, and STOP outranks a stale consent flag', async () => {
    next.row = { id: 'c1', first_name: 'Sam', marketing_consent: true, marketing_opted_out_at: '2026-08-31T20:00:00Z' };
    const out = await guard.canSendMarketing('b1', '+447900000001');
    expect(out).toMatchObject({ allowed: false, reason: 'opted_out' });
  });

  it('allows a matched client who consented and has not opted out', async () => {
    next.row = { id: 'c1', first_name: 'Sam', marketing_consent: true, marketing_opted_out_at: null };
    const out = await guard.canSendMarketing('b1', '+447900000001');
    expect(out).toMatchObject({ allowed: true, reason: null });
    expect(out.client.id).toBe('c1');
  });

  it('blocks, and says why in the log, when the lookup itself fails', async () => {
    // Was { allowed: true }: findClientByPhone discarded the error and
    // returned null, and null meant go. Now null means stop, and the log says
    // the database was the reason so nobody goes looking at her consent row.
    next.error = { code: '57P01', message: 'terminating connection' };
    const out = await guard.canSendMarketing('b1', '+447900000001');
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe('no_client_match');
    expect(logged.warn.some(l => /read failed/i.test(l.msg || ''))).toBe(true);
  });

  it('keeps the signature: quiet hours first, with no client lookup', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-02T22:30:00Z'), toFake: ['Date'] });
    next.row = { id: 'c1', marketing_consent: true, marketing_opted_out_at: null };
    const out = await guard.canSendMarketing('b1', '+447900000001');
    expect(out).toEqual({ allowed: false, reason: 'quiet_hours', client: null });
  });
});

describe('the transactional path never reaches the guard', () => {
  it('only marketing SMS types and marketing templates are classed as marketing', () => {
    // These are the two predicates services/notifications.js checks BEFORE
    // calling canSendMarketing. A confirmation to a brand new client, who by
    // definition has no consent on file yet, must keep going.
    for (const t of ['booking_confirmation', 'appointment_reminder', 'ai_reply', 'marketing_opt_out', 'general', 'receipt']) {
      expect(guard.isMarketingSmsType(t), t).toBe(false);
    }
    for (const t of ['marketing', 'rebook_nudge', 'comeback', 'gap_fill', 'win_back', 'campaign']) {
      expect(guard.isMarketingSmsType(t), t).toBe(true);
    }
    expect(guard.isMarketingTemplate('booking_confirmation_v2')).toBe(false);
    expect(guard.isMarketingTemplate('appointment_reminder')).toBe(false);
    expect(guard.isMarketingTemplate('rebook_nudge_v1')).toBe(true);
    expect(guard.isMarketingTemplate('gap_fill_offer')).toBe(true);
  });
});
