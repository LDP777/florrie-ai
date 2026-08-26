/**
 * "ARE CONFIRMATIONS GOING OUT WITH A LINK?" HAD NO ANSWER.
 *
 * The second half of the Sophie defect is not that the link message failed. It
 * is that it failed for fourteen days under a comment explaining why it was
 * essential, and nothing in the product could tell anyone. Every existing
 * signal said fine:
 *
 *   - the send did not throw, it returned null,
 *   - the FIRST message arrived, so no confirmation was ever "missing",
 *   - confirmation_sent_at was stamped, correctly, because a message did go,
 *   - /health was green, because nothing it checked was down.
 *
 * A monitor that cannot go red is decoration. This one can, on a signal built
 * from rows that already exist: outbound WhatsApp messages that read like a
 * confirmation, against outbound WhatsApp messages carrying a booking link,
 * over the same fortnight. Both are written by logOutboundToThread on a
 * CONFIRMED send, so the ratio measures what clients received rather than what
 * we meant to send, and it works retrospectively over data already in the
 * table. No new column, no new write.
 *
 * WARN, never critical. Nothing is down and the fix is a template approval in
 * the Meta dashboard, so paging at 3am would help nobody and would train
 * everyone to mute the alarm, which is how the Instagram token died for five
 * weeks.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, vi } from 'vitest';

/* --------------------------------------------------------------- the table --
 * `messages` from 001_initial_schema.sql plus the 004 additions. Only the
 * columns this check reads: channel, direction, content, created_at.
 */
const db = { messages: [], beauticians: [], stripe_events: [], transactions: [], job_runs: [] };

