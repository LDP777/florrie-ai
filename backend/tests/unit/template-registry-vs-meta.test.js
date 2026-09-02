/**
 * THE REGISTRY WAS WRONG ABOUT META FOR MONTHS AND NOTHING COULD SAY SO.
 *
 * lib/whatsapp-templates.js declares, per template and per version, the COUNT
 * and ORDER of the {{n}} slots in the body Meta approved. Every WhatsApp send
 * is built from that declaration. It is a claim about somebody else's servers,
 * and nothing in this repository had ever checked it.
 *
 * On 27 August 2026 the live WABA was read and two of the five were wrong:
 *
 *   reminder_24h_v2    registry said 3 slots, Meta's body has 2
 *   generic_message_v2 registry said 2 slots, Meta's body has 1
 *
 * Meta refuses a send whose parameter count does not match the approved body.
 * No bounce, no error the client can see, no missing row: the message simply
 * never happens. So the 24-hour reminder was dead on WhatsApp, and the booking
 * link, which travels on generic_message because it is the only template with
 * a free-text slot, had never once been delivered.
 *
 * confirmation_links catches the CONSEQUENCE of that, and only after a
 * fortnight of it. This check catches the CAUSE on the first poll: it asks
 * Meta what the bodies say and reports every template where the registry has
 * stopped being true.
 *
 * The other half of the rule, and the reason a Graph blip must never trip it:
 * a monitor that cries wolf gets muted, and a muted monitor is how the
 * Instagram token stayed dead for five weeks.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/* ------------------------------------------------------------------ the db --
 * health.js reads several tables. Nothing here is under test, so the builder
 * only has to answer without throwing.
 */
const db = { messages: [], beauticians: [], stripe_events: [], transactions: [] };

