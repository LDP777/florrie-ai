/**
 * THE FIX FOR THE FIX, AND THE RATCHET THAT KEEPS IT.
 *
 * Three senders shipped a select that did not ask for marketing_opted_out_at,
 * and evaluateOutbound trusted the row it was handed, so a missing column read
 * as a yes and a client who had replied STOP was texted. Selecting the columns
 * in those three places fixes those three places. It does nothing about the
 * next one somebody writes.
 *
 * So two things are asserted here:
 *
 *  1. The guard no longer treats a row with no consent columns as evidence.
 *     It goes and reads them. Not a refusal, because a refusal would break
 *     every caller that still under-selects, and an under-selecting caller is
 *     precisely where we most need the true answer.
 *
 *  2. A source scan over every caller that hands the guard a client row. This
 *     is the part that survives the next person, including the next Claude.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const rows = { clients: [] };
let selects = [];

vi.mock('../../src/config.js', () => ({
  supabase: {
    from(table) {
      const q = {
        _table: table,
        select(cols) { selects.push({ table, cols }); return q; },
        eq() { return q; },
        maybeSingle() {
          return Promise.resolve({ data: rows[table]?.[0] ?? null, error: null });
        },
        order() { return q; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        gte() { return q; },
        lte() { return q; },
        in() { return q; },
        then(res) { return Promise.resolve({ data: [], error: null }).then(res); },
      };
      return q;
    },
  },
}));

vi.mock('../../src/services/whatsapp-metering.js', () => ({
  getMonthlyUsage: async () => ({ used: 0, included: 120, remaining: 120 }),
}));

const { evaluateOutbound } = await import('../../src/lib/outbound-guard.js');

const BEAUTICIAN = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';

describe('a client row with no consent columns is not evidence', () => {
  beforeEach(() => { selects = []; rows.clients = []; });

  it('re-reads the client rather than reading a missing column as a yes', async () => {
    // Exactly the shape the three broken senders passed.
    const underSelected = { id: CLIENT, first_name: 'Shauna', phone: '07700900000' };
    rows.clients = [{
      id: CLIENT,
      marketing_consent: true,
      marketing_opted_out_at: '2026-07-01T09:00:00.000Z',
      messaging_autonomy: 'florrie',
    }];

    const verdict = await evaluateOutbound({
      beauticianId: BEAUTICIAN,
      clientId: CLIENT,
      client: underSelected,
      messageType: 'rebook_nudge',
      channel: 'sms',
    });

    expect(selects.some(s => s.table === 'clients' && s.cols.includes('marketing_opted_out_at')))
      .toBe(true);
    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toBe('opted_out');
  });

  it('re-reads even when only the row carries the id, with no separate clientId', async () => {
    rows.clients = [{
      id: CLIENT,
      marketing_consent: true,
      marketing_opted_out_at: '2026-07-01T09:00:00.000Z',
      messaging_autonomy: 'florrie',
    }];

    const verdict = await evaluateOutbound({
      beauticianId: BEAUTICIAN,
      client: { id: CLIENT, first_name: 'Shauna', phone: '07700900000' },
      messageType: 'gap_fill',
      channel: 'sms',
    });

    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toBe('opted_out');
  });

  it('does not re-read a row that already carries the columns', async () => {
    const verdict = await evaluateOutbound({
      beauticianId: BEAUTICIAN,
      clientId: CLIENT,
      client: {
        id: CLIENT,
        first_name: 'Shauna',
        marketing_consent: true,
        marketing_opted_out_at: '2026-07-01T09:00:00.000Z',
        messaging_autonomy: 'florrie',
      },
      messageType: 'rebook_nudge',
      channel: 'sms',
    });

    expect(selects.some(s => s.table === 'clients')).toBe(false);
    expect(verdict.reason).toBe('opted_out');
  });

  it('an explicit null marketing_opted_out_at is a real answer, not a missing column', async () => {
    const verdict = await evaluateOutbound({
      beauticianId: BEAUTICIAN,
      clientId: CLIENT,
      client: {
        id: CLIENT,
        first_name: 'Shauna',
        marketing_consent: true,
        marketing_opted_out_at: null,
        messaging_autonomy: 'just_me',
      },
      messageType: 'rebook_nudge',
      channel: 'sms',
    });

    expect(selects.some(s => s.table === 'clients')).toBe(false);
    expect(verdict.reason).not.toBe('opted_out');
  });
});

/**
 * The ratchet. Every select in src/ that pulls an embedded clients(...) row
 * carrying contact details, inside a file that asks the gate a question, is
 * listed here. The guard re-reads now, so an entry on this list costs a query
 * rather than a client's consent, but a NEW one is still somebody about to
 * write the same bug. The list can only get shorter.
 *
 * Most entries are false positives on purpose: features.js reads clients to
 * DRAW them, not to message them. Narrowing the heuristic to only real senders
 * needs to know which variable reaches the gate, which a regex cannot. A wide
 * net with a baseline catches the real one; a clever net misses it.
 */