function builder(table) {
  const filters = [];
  let head = false;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => (head
    ? { data: null, error: null, count: rows().length }
    : { data: rows(), error: null, count: rows().length });
  const b = {
    select(spec, opts) { if (opts?.head) head = true; return b; },
    insert() { return b; }, update() { return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq() { return b; }, in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is() { return b; }, not() { return b; }, or() { return b; },
    ilike(c, pattern) {
      const needle = String(pattern).replace(/%/g, '').toLowerCase();
      filters.push(r => String(r[c] ?? '').toLowerCase().includes(needle));
      return b;
    },
    // created_at is a real instant, so a plain ISO string comparison is the
    // right one. (appointments.starts_at is salon wall time and would not be.)
    gte(c, v) { filters.push(r => String(r[c] ?? '') >= String(v)); return b; },
    lte() { return b; }, gt() { return b; }, lt() { return b; },
    order() { return b; }, limit() { return b; }, range() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve({ data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve({ data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder }, supabaseAdmin: { from: builder } }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));
vi.mock('../../src/lib/job-runs.js', () => ({ readJobRuns: async () => ({ available: false, rows: [], reason: 'not in this test' }) }));

const {
  runHealthChecks,
  judgeConfirmationLinks,
  CONFIRMATION_BODY_MARKER,
  BOOKING_LINK_MARKER,
} = await import('../../src/lib/health.js');
const { renderTemplateBody } = await import('../../src/lib/whatsapp-templates.js');

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

/** A confirmation as logOutboundToThread renders it into the thread. */
function confirmation({ age = 1 } = {}) {
  db.messages.push({
    beautician_id: 'b1', client_id: 'c1', direction: 'outbound', channel: 'whatsapp',
    content: renderTemplateBody('booking_confirmation_v2', {
      first_name: 'Sophie', business_name: 'Ellindigo', date: 'Thu 3 Sept', time: '12:00',
    }),
    created_at: daysAgo(age),
  });
}

/** The link follow-up as it reads when it works. */
function linkFollowUp({ age = 1 } = {}) {
  db.messages.push({
    beautician_id: 'b1', client_id: 'c1', direction: 'outbound', channel: 'whatsapp',
    content: renderTemplateBody('generic_message_v2', {
      first_name: 'Sophie',
      message: 'Add your appointment to your calendar so you don\'t lose it, or change it if you need to: https://api.florrie.ai/api/booking/ellindigo/manage/tok_sophie/calendar',
    }),
    created_at: daysAgo(age),
  });
}

beforeEach(() => { for (const t of Object.keys(db)) db[t] = []; });

/* ================================================== the markers cannot drift = */
describe('the two things the check looks for really identify those messages', () => {
  it('the confirmation marker is in the confirmation body the registry renders', () => {
    const body = renderTemplateBody('booking_confirmation_v2', {
      first_name: 'Sophie', business_name: 'Ellindigo', date: 'Thu 3 Sept', time: '12:00',
    });
    // If the copy is reworded and this fails, the health check has gone blind,
    // not the template. That is the point of asserting it here.
    expect(body).toContain(CONFIRMATION_BODY_MARKER);
  });

  it('holds for the newer template version too', () => {
    const body = renderTemplateBody('booking_confirmation_v4', {
      first_name: 'Sophie', business_name: 'Ellindigo', date: 'Thu 3 Sept', time: '12:00',
    });
    expect(body).toContain(CONFIRMATION_BODY_MARKER);
  });

  it('the link marker is structural in both url shapes', () => {
    // The manage page and the calendar landing page. Both are built as
    // .../manage/<token>..., which a wording change cannot remove.
    expect('https://florrie.ai/book/ellindigo/manage/tok_sophie').toContain(BOOKING_LINK_MARKER);
    expect('https://api.florrie.ai/api/booking/ellindigo/manage/tok_sophie/calendar').toContain(BOOKING_LINK_MARKER);
  });

  it('does not match a confirmation that carries no link', () => {
    const body = renderTemplateBody('booking_confirmation_v2', {
      first_name: 'Sophie', business_name: 'Ellindigo', date: 'Thu 3 Sept', time: '12:00',
    });
    expect(body).not.toContain(BOOKING_LINK_MARKER);
  });
});

/* ================================================================ judgement = */
describe('the judgement, without a database', () => {
  it('warns on the production case: confirmations every day, link follow-ups never', () => {
    const v = judgeConfirmationLinks({ confirmations: 23, links: 0 });
    expect(v.ok).toBe(false);
    expect(v.status).toBe('warn');
    // Not an outage. Nothing here should page anybody.
    expect(v.critical).toBe(false);
    expect(v.detail).toMatch(/23/);
    expect(v.detail).toMatch(/only 0/);
    // A sentence a human can act on, not a metric.
    expect(v.detail).toMatch(/cancel/i);
    expect(v.detail).toMatch(/generic_message/);
    expect(v.detail).not.toMatch(/[–—]/);
  });

  it('says nothing on a quiet fortnight, because three messages is not evidence', () => {
    const v = judgeConfirmationLinks({ confirmations: 3, links: 0 });
    expect(v.ok).toBe(true);
    expect(v.status).toBe('ok');
    expect(v.detail).toMatch(/too few/i);
  });

  it('is happy when the links are going out', () => {
    const v = judgeConfirmationLinks({ confirmations: 20, links: 20 });
    expect(v.ok).toBe(true);
    expect(v.link_ratio).toBe(1);
  });

  it('tolerates an ordinary mix of failures rather than crying wolf', () => {
    const v = judgeConfirmationLinks({ confirmations: 20, links: 14 });
    expect(v.ok).toBe(true);
  });

  it('trips once most clients are getting a linkless confirmation', () => {
    const v = judgeConfirmationLinks({ confirmations: 20, links: 6 });
    expect(v.ok).toBe(false);
    expect(v.link_ratio).toBe(0.3);
  });

  it('counts nothing at all as nothing to judge, not as a fault', () => {
    const v = judgeConfirmationLinks({ confirmations: 0, links: 0 });
    expect(v.ok).toBe(true);
  });
});

/* ============================================================== end to end == */
describe('/health can now go amber on this', () => {
  it('warns when a fortnight of WhatsApp confirmations carried no link', async () => {
    for (let i = 0; i < 14; i++) confirmation({ age: i });

    const result = await runHealthChecks({ stripe: null, jobs: [] });

    expect(result.checks.confirmation_links.status).toBe('warn');
    expect(result.checks.confirmation_links.whatsapp_confirmations).toBe(14);
    expect(result.checks.confirmation_links.link_follow_ups).toBe(0);
    expect(result.warnings).toContain('confirmation_links');
    // Warn, so the API is not reported as degraded and BetterStack is not paged.
    expect(result.failing).not.toContain('confirmation_links');
    expect(result.status).toBe('ok');
  });

  it('goes quiet again once the link is going out with them', async () => {
    for (let i = 0; i < 14; i++) { confirmation({ age: i }); linkFollowUp({ age: i }); }

    const result = await runHealthChecks({ stripe: null, jobs: [] });

    expect(result.checks.confirmation_links.status).toBe('ok');
    expect(result.checks.confirmation_links.link_follow_ups).toBe(14);
    expect(result.warnings).not.toContain('confirmation_links');
  });

  it('ignores what happened before the window', async () => {
    // A fault fixed last month must stop warning, or the monitor stays red for
    // ever and gets muted.
    for (let i = 0; i < 20; i++) confirmation({ age: 40 + i });

    const result = await runHealthChecks({ stripe: null, jobs: [] });
    expect(result.checks.confirmation_links.whatsapp_confirmations).toBe(0);
    expect(result.checks.confirmation_links.status).toBe('ok');
  });

  it('does not count the SMS path, which has carried the link all along', async () => {
    for (let i = 0; i < 14; i++) {
      db.messages.push({
        beautician_id: 'b1', direction: 'outbound', channel: 'sms',
        content: 'Hi Sophie, your Brow Lamination with Ellindigo is confirmed for Thu 3 Sept at 12:00. Add it to your calendar: https://api.florrie.ai/api/booking/ellindigo/manage/tok/calendar',
        created_at: daysAgo(i),
      });
    }
    const result = await runHealthChecks({ stripe: null, jobs: [] });
    expect(result.checks.confirmation_links.whatsapp_confirmations).toBe(0);
    expect(result.checks.confirmation_links.status).toBe('ok');
  });

  it('does not count what clients send us', async () => {
    for (let i = 0; i < 14; i++) confirmation({ age: i });
    db.messages.push({
      beautician_id: 'b1', direction: 'inbound', channel: 'whatsapp',
      content: "Hey, I can't see a link in the confirmation. Should it come through text or email? X",
      created_at: daysAgo(0),
    });

    const result = await runHealthChecks({ stripe: null, jobs: [] });
    expect(result.checks.confirmation_links.whatsapp_confirmations).toBe(14);
    expect(result.checks.confirmation_links.link_follow_ups).toBe(0);
  });

  it('is listed among the checks whatever the answer', async () => {
    const result = await runHealthChecks({ stripe: null, jobs: [] });
    expect(result.checks).toHaveProperty('confirmation_links');
    expect(result.checks.confirmation_links.critical).toBe(false);
  });
});