function builder(table) {
  const filters = [];
  let head = false;
  const rows = () => (db[table] || []).filter((r) => filters.every((f) => f(r)));
  const settle = () => (head
    ? { data: null, error: null, count: rows().length }
    : { data: rows(), error: null, count: rows().length });
  const b = {
    select(spec, opts) { if (opts?.head) head = true; return b; },
    insert() { return b; }, update() { return b; },
    eq(c, v) { filters.push((r) => r[c] === v); return b; },
    neq() { return b; }, in() { return b; }, is() { return b; }, not() { return b; }, or() { return b; },
    ilike() { return b; }, gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
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

const { judgeTemplateParams, judgeTemplateCoverage, countBodyParams } = await import('../../src/lib/health.js');

/* -------------------------------------------------------------- the fixture --
 * The five bodies that were APPROVED on WABA 1458055882486306 on 27 August
 * 2026, copied verbatim. Two of them disagree with what the registry said that
 * morning, which is the whole incident.
 */
const LIVE_BODIES = {
  booking_confirmation_v2: "Hi {{1}}, your appointment is confirmed for {{2}} at {{3}}. We can't wait to see you. Reply if you need to make any changes.",
  reminder_24h_v2: 'Hi {{1}}, just a reminder that your appointment is tomorrow at {{2}}. See you then. Reply if you need to reschedule.',
  gap_fill_offer_v2: 'Hi {{1}}, we have a last-minute opening on {{2}} at {{3}}. Want to grab it? Reply YES to book, or let me know if another time works better.',
  rebook_nudge_v2: 'Hi {{1}}, it has been a little while since your last visit. Fancy getting booked back in? Reply and I will find you a time.',
  generic_message_v2: 'Hi {{1}}, hope to see you soon.',
};

/** One row in the shape GET /{waba}/message_templates returns. */
const metaRow = (name, body, status = 'APPROVED') => ({
  name,
  status,
  components: [{ type: 'BODY', text: body }],
});

const liveWaba = (overrides = {}) => Object.entries({ ...LIVE_BODIES, ...overrides })
  .map(([name, body]) => metaRow(name, body));

/* ============================================================== the counting = */
describe('counting the slots in a body, the way Meta does', () => {
  it('counts distinct placeholders, not occurrences', () => {
    expect(countBodyParams('Hi {{1}}, see you at {{2}} on {{2}}.')).toBe(2);
  });

  it('tolerates the whitespace Meta allows inside the braces', () => {
    expect(countBodyParams('Hi {{ 1 }}, your slot is {{2}}.')).toBe(2);
  });

  it('says zero for a body with no parameters at all, and for nothing', () => {
    expect(countBodyParams('Hope to see you soon.')).toBe(0);
    expect(countBodyParams(null)).toBe(0);
  });
});

/* ============================================================== the judgement =
 * Pure data in, findings out. No network, no database, no runner.
 */
describe('the judgement, without a network', () => {
  it('says nothing when the registry and Meta agree', () => {
    const v = judgeTemplateParams([
      metaRow('booking_confirmation_v2', LIVE_BODIES.booking_confirmation_v2),
      metaRow('gap_fill_offer_v2', LIVE_BODIES.gap_fill_offer_v2),
      metaRow('rebook_nudge_v2', LIVE_BODIES.rebook_nudge_v2),
    ]);
    expect(v.ok).toBe(true);
    expect(v.status).toBe('ok');
    expect(v.mismatches).toEqual([]);
    expect(v.templates_checked).toBe(3);
  });

  it('catches the reminder, and says what it breaks for the client', () => {
    // The registry has since been corrected, so this fabricates the old body
    // rather than the old registry: a THREE-slot reminder on Meta against the
    // two the registry now declares is the same disagreement seen from the
    // other side, and it is what a future edit to the Meta body would look
    // like.
    const v = judgeTemplateParams([
      metaRow('reminder_24h_v2', 'Hi {{1}}, your {{2}} is tomorrow at {{3}}.'),
    ]);
    expect(v.ok).toBe(false);
    expect(v.status).toBe('warn');
    // Nothing is down. Nobody should be paged for a template body.
    expect(v.critical).toBe(false);

    expect(v.mismatches).toEqual([{
      template: 'reminder_24h_v2',
      registry_params: 2,
      registry_fields: ['first_name', 'time'],
      meta_params: 3,
      breaks: expect.stringContaining('24-hour reminder'),
    }]);

    // The sentence a human reads at 9am: which template, both counts, and the
    // consequence. Not a metric.
    expect(v.detail).toMatch(/reminder_24h_v2/);
    expect(v.detail).toMatch(/declares 2 parameter/);
    expect(v.detail).toMatch(/approved takes 3/);
    expect(v.detail).toMatch(/rejects every send/i);
    expect(v.detail).not.toMatch(/[–—]/);
  });

  it('catches the one that hid the booking link, and names that consequence', () => {
    const v = judgeTemplateParams([
      metaRow('generic_message_v2', 'Hi {{1}}, {{2}} Reply here anytime.'),
    ]);
    expect(v.status).toBe('warn');
    expect(v.mismatches[0]).toMatchObject({
      template: 'generic_message_v2', registry_params: 1, meta_params: 2,
    });
    expect(v.detail).toMatch(/booking link/i);
  });

  it('reports every disagreeing template, not just the first', () => {
    const v = judgeTemplateParams([
      metaRow('reminder_24h_v2', 'Hi {{1}}, your {{2}} is tomorrow at {{3}}.'),
      metaRow('generic_message_v2', 'Hi {{1}}, {{2}} Reply here anytime.'),
      metaRow('rebook_nudge_v2', LIVE_BODIES.rebook_nudge_v2),
    ]);
    expect(v.mismatches.map((m) => m.template)).toEqual(['reminder_24h_v2', 'generic_message_v2']);
    expect(v.templates_checked).toBe(3);
  });

  it('is quiet about the live WABA as it stands once the registry was corrected', () => {
    const v = judgeTemplateParams(liveWaba());
    expect(v.ok).toBe(true);
    expect(v.templates_checked).toBe(5);
  });

  it('judges only what Meta has APPROVED', () => {
    // A PENDING template carries the body WE submitted, so it cannot disagree
    // with us yet, and a REJECTED one can never be sent. generic_message_v4
    // was rejected on 27 August for having too many variables for its length;
    // that is a submission problem, not a registry lie, and it must not warn.
    const v = judgeTemplateParams([
      metaRow('reminder_24h_v4', 'Hi {{1}}, {{2}}, {{3}}, {{4}}, {{5}}, {{6}}.', 'PENDING'),
      metaRow('generic_message_v4', 'Hi {{1}}.', 'REJECTED'),
      metaRow('rebook_nudge_v2', LIVE_BODIES.rebook_nudge_v2),
    ]);
    expect(v.ok).toBe(true);
    expect(v.templates_checked).toBe(1);
  });

  it('ignores templates a beautician wrote herself', () => {
    const v = judgeTemplateParams([
      metaRow('sallys_christmas_offer', 'Hi {{1}}, {{2}} off in December, {{3}}.'),
      metaRow('rebook_nudge_v2', LIVE_BODIES.rebook_nudge_v2),
    ]);
    expect(v.ok).toBe(true);
    expect(v.templates_checked).toBe(1);
  });

  it('never calls an empty WABA a pass, because it compared nothing', () => {
    // CHANGED 1 September 2026. This used to assert status 'ok'. On that day
    // the health payload reported 53 of the last 55 confirmations going out
    // with no manage link, told the reader to come and look at this check for
    // the reason, and this check showed them a tick. Zero comparisons is
    // 'not_checked', the same rule the nightly column drift check follows.
    const v = judgeTemplateParams([]);
    expect(v.status).toBe('not_checked');
    expect(v.templates_checked).toBe(0);
    expect(v.detail).toMatch(/Nothing was compared, so this is not a pass/);
    // Ambiguous (a new tenant looks identical to a wrong id), so not a warning.
    expect(v.ok).toBe(true);
  });

  it('warns, and names them, when the WABA holds only templates that are not ours', () => {
    // Not ambiguous at all: we are pointed at the wrong account, or ours were
    // approved under other names. Both need a person, so it goes in warnings.
    const v = judgeTemplateParams([
      { name: 'hello_world', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hello {{1}}' }] },
      { name: 'someone_promo', status: 'PENDING', components: [{ type: 'BODY', text: 'hi' }] },
    ]);
    expect(v.ok).toBe(false);
    expect(v.status).toBe('warn');
    expect(v.templates_on_waba).toBe(2);
    expect(v.templates_approved_on_waba).toBe(1);
    expect(v.detail).toMatch(/hello_world/);
    expect(v.detail).toMatch(/WHATSAPP_WABA_ID points at a different account/);
  });

  it('reads the BODY component and not the header or the buttons', () => {
    const v = judgeTemplateParams([{
      name: 'rebook_nudge_v2',
      status: 'APPROVED',
      components: [
        { type: 'HEADER', text: 'A note from {{1}}' },
        { type: 'BODY', text: LIVE_BODIES.rebook_nudge_v2 },
        { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://florrie.ai/{{1}}' }] },
      ],
    }]);
    expect(v.ok).toBe(true);
  });
});

/* ============================================================== through /health
 * The wiring, with Meta stood in for. The rule that matters here is the fail
 * soft one: a Graph problem is UNKNOWN and never a warning.
 */
describe('/health asks Meta, and never invents an outage when it cannot', () => {
  const REAL_TOKEN = process.env.WHATSAPP_TOKEN;
  const REAL_WABA = process.env.WHATSAPP_WABA_ID;
  let graph;

  const jsonRes = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  /** Fresh module registry per test: the check remembers its answer for six
   *  hours on purpose, so a shared instance would answer the second test with
   *  the first test's Meta. */
  async function health() {
    vi.resetModules();
    return import('../../src/lib/health.js');
  }

  beforeEach(() => {
    process.env.WHATSAPP_TOKEN = 'test-token';
    process.env.WHATSAPP_WABA_ID = 'waba_1458055882486306';
    graph = vi.fn(async () => jsonRes(200, { data: liveWaba() }));
    global.fetch = graph;
  });

  afterEach(() => {
    if (REAL_TOKEN === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = REAL_TOKEN;
    if (REAL_WABA === undefined) delete process.env.WHATSAPP_WABA_ID;
    else process.env.WHATSAPP_WABA_ID = REAL_WABA;
  });

  it('is listed among the checks whatever the answer', async () => {
    const { runHealthChecks } = await health();
    const result = await runHealthChecks({ stripe: null, jobs: [] });
    expect(result.checks).toHaveProperty('template_params');
    expect(result.checks.template_params.critical).toBe(false);
  });

  it('goes amber, without going degraded, when a body has drifted', async () => {
    graph.mockResolvedValue(jsonRes(200, {
      data: liveWaba({ generic_message_v2: 'Hi {{1}}, {{2}} Reply here anytime.' }),
    }));
    const { runHealthChecks } = await health();
    const result = await runHealthChecks({ stripe: null, jobs: [] });

    expect(result.checks.template_params.status).toBe('warn');
    expect(result.warnings).toContain('template_params');
    // Warn, never critical. BetterStack must not page for a template body.
    expect(result.failing).not.toContain('template_params');
    expect(result.status).toBe('ok');
  });

  it('says unknown, not warn, when Meta answers with an error', async () => {
    graph.mockResolvedValue(jsonRes(401, { error: { message: 'Session has expired' } }));
    const { runHealthChecks } = await health();
    const result = await runHealthChecks({ stripe: null, jobs: [] });

    expect(result.checks.template_params.status).toBe('unknown');
    expect(result.checks.template_params.ok).toBe(true);
    expect(result.warnings).not.toContain('template_params');
    expect(result.checks.template_params.detail).toMatch(/Session has expired/);
  });

  it('says unknown when the Graph call throws outright', async () => {
    graph.mockRejectedValue(new Error('getaddrinfo ENOTFOUND graph.facebook.com'));
    const { runHealthChecks } = await health();
    const result = await runHealthChecks({ stripe: null, jobs: [] });

    expect(result.checks.template_params.status).toBe('unknown');
    expect(result.warnings).not.toContain('template_params');
  });

  it('says skipped where WhatsApp is not configured, rather than pretending to have checked', async () => {
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    const { runHealthChecks } = await health();
    const result = await runHealthChecks({ stripe: null, jobs: [] });

    expect(result.checks.template_params.status).toBe('skipped');
    expect(result.checks.template_params.ok).toBe(true);
    expect(graph).not.toHaveBeenCalled();
  });

  it('asks Meta once and remembers the answer, because /health is polled every 30 seconds', async () => {
    const { runHealthChecks } = await health();
    await runHealthChecks({ stripe: null, jobs: [] });
    await runHealthChecks({ stripe: null, jobs: [] });
    await runHealthChecks({ stripe: null, jobs: [] });
    expect(graph).toHaveBeenCalledTimes(1);
  });
});

describe('a template the sender needs and the WABA does not have', () => {
  // 1 September 2026. 53 of the last 55 booking confirmations went out with no
  // manage link. The link rides in a second send on generic_message_v4, and
  // when that version is absent the sender falls back to the _v2 body, which
  // has one slot. A caller handing it a name AND a link is refused outright
  // rather than shortened, so the client gets a confirmation she cannot act on.
  //
  // Nothing in the health payload said the word 'generic_message'. The
  // mismatch list can only speak about templates that are present, and an
  // absent one was silent here and loud everywhere else.
  const approvedBody = (name, text) => ({ name, status: 'APPROVED', components: [{ type: 'BODY', text }] });

  // Param counts match the registry exactly, so these rows are only ever about
  // presence and absence. A fixture with the wrong count would fail the OTHER
  // judgement and make this file look like it was testing something it is not.
  const allFive = [
    approvedBody('booking_confirmation_v4', 'Hi {{1}}, {{2}} on {{3}} at {{4}}'),
    approvedBody('reminder_24h_v4', 'Hi {{1}}, {{2}} {{3}} at {{4}}'),
    approvedBody('gap_fill_offer_v4', 'Hi {{1}}, {{2}} has {{3}} at {{4}}'),
    approvedBody('rebook_nudge_v4', 'Hi {{1}}, from {{2}}'),
    approvedBody('generic_message_v4', 'Hi {{1}}, {{2}} here. {{3}}'),
  ];

  it('says nothing when the WABA has every version the sender reaches for', () => {
    const v = judgeTemplateCoverage(allFive);
    expect(v.missing).toEqual([]);
    expect(v.status).toBe('ok');
  });

  it('names the absent template and what breaks without it', () => {
    const v = judgeTemplateCoverage(allFive.filter(t => t.name !== 'generic_message_v4'));
    expect(v.ok).toBe(false);
    expect(v.status).toBe('warn');
    expect(v.missing).toEqual(['generic_message_v4']);
    expect(v.detail).toMatch(/generic_message_v4/);
    expect(v.detail).toMatch(/booking link/);
  });

  it('is a separate judgement from the parameter count, because the fixes differ', () => {
    // A wrong count means Meta refuses the send. An absent template means the
    // sender quietly uses an older body with fewer slots. Reporting them
    // through one verdict meant a partial list of templates, which is normal
    // in a unit test and never happens in production, read as five missing.
    const rows = allFive.filter(t => t.name !== 'generic_message_v4');
    expect(judgeTemplateParams(rows).status).toBe('ok');
    expect(judgeTemplateCoverage(rows).status).toBe('warn');
  });
});

describe('when the audited account is in doubt, /health says which one to use', () => {
  // 2 September 2026. waba_source came back 'env_phone_parent_unknown', the
  // env account held seven templates with no version suffix, and Meta was
  // accepting booking_confirmation_v2 from the phone number, so the real
  // account was somewhere else. Finding it meant a person reading Business
  // Manager. Now the payload names it, and says why the lookup failed.
  const src = readFileSync(new URL('../../src/lib/health.js', import.meta.url), 'utf8');
  const notif = readFileSync(new URL('../../src/services/notifications.js', import.meta.url), 'utf8');

  it('carries the reason the phone lookup failed instead of a bare null', () => {
    expect(notif).toMatch(/export async function explainPhoneParentWaba/);
    // The first version read GET /{phone}?fields=whatsapp_business_account,
    // which Meta answered with "(#100) Tried accessing nonexisting field". It
    // had never worked. The lookup now goes token -> scoped accounts -> which
    // one owns the phone, and each way THAT can fail has its own reason.
    expect(notif).toMatch(/reason: 'token_scoped_to_no_waba_and_no_env_waba'/);
    expect(notif).toMatch(/reason: 'no_candidate_waba_owns_phone'/);
    // The env account is always tried, first: a broad token lists no targets.
    expect(notif).toMatch(/\[\.\.\.new Set\(\[WA_WABA_ID, \.\.\.scoped\.ids\]/);
    expect(notif).not.toMatch(/fields=whatsapp_business_account\{id\}/);
    expect(src).toMatch(/phone_lookup_failed: answer\.phoneLookup/);
  });

  it('lists the accounts the token can see only when the audited one is in doubt', () => {
    // Several Graph calls, so not on every poll of a healthy setup.
    expect(src).toMatch(/candidates: resolved\.source === 'env_phone_parent_unknown' \? await listWabaCandidates\(token\) : null/);
  });

  it('names the account to set, and refuses to pick when it is ambiguous', () => {
    expect(src).toMatch(/set_whatsapp_waba_id_to: rightOne\.length === 1/);
    expect(src).toMatch(/more than one account has all five _v4 templates/);
    expect(src).toMatch(/no account this token can see has all five _v4 templates approved/);
  });

  it('lists accounts from the token scopes, not /me/businesses, which the token is not permitted to call', () => {
    // Production answered the businesses call with "(#100) Missing Permission".
    expect(src).toMatch(/const scoped = await wabaIdsThisTokenIsScopedTo\(\)/);
    expect(src).not.toMatch(/\/me\/businesses/);
    expect(src).toMatch(/scoped\.ids\.slice\(0, 10\)/);
  });
});
