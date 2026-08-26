/**
 * The nightly check has to be wrong less often than the one it replaces.
 *
 * WHY THESE TESTS EXIST
 * Issue #165 filed six findings. Three were false, one was misjudged, one was a
 * description of the sandbox it ran in, and the biggest fact about the
 * repository went unmentioned. Every one of those failures was a JUDGEMENT
 * failure rather than a plumbing failure: the data was fine and the conclusion
 * drawn from it was not. So the judgements in scripts/nightly-check.mjs are
 * pure functions with no network, no filesystem and no database, and this file
 * feeds each of them the shapes that broke the last check.
 *
 * The tests below are named after the mistakes they prevent, because in a year
 * the name is the only part anybody will read.
 */
import { describe, it, expect } from 'vitest';
import {
  judgeHealthPayload,
  judgeLockParity,
  judgeLockSatisfiesManifest,
  judgePlatformMatrix,
  judgeLedger,
  judgeBoot,
  diffAudit,
  findRoutes,
  findOrphanRoutes,
  findServiceRoleJwt,
  decideSpeech,
  fingerprintOf,
  URL_ONLY_ROUTES,
} from '../../../scripts/nightly-check.mjs';

const sev = (findings, s) => findings.filter((f) => f.severity === s);

/* ========================================================================= *
 * THE API
 *
 * Two failure modes, and the check has to tell them apart. "I could not reach
 * it" is a fact about the runner. "It answered and said it was degraded" is a
 * fact about the product. #165 reported the first as if it were the second.
 * ========================================================================= */