describe('no new sender joins clients without the consent columns', () => {
  const SRC = new URL('../../src/', import.meta.url).pathname;

  // Recorded 2026-08-23, after the three real senders were fixed. Shorten it,
  // never lengthen it.
  const KNOWN = new Set([
    'src/routes/appointments.js:67',
    'src/routes/appointments.js:435',
    // Moved down by the patch-test record and alert routes added above it in
    // routes/appointments.js, then again by the assumed-versus-settled takings
    // read added to GET /:id/card on 27 August 2026, then again by the prior
    // history rule added to the patch-test alerts route the same day. Same
    // join, same file. (Previously 1598, 1826, then 1873.)
    'src/routes/appointments.js:1907',
    // All five moved down again, by the patch-test evidence rule replacing the
    // `status === 'passed'` test in routes/booking.js, and again by the prior
    // history rule that separated the 673 imported regulars from the 277 true
    // first timers, and again on 29 August 2026 by the hybrid consultation
    // rule (lib/consultation-status.js) landing in lookup-client, in the /book
    // gate and in the two manage-page treatment routes, and again on 31 August
    // 2026 by the booking-confirmed alert moving to the status transition
    // (the /confirm redirect and the resent-deposit metadata both grew). Same
    // five joins, same file, new line numbers.
    // (Previously 857 / 1572 / 2126 / 2392 / 2803, then 993 / 1708 / 2262 /
    // 2528 / 2939, then 994 / 1777 / 2331 / 2597 / 3008, then 1019 / 1846 /
    // 2400 / 2666 / 3077, then 1095 / 2032 / 2586 / 2852 / 3263.)
    'src/routes/booking.js:1107',
    'src/routes/booking.js:2046',
    'src/routes/booking.js:2603',
    'src/routes/booking.js:2892',
    'src/routes/booking.js:3303',
    'src/routes/features.js:132',
    'src/routes/features.js:169',
    'src/routes/features.js:194',
    'src/routes/features.js:229',
    'src/routes/features.js:266',
    'src/routes/features.js:290',
    'src/routes/features.js:605',
    'src/routes/features.js:641',
    'src/routes/features.js:666',
    'src/routes/features.js:1044',
    'src/routes/features.js:1086',
    'src/routes/features.js:1116',
    'src/routes/features.js:2566',
    'src/routes/features.js:2791',
    'src/routes/features.js:2832',
    'src/routes/features.js:3317',
    // Both moved down again, by the 27 August 2026 template-parameter fix:
    // resolveTemplateForSend grew the refusal path and sendBookingLink's
    // comment was rewritten, both above these two joins. Then again by the
    // shortened link blurb, once generic_message_v4 was approved and its own
    // approved body started carrying the "reply if you want to change
    // anything" line the blurb had been duplicating. Same two joins, same
    // file, new line numbers.
    // And down eight more on 31 August 2026: sendOnPreferredChannel's Instagram
    // branch and its all-channels-exhausted tail both grew a logChannelFailover
    // call, and pickChannel lost its global INSTAGRAM_PAGE_TOKEN fallback and
    // gained the comment explaining why. Same two joins, same file, new line
    // numbers.
    // And down thirty and thirty three on 2 September 2026: sendEmail grew a
    // replyTo parameter and its address check (so a client who hits Reply on
    // a confirmation reaches the salon), and the WABA caches gained a size
    // cap. Same two joins, same file, new line numbers.
    // And down twelve on 3 September 2026: a frontendBase() helper above the
    // senders, so the manage link no longer depends on FRONTEND_URL being set.
    // And down thirty three on 5 September 2026: wholeTreatment(), so a
    // booking of two treatments is confirmed as two.
    // (Previously 1236 / 1514, then 1393 / 1685, then 1526 / 1818, then
    // 1532 / 1824, then 1540 / 1845, then 1693 / 2008, then 1705 / 2020.)
    'src/services/notifications.js:1738',
    'src/services/notifications.js:2053',
  ]);

  function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return e.isFile() && p.endsWith('.js') ? [p] : [];
    });
  }

  // Blank out comments so a join described in prose is not read as code. One
  // of these lives in a docblock explaining a sender that was DELETED for
  // exactly this defect, and counting it would be quoting the fix as the bug.
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  }

  it('finds no clients(...) join outside the recorded list', () => {
    const found = [];

    for (const file of walk(SRC)) {
      const raw = readFileSync(file, 'utf8');
      if (!/evaluateOutbound|guardedSend/.test(raw)) continue;
      const src = stripComments(raw);

      for (const m of src.matchAll(/clients\s*\(([^)]*)\)/g)) {
        const cols = m[1];
        if (!/phone|email|whatsapp_id|instagram_id/.test(cols)) continue;
        if (cols.includes('marketing_opted_out_at')) continue;
        const line = src.slice(0, m.index).split('\n').length;
        found.push({ at: `${file.replace(SRC, 'src/')}:${line}`, cols: cols.trim() });
      }
    }

    const added = found.filter(f => !KNOWN.has(f.at));

    expect(added.map(f => `${f.at}  clients(${f.cols})`), [
      'A new select hands the outbound gate a client row with no consent',
      'columns. The guard re-reads rather than trusting it, so nobody gets',
      'texted who should not, but select them and save the query:',
      '  marketing_consent, marketing_opted_out_at, messaging_autonomy',
    ].join('\n')).toEqual([]);
  });

  it('the recorded list is not stale', () => {
    const live = new Set();
    for (const file of walk(SRC)) {
      const raw = readFileSync(file, 'utf8');
      if (!/evaluateOutbound|guardedSend/.test(raw)) continue;
      const src = stripComments(raw);
      for (const m of src.matchAll(/clients\s*\(([^)]*)\)/g)) {
        const cols = m[1];
        if (!/phone|email|whatsapp_id|instagram_id/.test(cols)) continue;
        if (cols.includes('marketing_opted_out_at')) continue;
        live.add(`${file.replace(SRC, 'src/')}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    // Entries that have been fixed or moved should be struck off, so the list
    // stays a description of the code rather than folklore about it.
    const gone = [...KNOWN].filter(k => !live.has(k));
    expect(gone, `Fixed or moved, remove from KNOWN:\n${gone.join('\n')}`).toEqual([]);
  });
});