describe('the API health payload', () => {
  it('does not call an unreachable API a fault unless the caller asserts the network works', () => {
    const out = judgeHealthPayload({ transportError: 'getaddrinfo ENOTFOUND', requireNetwork: false });
    expect(sev(out, 'fail')).toHaveLength(0);
    expect(sev(out, 'not_checked')).toHaveLength(1);
    expect(out[0].detail).toMatch(/--require-network/);
  });

  it('does call an unreachable API a fault when the caller asserts the network works', () => {
    const out = judgeHealthPayload({ transportError: 'getaddrinfo ENOTFOUND', requireNetwork: true });
    expect(sev(out, 'fail')).toHaveLength(1);
  });

  /*
   * The sandbox this was written in answers HTTP 403 with a plain-text
   * "Host not in allowlist" page. An earlier draft read the 403 and reported
   * "the API is not answering", which is #165's mistake wearing a different
   * coat: an HTTP status from a proxy looks exactly like an HTTP status from
   * the service if you only read the number.
   */
  it('treats a non-JSON answer as not-reached rather than as a broken API', () => {
    const out = judgeHealthPayload({
      status: 403,
      payload: null,
      body: 'Host not in allowlist: api.florrie.ai',
      requireNetwork: false,
    });
    expect(sev(out, 'fail')).toHaveLength(0);
    expect(out[0].detail).toContain('Host not in allowlist');
  });

  it('reports a critical dependency by name, with the API\'s own detail', () => {
    const out = judgeHealthPayload({
      status: 503,
      requireNetwork: true,
      payload: {
        status: 'degraded',
        failing: ['stripe_webhook_secret'],
        warnings: [],
        checks: {
          stripe_webhook_secret: {
            ok: false,
            status: 'fail',
            critical: true,
            detail: 'STRIPE_WEBHOOK_SECRET missing, every Stripe event will be rejected',
          },
        },
      },
    });
    expect(sev(out, 'fail')).toHaveLength(1);
    expect(out[0].title).toContain('stripe_webhook_secret');
    expect(out[0].detail).toContain('every Stripe event will be rejected');
  });

  /*
   * health.js answers a harness failure with `failing: ['health_check_harness']`
   * and NO `checks` key at all. Anything that assumes `checks` exists throws
   * here, and a check that throws reports nothing on the night it matters most.
   */
  it('survives the harness-failure shape, which carries no checks object', () => {
    const out = judgeHealthPayload({
      status: 503,
      requireNetwork: true,
      payload: { status: 'degraded', failing: ['health_check_harness'], error: 'boom' },
    });
    expect(sev(out, 'fail')).toHaveLength(1);
    expect(out[0].title).toMatch(/harness/);
  });

  it('names the stale cron rather than saying "crons"', () => {
    const out = judgeHealthPayload({
      status: 503,
      requireNetwork: true,
      payload: {
        status: 'ok',
        failing: [],
        warnings: ['crons'],
        checks: {
          crons: {
            ok: false,
            status: 'warn',
            jobs: {
              reconciliation: { status: 'stale', last_success_at: '2026-08-20T02:00:00Z', consecutive_failures: 3 },
              reminders: { status: 'ok', last_success_at: '2026-08-26T02:00:00Z' },
            },
          },
        },
      },
    });
    const fails = sev(out, 'fail');
    expect(fails).toHaveLength(1);
    expect(fails[0].title).toContain('reconciliation');
    expect(fails[0].title).not.toContain('reminders');
  });

  /*
   * THE #165 TRAP, INVERTED. health.js answers `crons: unknown` when job_runs
   * is unreadable, which MIGHT mean migration 020 never ran. The old check
   * would have announced the migration as missing. This one is required to say
   * only what it knows.
   */
  it('will not turn an unreadable job_runs into a claim about a migration', () => {
    const out = judgeHealthPayload({
      status: 200,
      requireNetwork: true,
      payload: {
        status: 'ok',
        failing: [],
        warnings: [],
        checks: { crons: { ok: true, status: 'unknown', detail: 'job_runs unavailable' } },
      },
    });
    expect(sev(out, 'fail')).toHaveLength(0);
    expect(sev(out, 'warn')).toHaveLength(0);
    const nc = sev(out, 'not_checked');
    expect(nc).toHaveLength(1);
    expect(nc[0].detail).toMatch(/NOT evidence that migration 020/);
  });

  it('says the API is healthy when it is, without inventing anything', () => {
    const out = judgeHealthPayload({
      status: 200,
      requireNetwork: true,
      payload: {
        status: 'ok',
        failing: [],
        warnings: [],
        duration_ms: 412,
        checks: { database: { ok: true, status: 'ok' }, stripe_api: { ok: true, status: 'ok' } },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('info');
  });
});

/* ========================================================================= *
 * REACHABILITY
 *
 * #165 measured "is every file imported" and answered "no orphans". Every page
 * IS imported: App.jsx imports all of them to declare their routes. The
 * question is whether anything LINKS to the page.
 * ========================================================================= */

const APP = `
  <Routes>
    <Route path="/book/:slug" element={<BookingPage />} />
    <Route path="/support" element={<Support />} />
  </Routes>
  <Routes>
    <Route path="/login" element={<Login />} />
    <Route path="*" element={<Navigate to="/login" replace />} />
  </Routes>
  <Routes>
    <Route path="/" element={<Hub />} />
    <Route path="/hub" element={<Hub />} />
    <Route path="/clients" element={<Clients />} />
    <Route path="/notes" element={<AppointmentNotes />} />
    <Route path="/consultation-forms/:id" element={<ConsultationFormBuilder />} />
    <Route path="/reports" element={<Navigate to="/analytics" replace />} />
    <Route path="/pay/success" element={<StatusPage kind="pay_success" />} />
    <Route path="/support" element={<Support />} />
    <Route path="*" element={<NotFound />} />
  </Routes>
`;

describe('route reachability', () => {
  it('grades the signed in shell, identified by its NotFound catch all', () => {
    const { shell, routes } = findRoutes(APP);
    expect(shell).toBeTruthy();
    const paths = routes.map((r) => r.path);
    expect(paths).toContain('/clients');
    // The public and logged out blocks are a different question entirely.
    expect(paths).not.toContain('/login');
    expect(paths).not.toContain('/book/:slug');
  });

  it('finds a page nothing links to, and only that page', () => {
    const { routes } = findRoutes(APP);
    const orphans = findOrphanRoutes({ routes, references: new Set(['/clients', '/pay/success']) });
    expect(orphans).toEqual(['/notes']);
  });

  it('does not call a redirect, a sent link or an alias dead', () => {
    const { routes } = findRoutes(APP);
    const orphans = findOrphanRoutes({ routes, references: new Set(['/clients', '/pay/success']) });
    expect(orphans).not.toContain('/reports');              // a redirect, not a page
    expect(orphans).not.toContain('/consultation-forms/:id'); // entered from a link we sent
    expect(orphans).not.toContain('/hub');                    // the same element as /
  });

  it('clears a route the backend or the marketing site links to', () => {
    const { routes } = findRoutes(APP);
    // /pay/success only ever appears as a Stripe return URL built in the
    // backend. Without that source it looks dead, which is why the real check
    // reads the `${SOMETHING_URL}/path` templates in backend/src.
    const withoutBackend = findOrphanRoutes({ routes, references: new Set(['/clients']) });
    expect(withoutBackend).toContain('/pay/success');
    const withBackend = findOrphanRoutes({ routes, references: new Set(['/clients', '/pay/success']) });
    expect(withBackend).not.toContain('/pay/success');
  });

  it('excludes only URL-only routes that carry a written reason', () => {
    const { routes } = findRoutes(APP);
    const orphans = findOrphanRoutes({ routes, references: new Set([]) });
    expect(orphans).not.toContain('/support');
    for (const [route, why] of URL_ONLY_ROUTES) {
      expect(route.startsWith('/')).toBe(true);
      expect(why.length).toBeGreaterThan(20);
    }
  });
});

/* ========================================================================= *
 * LOCKFILES
 *
 * The two findings the old check missed entirely.
 * ========================================================================= */

describe('a lockfile against the package.json beside it', () => {
  it('sees a dependency bumped in the manifest that never reached the lock', () => {
    const problems = judgeLockSatisfiesManifest({
      manifest: { dependencies: { '@sentry/node': '^10.70.0' }, devDependencies: { vitest: '^4.1.10' } },
      lock: {
        packages: {
          '': { dependencies: { '@sentry/node': '^8.0.0' } },
          'node_modules/@sentry/node': { version: '8.55.2' },
        },
      },
    });
    expect(problems).toHaveLength(2);
    expect(problems.find((p) => p.name === '@sentry/node')).toMatchObject({ kind: 'stale', resolved: '8.55.2' });
    expect(problems.find((p) => p.name === 'vitest')).toMatchObject({ kind: 'missing' });
  });

  it('is quiet when the lock still describes the manifest', () => {
    expect(judgeLockSatisfiesManifest({
      manifest: { dependencies: { react: '^19.0.0' } },
      lock: { packages: { '': { dependencies: { react: '^19.0.0' } }, 'node_modules/react': { version: '19.2.8' } } },
    })).toEqual([]);
  });
});

describe('advisory parity between a workspace lock and the root lock', () => {
  const root = { 'exceljs@>=3.5.0:moderate': { name: 'exceljs', severity: 'moderate', runtime: true } };

  it('fails when the workspace lock ships a RUNTIME advisory the root lock does not', () => {
    const out = judgeLockParity({
      workspace: 'frontend',
      rootAdvisories: root,
      childAdvisories: {
        ...root,
        'react-router-dom@<=7.18.1:high': { name: 'react-router-dom', severity: 'high', runtime: true },
      },
      versionGaps: { 'react-router-dom': { child: '7.18.1', root: '7.18.2' } },
    });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('fail');
    expect(out[0].detail).toContain('7.18.1');
    expect(out[0].detail).toContain('7.18.2');
    expect(out[0].fix).toEqual({ kind: 'lockfile-refresh', workspace: 'frontend' });
  });

  /*
   * The @capacitor/cli misjudgement from #165, made structural. A dev only
   * advisory is a build machine supply chain risk, not a production
   * vulnerability, and the report has to say which one it is or nobody can
   * decide how urgently to care.
   */
  it('warns rather than fails when the extra advisories are dev only, and says so', () => {
    const out = judgeLockParity({
      workspace: 'frontend',
      rootAdvisories: root,
      childAdvisories: { ...root, 'postcss@<8.5.19:high': { name: 'postcss', severity: 'high', runtime: false } },
    });
    expect(out[0].severity).toBe('warn');
    expect(out[0].detail).toMatch(/dev only/);
    expect(out[0].detail).toMatch(/build machine risk/);
  });

  it('says nothing at all when the two locks agree', () => {
    expect(judgeLockParity({ workspace: 'frontend', rootAdvisories: root, childAdvisories: { ...root } })).toEqual([]);
  });
});

describe('the platform matrix', () => {
  it('is not applied to a lockfile with no bundler in it', () => {
    // backend has no rollup and no esbuild, so demanding darwin binaries of it
    // would be a permanent false alarm.
    expect(judgePlatformMatrix({ 'node_modules/express': { version: '4.22.2' } }).applicable).toBe(false);
  });

  it('catches the 19 August failure: a lock regenerated on Linux', () => {
    const result = judgePlatformMatrix({
      'node_modules/@rollup/rollup-linux-x64-gnu': { version: '4.0.0' },
      'node_modules/@esbuild/linux-x64': { version: '0.25.12' },
    });
    expect(result.applicable).toBe(true);
    expect(result.missing).toContain('@rollup/rollup-darwin-arm64');
  });
});

/* ========================================================================= *
 * THE MIGRATION LEDGER
 *
 * The check that #165 tried to do by reading a comment. It can only be done by
 * reading a database, and even then the answer is ambiguous, because
 * schema_migrations was created late.
 * ========================================================================= */

describe('the migration ledger', () => {
  it('fails on an edited migration, because that one is unambiguous', () => {
    const out = judgeLedger({
      files: [{ name: '001_initial_schema.sql', checksum: 'new' }],
      ledger: [{ name: '001_initial_schema.sql', checksum: 'old' }],
    });
    expect(sev(out, 'fail')).toHaveLength(1);
    expect(out[0].detail).toMatch(/OLD version/);
  });

  it('only WARNS on a pending file, and explains why it cannot be sure', () => {
    const out = judgeLedger({
      files: [
        { name: '019_knowledge.sql', checksum: 'a' },
        { name: '20260802_schema_migrations.sql', checksum: 'b' },
      ],
      ledger: [{ name: '20260802_schema_migrations.sql', checksum: 'b' }],
    });
    expect(sev(out, 'fail')).toHaveLength(0);
    const warn = sev(out, 'warn')[0];
    expect(warn.detail).toMatch(/predates the ledger/);
    expect(warn.detail).toMatch(/baseline --yes/);
  });

  it('is quiet when the ledger and the disk agree', () => {
    const out = judgeLedger({
      files: [{ name: '001.sql', checksum: 'a' }],
      ledger: [{ name: '001.sql', checksum: 'a' }],
    });
    expect(sev(out, 'fail')).toHaveLength(0);
    expect(sev(out, 'warn')).toHaveLength(0);
  });
});

/* ========================================================================= *
 * SECRETS IN A PUBLIC REPOSITORY
 * ========================================================================= */

describe('the secret scan', () => {
  const jwt = (payload) => [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'c2lnbmF0dXJlc2lnbmF0dXJl',
  ].join('.');

  /*
   * frontend/.env.production is TRACKED and holds a Supabase ANON key. It is
   * public by design and documented as such in the file. A scanner that fires
   * on it is a scanner that is muted within a week, and then it is not a
   * scanner at all.
   */
  it('does not fire on an anon key, which is public by design', () => {
    expect(findServiceRoleJwt(jwt({ iss: 'supabase', ref: 'abc', role: 'anon' }))).toEqual([]);
  });

  it('fires on a service role key, by decoding it rather than matching a prefix', () => {
    expect(findServiceRoleJwt(jwt({ iss: 'supabase', ref: 'abc', role: 'service_role' })))
      .toEqual(['service_role']);
  });

  it('shrugs at anything base64-shaped that is not a JWT', () => {
    expect(findServiceRoleJwt('eyJhbGciOi.bm90LWpzb24tYXQtYWxsLW5vdC1qc29u.c2ln')).toEqual([]);
  });
});

/* ========================================================================= *
 * WHEN TO SPEAK
 *
 * The rule that decides whether anybody ever reads this thing again.
 * ========================================================================= */

describe('deciding whether to speak', () => {
  const fail = { severity: 'fail', id: 'suite', title: 'backend tests failed', key: 'backend tests' };
  const warn = { severity: 'warn', id: 'reachability', title: '12 pages have no inbound link', key: 'a,b' };
  const note = { severity: 'info', id: 'audit_unchanged', title: 'unchanged' };

  it('speaks when something is failing', () => {
    expect(decideSpeech({ findings: [fail, note], previousFingerprints: [] }).speak).toBe(true);
  });

  it('speaks the first night a warning appears', () => {
    expect(decideSpeech({ findings: [warn], previousFingerprints: [] }).speak).toBe(true);
  });

  /*
   * The @capacitor/cli lesson. The same dev only critical, repeated verbatim
   * every night for the months a Capacitor 6 to 8 migration takes, is how a
   * report teaches everybody to skip it.
   */
  it('stays quiet on the second night of the same warning, and keeps the issue open', () => {
    const speech = decideSpeech({ findings: [warn, note], previousFingerprints: [fingerprintOf(warn)] });
    expect(speech.speak).toBe(false);
    expect(speech.keepOpen).toBe(true);
    expect(speech.close).toBe(false);
  });

  it('speaks again when the same check finds something different', () => {
    const grew = { ...warn, title: '13 pages have no inbound link', key: 'a,b,c' };
    expect(decideSpeech({ findings: [grew], previousFingerprints: [fingerprintOf(warn)] }).speak).toBe(true);
  });

  it('closes only when nothing is failing and nothing is warning', () => {
    const speech = decideSpeech({ findings: [note], previousFingerprints: [fingerprintOf(warn)] });
    expect(speech.close).toBe(true);
    expect(speech.speak).toBe(false);
  });

  /*
   * "not checked" must never open an issue and must never keep one open. It is
   * a gap in what was measured, not a fault, and treating it as one is how a
   * blocked egress proxy became a finding about the product.
   */
  it('does not treat "not checked" as a fault', () => {
    const nc = { severity: 'not_checked', id: 'migration_ledger', title: 'the ledger was not read' };
    const speech = decideSpeech({ findings: [nc], previousFingerprints: [] });
    expect(speech.speak).toBe(false);
    expect(speech.close).toBe(true);
  });
});

/* ========================================================================= *
 * THE AUDIT DIFF AND THE BOOT MEASUREMENT
 * ========================================================================= */

describe('the audit diff', () => {
  const tar = { 'tar@<7.5.7:critical': { name: 'tar', severity: 'critical', runtime: false } };

  it('calls the first run a baseline rather than a pile of new findings', () => {
    const d = diffAudit(null, tar);
    expect(d.first).toBe(true);
    expect(d.added).toEqual([]);
  });

  it('reports nothing when the set has not moved', () => {
    const d = diffAudit(tar, { ...tar });
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('reports an advisory that appeared and one that cleared', () => {
    const d = diffAudit(tar, { 'ws@<8.21:high': { name: 'ws', severity: 'high', runtime: true } });
    expect(d.added.map(([k]) => k)).toEqual(['ws@<8.21:high']);
    expect(d.removed).toEqual(['tar@<7.5.7:critical']);
  });
});

describe('the boot measurement', () => {
  const REPORT = `boot on a throttled 4G phone (1.6 Mbps, 150ms RTT, 4x CPU)
  first contentful paint   628 ms
  DOM content loaded       784 ms
  javascript before paint  515 KB across 3 files`;

  it('says not checked when the guard did not run', () => {
    expect(judgeBoot({ text: null })[0].severity).toBe('not_checked');
  });

  it('says not checked, rather than inventing a number, when the format changed', () => {
    const [f] = judgeBoot({ text: 'boot: everything is fine, honestly' });
    expect(f.severity).toBe('not_checked');
    expect(f.detail).toMatch(/changed its output/);
  });

  it('records a baseline on the first night', () => {
    const [f, state] = judgeBoot({ text: REPORT, previous: null });
    expect(f.severity).toBe('info');
    expect(state).toEqual({ fcp_ms: 628, js_before_paint_kb: 515 });
  });

  it('ignores ordinary jitter', () => {
    const [f] = judgeBoot({ text: REPORT, previous: { fcp_ms: 600, js_before_paint_kb: 500 } });
    expect(f.severity).toBe('info');
  });

  it('warns when meaningfully more JavaScript arrives before first paint', () => {
    const [f] = judgeBoot({ text: REPORT, previous: { fcp_ms: 600, js_before_paint_kb: 400 } });
    expect(f.severity).toBe('warn');
    expect(f.detail).toMatch(/400KB to 515KB/);
  });
});
