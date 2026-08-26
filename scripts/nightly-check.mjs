#!/usr/bin/env node
/**
 * The nightly check.
 *
 * WHY THIS EXISTS, AND WHY IT IS SHAPED LIKE THIS
 * The check this replaces filed GitHub issue #165 with six findings. Three of
 * them were not true, one was true but misjudged, one was a description of the
 * sandbox it ran in, and the largest fact about this repository (it is public)
 * went unmentioned. The worst of the six read a code COMMENT, which is a
 * legend for two Postgres error codes sitting directly above the predicate it
 * documents, and concluded from it that a migration had not been applied in
 * production. The table exists. There is a second comment of exactly the same
 * shape at backend/src/routes/knowledge.js line 19, waiting for the next
 * checker that cannot tell a defensive branch from an assertion.
 *
 * So this file obeys three rules, and every check below is written to them.
 *
 *   1. NEVER INFER A DEPLOYMENT STATE FROM SOURCE CODE.
 *      Not from a comment, not from a defensive branch, not from a fallback.
 *      A file on disk tells you what the code will do if it runs. It tells you
 *      nothing about the database, the CDN, or the running process. If the
 *      only way to know is to ask production, then ask production or say you
 *      did not.
 *
 *   2. "NOT CHECKED" IS A RESULT.
 *      Every check can return not_checked with a reason. A report that says
 *      "the migration ledger was not read, NIGHTLY_DATABASE_URL is not set" is
 *      more useful than a report that guesses, because the reader knows
 *      exactly what to do to turn it into an answer. A false alarm costs a
 *      human an afternoon and costs the check its credibility permanently.
 *
 *   3. ONLY SPEAK WHEN THERE IS SOMETHING TO SAY.
 *      A green issue every night is an issue nobody opens. The report is
 *      always written; the ISSUE is opened only on a failure or on a warning
 *      that is new, and closed the night everything clears.
 *
 * OUTPUT AND EXIT CODE follow frontend/scripts/check-*.mjs: a leading tick or
 * cross per check, exit 1 when something failed, exit 0 otherwise. Pass
 * --no-exit-code when a caller wants the report regardless (the workflow does,
 * because it still has to file the issue after a failure).
 *
 * USAGE
 *   node scripts/nightly-check.mjs                      everything it can do offline
 *   node scripts/nightly-check.mjs --require-network     treat an unreachable API as a failure
 *   node scripts/nightly-check.mjs --json report.json    machine readable, for the workflow
 *   node scripts/nightly-check.mjs --state .state.json   remember advisories between runs
 *   node scripts/nightly-check.mjs --fix                 apply the safe fixes and stop
 *
 * ENVIRONMENT (all optional, all degrade to not_checked)
 *   NIGHTLY_API_URL         default https://api.florrie.ai
 *   NIGHTLY_DATABASE_URL    read only Postgres URL, for the migration ledger
 *   REPO_VISIBILITY         public | private, passed in by the workflow
 *   BOOT_REPORT             path to captured `npm run check:boot` output
 *   SUITE_<NAME>            success | failure, one per gate the workflow ran
 *   RUN_URL                 link back to the workflow run, for the issue body
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ args -- */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

/* -------------------------------------------------------------- findings -- */

/**
 * Severities, in the order they are printed.
 *
 * fail        something is wrong now. Opens or keeps open the issue.
 * warn        a human should look. Opens the issue only the first night it appears.
 * not_checked this run could not answer. Never opens an issue, always printed.
 * info        a fact worth stating every time. Never opens an issue.
 */
const SEVERITY = ['fail', 'warn', 'not_checked', 'info'];

function finding(severity, id, title, detail, extra = {}) {
  return { severity, id, title, detail, ...extra };
}

/**
 * The fingerprint decides whether a warning is NEW. It must be stable across
 * nights for the same underlying problem and must change when the problem
 * changes, so it is built from the id plus whatever facts define the problem,
 * and deliberately NOT from figures that drift on their own (durations,
 * timestamps, counts of rows).
 */
export function fingerprintOf(f) {
  return `${f.id}:${f.key ?? f.title}`;
}

/* ------------------------------------------------------------------ util -- */

const tick = (msg) => console.log(`✓ ${msg}`);
const cross = (msg) => console.log(`✗ ${msg}`);
const dash = (msg) => console.log(`- ${msg}`);

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function npmJson(cwd, args) {
  // npm audit exits non zero whenever it finds anything, which is not an error.
  try {
    const out = execFileSync('npm', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, json: JSON.parse(out) };
  } catch (err) {
    const out = err?.stdout;
    if (out) {
      try { return { ok: true, json: JSON.parse(out) }; } catch { /* fall through to the error */ }
    }
    return { ok: false, error: String(err?.stderr || err?.message || 'npm failed').trim().split('\n')[0] };
  }
}

/* =========================================================================
 * 1. THE API, ASKED RATHER THAN ASSUMED
 *
 * This is the whole reason the check moved to GitHub Actions. The old one ran
 * in a sandbox whose egress proxy blocks api.florrie.ai, so it reported "API
 * health unverifiable" as a FINDING about the product when it was a fact about
 * its own container. A runner has real internet, so the question becomes
 * answerable and the entire "unverifiable" class of finding disappears.
 *
 * The shape parsed below is the one backend/src/lib/health.js actually
 * returns, read from that file rather than imagined:
 *
 *   200 { status:'ok', service, version, checked_at, duration_ms,
 *         checks:{...}, failing:[], warnings:[] }
 *   503 { status:'degraded', failing:[...], warnings:[...], checks:{...},
 *         service, checked_at }                        // note: no duration_ms
 *   503 { status:'degraded', failing:['health_check_harness'], error }
 *                                                      // note: no checks at all
 *
 * so nothing below may assume `checks` or `duration_ms` exists.
 * ========================================================================= */

/**
 * Anything that is not a health payload is not news about the product.
 *
 * The first run of this script from a sandbox proved the point: the egress
 * proxy answered HTTP 403 with an HTML page, and an earlier draft of this file
 * dutifully reported "the API process is not answering liveness". That is
 * issue #165's mistake with a different coat on. An HTTP status alone does not
 * tell you whether you reached the API or reached something standing in front
 * of it, so unless the caller has asserted that egress works, this degrades to
 * not_checked and quotes what actually came back.
 */
function notTheApi({ requireNetwork, id, title, what }) {
  return requireNetwork
    ? finding('fail', id, title,
      `${what} This ran with --require-network, so egress is expected to work and this is treated as a fault. `
      + 'If the body quoted above looks like a proxy or a WAF page rather than this API, then it is the network '
      + 'in front of the runner that is broken and not the service.')
    : finding('not_checked', id, 'the API was not reached',
      `${what} This run did not pass --require-network, so it is reported as unchecked rather than as a fault. `
      + 'A sandbox with a filtering egress proxy answers with an HTTP status of its own, which looks exactly '
      + 'like a broken API if you only read the number. The nightly workflow passes --require-network; a local '
      + 'run should not.');
}

export function judgeHealthPayload({ status, payload, body, transportError, requireNetwork }) {
  const out = [];

  if (transportError) {
    // The one place where the environment genuinely changes the answer. On a
    // runner, unreachable means DOWN. In a blocked sandbox, unreachable means
    // nothing at all, and reporting it as a fault is what issue #165 did.
    if (requireNetwork) {
      out.push(finding('fail', 'api_unreachable', 'the API did not answer',
        `GET /health failed at the transport layer: ${transportError}. `
        + 'This ran with --require-network, so egress is expected to work and the API is treated as down.'));
    } else {
      out.push(finding('not_checked', 'api_unreachable', 'the API was not reached',
        `GET /health failed at the transport layer: ${transportError}. `
        + 'This run did not pass --require-network, so it is reported as unchecked rather than as a fault. '
        + 'The nightly workflow passes --require-network; a local sandbox with blocked egress should not.'));
    }
    return out;
  }

  if (!payload || typeof payload !== 'object') {
    out.push(notTheApi({
      requireNetwork,
      id: 'api_unparseable',
      title: 'the API answered with something that is not JSON',
      what: `GET /health returned HTTP ${status} and a body that is not JSON. /health always answers JSON, `
        + `even mid outage, so whatever sent this is not this API. First 200 bytes: ${JSON.stringify((body || '').slice(0, 200))}.`,
    }));
    return out;
  }

  // The harness itself failing. health.js returns this with no `checks` key.
  if (Array.isArray(payload.failing) && payload.failing.includes('health_check_harness')) {
    out.push(finding('fail', 'api_harness', 'the health check harness itself threw',
      `HTTP ${status}. ${payload.error || 'no error given'}. `
      + 'None of the dependency checks ran, so nothing about the dependencies is known either way tonight.'));
    return out;
  }

  const checks = payload.checks && typeof payload.checks === 'object' ? payload.checks : {};

  // CRITICAL. health.js puts a check here only when result.critical is true or
  // a known critical dependency timed out. 503, and a page for BetterStack.
  for (const name of payload.failing || []) {
    const c = checks[name] || {};
    out.push(finding('fail', 'api_failing', `${name} is failing in production`,
      c.detail || `/health reports ${name} as ${c.status || 'failing'} with no detail.`,
      { key: name }));
  }

  // WARNINGS. health.js is deliberately reluctant to page for these, because
  // several of them need a human action that can take days and a monitor that
  // stays red gets muted. A nightly is exactly the right home for them: it is
  // read once, by a person, in the morning.
  for (const name of payload.warnings || []) {
    if (name === 'crons') continue; // handled below, with the job names
    const c = checks[name] || {};
    out.push(finding('warn', 'api_warning', `${name} needs a human`,
      c.detail || `/health reports ${name} as ${c.status || 'warn'} with no detail.`,
      { key: name }));
  }

  // CRONS, named individually. `warnings: ['crons']` is not actionable;
  // "the reconciliation job has not succeeded since Tuesday" is.
  const crons = checks.crons;
  if (crons && crons.status === 'unknown') {
    // The exact case #165 got wrong, from the other direction. health.js
    // returns unknown when job_runs is unreadable, which MIGHT mean migration
    // 020 was never applied. It might equally be a permissions change or a
    // typo. The honest answer is that the API said it could not tell, so
    // neither can this.
    out.push(finding('not_checked', 'crons_unknown', 'cron heartbeats were not readable',
      `/health reports crons as unknown: ${crons.detail || 'no detail'}. `
      + 'That is what the API said about its own view of job_runs. It is NOT evidence that migration 020 is '
      + 'unapplied and this check will not claim that it is. Read the migration ledger to find that out.'));
  } else if (crons && crons.jobs) {
    for (const [job, state] of Object.entries(crons.jobs)) {
      if (state.status === 'stale') {
        // Stricter than /health on purpose. health.js keeps stale crons out of
        // `failing` so BetterStack does not page every thirty seconds for days.
        // A nightly report is read once by a person, so it can afford to be
        // blunt: a cron that has stopped is a fault.
        out.push(finding('fail', 'cron_stale', `the ${job} cron has stopped`,
          `Last success ${state.last_success_at || 'never recorded'}, `
          + `${state.consecutive_failures || 0} consecutive failures`
          + (state.last_error ? `, last error: ${state.last_error}` : '')
          + '. /health grades this as a warning so that an uptime monitor does not page all night; a report '
          + 'read once in the morning does not have that constraint, so here it is a failure.',
          { key: job }));
      } else if (state.status === 'never_run') {
        out.push(finding('warn', 'cron_never_run', `the ${job} cron has never recorded a success`,
          'Normal for a few minutes after the heartbeat table is first deployed, a fault after that.',
          { key: job }));
      }
    }
  }

  if (out.length === 0) {
    out.push(finding('info', 'api_ok', 'the API is healthy',
      `HTTP ${status}, ${Object.keys(checks).length} dependency checks passed`
      + (payload.duration_ms ? ` in ${payload.duration_ms}ms` : '')
      + `. Checked: ${Object.keys(checks).join(', ') || 'none reported'}.`));
  }

  return out;
}

async function probe(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* judged by the caller */ }
    return { status: res.status, payload, body: text.slice(0, 500) };
  } catch (err) {
    const reason = err?.name === 'AbortError'
      ? `no answer within ${timeoutMs}ms`
      : (err?.cause?.message || err?.message || String(err));
    return { transportError: reason };
  } finally {
    clearTimeout(timer);
  }
}

async function checkApi({ apiUrl, requireNetwork }) {
  const out = [];

  // Liveness first. It separates "the process is gone" from "the process is up
  // and a dependency is down", which are two very different mornings.
  const live = await probe(`${apiUrl}/health/live`, 10_000);
  if (live.transportError) {
    return judgeHealthPayload({ transportError: live.transportError, requireNetwork });
  }
  if (live.status !== 200 || live.payload?.status !== 'alive') {
    out.push(notTheApi({
      requireNetwork,
      id: 'api_not_live',
      title: 'the API process is not answering liveness',
      what: `GET /health/live returned HTTP ${live.status} and ${JSON.stringify((live.body || '').slice(0, 200))} `
        + 'rather than {"status":"alive"}. Railway restarts a container whose liveness probe fails, so a '
        + 'persistent real failure here is a restart loop rather than a dependency problem.',
    }));
    // If the process is not answering, readiness cannot add anything true.
    return out;
  }

  const ready = await probe(`${apiUrl}/health`, 20_000);
  out.push(...judgeHealthPayload({
    status: ready.status,
    payload: ready.payload,
    body: ready.body,
    transportError: ready.transportError,
    requireNetwork,
  }));
  return out;
}

/* =========================================================================
 * 2. LOCKFILE PARITY
 *
 * This is a workspace root with THREE tracked lockfiles. npm maintains the
 * root one; the two workspace ones are vestigial as far as npm is concerned,
 * and they drift silently.
 *
 * That would be harmless except for DEPLOY.md line 415, which sets Vercel's
 * Root Directory to `frontend/`. Vercel therefore installs from
 * frontend/package-lock.json, while `npm audit` run from frontend/ walks UP to
 * the workspace root and reports the ROOT lock's answer. So the audit everyone
 * looks at is green about a lockfile production does not use.
 *
 * The measurement that matters is not "are the two files identical". They
 * never will be: a workspace install hoists differently, and comparing tree
 * paths produces structural false positives on this repo today (@sentry/core
 * is legitimately 10 at the root for the backend and 8 under the frontend).
 * The measurement is "does the lock production installs from carry advisories
 * the root lock does not". That has no false positives and states the risk
 * directly.
 * ========================================================================= */

function advisoryKey(name, v) {
  return `${name}@${v.range || '*'}:${v.severity}`;
}

/**
 * Audit one lockfile ON ITS OWN, by copying it and its package.json into an
 * empty directory so npm cannot walk up to the workspace root. This is the
 * only way to see what Vercel sees.
 */
function auditIsolated(pkgDir) {
  const pkg = path.join(pkgDir, 'package.json');
  const lock = path.join(pkgDir, 'package-lock.json');
  if (!existsSync(pkg) || !existsSync(lock)) return { ok: false, error: 'no package.json or package-lock.json' };

  const tmp = mkdtempSync(path.join(tmpdir(), 'nightly-audit-'));
  try {
    copyFileSync(pkg, path.join(tmp, 'package.json'));
    copyFileSync(lock, path.join(tmp, 'package-lock.json'));
    const all = npmJson(tmp, ['audit', '--json']);
    if (!all.ok) return all;
    const prod = npmJson(tmp, ['audit', '--json', '--omit=dev']);
    // npm's own resolution decides dev versus runtime. Nothing here guesses.
    const runtime = prod.ok ? new Set(Object.keys(prod.json.vulnerabilities || {})) : null;
    const advisories = {};
    for (const [name, v] of Object.entries(all.json.vulnerabilities || {})) {
      advisories[advisoryKey(name, v)] = {
        name,
        severity: v.severity,
        range: v.range,
        direct: Boolean(v.isDirect),
        // null means we could not tell, and the report says so rather than
        // quietly calling it dev only.
        runtime: runtime ? runtime.has(name) : null,
        fix: v.fixAvailable === false ? null
          : (typeof v.fixAvailable === 'object'
            ? { version: v.fixAvailable.version, major: Boolean(v.fixAvailable.isSemVerMajor) }
            : { version: null, major: false }),
      };
    }
    return { ok: true, advisories, totals: all.json.metadata?.vulnerabilities || {} };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The 19 August lesson, generalised. scripts/check-lockfile.mjs asserts the
 * platform matrix for the ROOT lock and stays the one source of that rule; it
 * is spawned verbatim below. This applies the same idea to the other tracked
 * locks, and only to locks that bundle anything, because backend has no
 * bundler and correctly has none of these entries.
 */
export function judgePlatformMatrix(lockPackages) {
  const names = new Set(Object.keys(lockPackages || {}).map((k) => k.replace(/^.*node_modules\//, '')));
  const bundles = [...names].some((n) => n.startsWith('@rollup/rollup-') || n.startsWith('@esbuild/'));
  if (!bundles) return { applicable: false, missing: [] };
  const required = ['@rollup/rollup-darwin-arm64', '@rollup/rollup-linux-x64-gnu', '@esbuild/darwin-arm64', '@esbuild/linux-x64'];
  return { applicable: true, missing: required.filter((n) => !names.has(n)) };
}

/**
 * Who actually installs from each lockfile, with the evidence, because a
 * finding that says "production ships this" has to be able to show its
 * working. Anything not listed here gets a neutral sentence rather than an
 * invented deployment story.
 */
const LOCK_CONSUMERS = {
  frontend: 'DEPLOY.md line 415 sets the Vercel Root Directory to `frontend/`, so if that is still true, Vercel '
    + 'installs from this lock and the web app and the Capacitor iOS bundle are both built from it.',
  backend: 'backend/Dockerfile copies `package*.json` and runs `npm install --omit=dev`, so Railway seeds its '
    + 'resolutions from this lock. Note that it is `npm install` and not `npm ci`, so npm is free to move any '
    + 'resolution the manifest no longer agrees with, which softens but does not remove the effect.',
};

/**
 * Does a lockfile still satisfy the package.json sitting next to it.
 *
 * npm maintains the ROOT lock of a workspace and leaves the workspace locks
 * where they were, so a dependency bumped in a workspace manifest simply never
 * reaches that workspace's own lock. It goes unnoticed because every gate uses
 * the root: CI runs `npm ci` at the root, and `npm audit` from a workspace
 * walks up to the root. Entirely offline and entirely unambiguous, which is
 * what makes it worth having.
 */
export function judgeLockSatisfiesManifest({ manifest, lock }) {
  const root = lock.packages?.[''] || {};
  const declared = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
  const inLock = { ...(root.dependencies || {}), ...(root.devDependencies || {}) };

  const problems = [];
  for (const [name, range] of Object.entries(declared)) {
    if (!(name in inLock)) {
      problems.push({ name, kind: 'missing', want: range, got: null });
      continue;
    }
    if (inLock[name] !== range) {
      const resolved = lock.packages?.[`node_modules/${name}`]?.version || null;
      problems.push({ name, kind: 'stale', want: range, got: inLock[name], resolved });
    }
  }
  return problems;
}

/**
 * Given the audits of the root lock and one workspace lock, what is the
 * workspace lock carrying that the root is not.
 */
export function judgeLockParity({ workspace, rootAdvisories, childAdvisories, versionGaps = {} }) {
  const extra = Object.entries(childAdvisories).filter(([k]) => !(k in rootAdvisories));
  if (extra.length === 0) return [];

  const runtime = extra.filter(([, a]) => a.runtime === true);
  const unknown = extra.filter(([, a]) => a.runtime === null);

  const lines = extra
    .sort((a, b) => Number(b[1].runtime === true) - Number(a[1].runtime === true))
    .map(([, a]) => {
      const gap = versionGaps[a.name];
      const where = a.runtime === true ? 'RUNTIME' : a.runtime === false ? 'dev only' : 'runtime or dev unknown';
      return `  ${a.severity.padEnd(8)} ${a.name} (${where})`
        + (gap ? `, ${workspace} has ${gap.child} and the root lock has ${gap.root}` : '');
    });

  return [finding(runtime.length ? 'fail' : 'warn', 'lock_parity',
    `${workspace}/package-lock.json carries ${extra.length} advisory(ies) the root lock does not`,
    `Auditing ${workspace}/package-lock.json on its own reports advisories that \`npm audit\` run from that `
    + 'directory does NOT show, because npm walks up to the workspace root and audits the root lock instead. '
    + 'So the audit everyone looks at is green about a lockfile it is not reading.\n'
    + (LOCK_CONSUMERS[workspace] || `Which deploy installs from ${workspace}/package-lock.json is not recorded `
      + 'anywhere this check can read, so it is not claimed here.')
    + '\n' + lines.join('\n')
    + (runtime.length
      ? `\n\n${runtime.length} of these are runtime dependencies rather than build tooling, so they are present `
        + 'in what actually runs. That is why this is a failure rather than a note.'
      : unknown.length
        ? '\n\nWhether these reach production could not be determined on this run.'
        : '\n\nAll of these are dev only, so they are a build machine risk rather than a production one.')
    + '\n\nThe cause is structural: npm does not maintain a workspace lockfile, so this one only moves when '
    + `somebody runs npm inside ${workspace}/. The durable fix is to stop having a second lockfile at all, `
    + 'which is a change to a deployment setting rather than to this repository, so it is left to a human. '
    + 'Refreshing the lock in place is the part that is safe to automate, and that is what the fix job does.',
    {
      key: extra.map(([k]) => k).sort().join(','),
      fix: { kind: 'lockfile-refresh', workspace },
    })];
}

function versionsIn(lock) {
  const out = {};
  for (const [p, entry] of Object.entries(lock.packages || {})) {
    if (!p.startsWith('node_modules/')) continue;
    const name = p.replace(/^.*node_modules\//, '');
    // The hoisted top level copy wins; nested copies are noise for this.
    if (p === `node_modules/${name}` || !(name in out)) out[name] = entry.version;
  }
  return out;
}

function checkLockfiles() {
  const out = [];
  const tracked = git('ls-files').split('\n').filter((f) => f.endsWith('package-lock.json'));

  // Reuse rather than reimplement: scripts/check-lockfile.mjs stays the one
  // source of the platform matrix rule for the root lock.
  try {
    const text = execFileSync('node', [path.join(REPO, 'scripts', 'check-lockfile.mjs')], { cwd: REPO, encoding: 'utf8' });
    out.push(finding('info', 'lock_platform_root', 'the root lockfile still installs on a Mac',
      text.trim().replace(/^✓\s*/, '')));
  } catch (err) {
    out.push(finding('fail', 'lock_platform_root', 'the root lockfile has lost its platform binaries',
      String(err?.stdout || err?.stderr || err?.message || '').trim()));
  }

  let rootLock;
  try {
    rootLock = JSON.parse(readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
  } catch (err) {
    out.push(finding('fail', 'lock_parity', 'the root lockfile could not be read', String(err?.message || err)));
    return out;
  }
  const rootVersions = versionsIn(rootLock);

  const rootAudit = auditIsolated(REPO);
  if (!rootAudit.ok) {
    out.push(finding('not_checked', 'lock_parity', 'lockfile parity was not measured',
      `The root lockfile could not be audited: ${rootAudit.error}. npm audit needs the registry, so this is `
      + 'what a blocked network looks like. It is not a statement about the lockfiles.'));
    return out;
  }

  for (const rel of tracked) {
    if (rel === 'package-lock.json') continue;
    const workspace = path.dirname(rel);
    const dir = path.join(REPO, workspace);

    let childLock;
    let childManifest;
    try {
      childLock = JSON.parse(readFileSync(path.join(REPO, rel), 'utf8'));
      childManifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch (err) {
      out.push(finding('fail', 'lock_unreadable', `${rel} could not be read`, String(err?.message || err), { key: rel }));
      continue;
    }

    // Does the lock still describe the manifest beside it. Offline, exact, and
    // the root cause of most of what the parity check would otherwise report.
    const stale = judgeLockSatisfiesManifest({ manifest: childManifest, lock: childLock });
    if (stale.length) {
      out.push(finding('fail', 'lock_manifest', `${rel} no longer describes ${workspace}/package.json`,
        stale.map((p) => (p.kind === 'missing'
          ? `  ${p.name} is declared as ${p.want} and is absent from the lock entirely`
          : `  ${p.name} is declared as ${p.want} and the lock still records ${p.got}`
            + (p.resolved ? `, resolved to ${p.resolved}` : '')))
          .join('\n')
        + '\n\nnpm maintains the ROOT lockfile of a workspace and leaves this one where it was, so a dependency '
        + `bumped in ${workspace}/package.json never reaches it. Nothing notices, because every gate reads the `
        + 'root: CI runs `npm ci` at the repository root and `npm audit` from this directory walks up to the '
        + 'root lock.\n'
        + (LOCK_CONSUMERS[workspace] || '')
        + '\n\nThe advisory parity check below is SKIPPED for this workspace, because auditing a lockfile that '
        + 'describes a dependency set nobody has asked for since would produce a long list of advisories about '
        + 'packages this project does not use any more. That is noise, and noise is the thing this whole check '
        + 'exists to stop producing.',
        { key: `${rel}:${stale.map((p) => p.name).sort().join(',')}`, fix: { kind: 'lockfile-sync', workspace } }));
    }

    const matrix = judgePlatformMatrix(childLock.packages);
    if (matrix.applicable && matrix.missing.length) {
      out.push(finding('fail', 'lock_platform', `${rel} has lost its platform binaries`,
        `Missing: ${matrix.missing.join(', ')}. This is the 19 August failure exactly: a lockfile regenerated `
        + 'inside a Linux container drops every darwin binary, CI stays green because CI is Linux, Vercel stays '
        + 'green because Vercel is Linux, and `npm ci` on a Mac dies, which takes out the iOS build. See '
        + 'scripts/check-lockfile.mjs, which asserts the same thing for the root lock.',
        { key: rel }));
    }

    if (stale.length) continue; // parity on an obsolete tree means nothing

    const childAudit = auditIsolated(dir);
    if (!childAudit.ok) {
      out.push(finding('not_checked', 'lock_parity', `${rel} was not audited`, childAudit.error, { key: rel }));
      continue;
    }

    const childVersions = versionsIn(childLock);
    const versionGaps = {};
    for (const [name, v] of Object.entries(childVersions)) {
      if (rootVersions[name] && rootVersions[name] !== v) versionGaps[name] = { child: v, root: rootVersions[name] };
    }

    const parity = judgeLockParity({
      workspace,
      rootAdvisories: rootAudit.advisories,
      childAdvisories: childAudit.advisories,
      versionGaps,
    });
    if (parity.length === 0) {
      out.push(finding('info', 'lock_parity_ok', `${rel} audits the same as the root lock`,
        `${Object.keys(childAudit.advisories).length} advisory(ies), identical set. Whichever lock a deploy `
        + 'installs from, it ships the same known advisories.',
        { key: rel }));
    }
    out.push(...parity);
  }

  return out;
}

/* =========================================================================
 * 3. NPM AUDIT, BUT ONLY WHAT CHANGED
 *
 * @capacitor/cli pulls a critical tar advisory. It is a devDependency, tar
 * cannot reach a runtime bundle, and the real fix is a Capacitor 6 to 8
 * migration that needs a Mac with Xcode 26 and a coordinated native release.
 * Printing "1 CRITICAL" every night for the months that takes is not a report,
 * it is training people to skip the report. So the state file remembers the
 * advisory set and only a CHANGE is spoken. The full set is always in the
 * body for anyone who wants it; it just does not get to raise the alarm twice.
 * ========================================================================= */

export function diffAudit(previous, current) {
  const before = previous ? new Set(Object.keys(previous)) : null;
  const added = before ? Object.entries(current).filter(([k]) => !before.has(k)) : [];
  const removed = before ? [...before].filter((k) => !(k in current)) : [];
  return { added, removed, first: previous == null };
}

function describeAdvisory([, a]) {
  const where = a.runtime === true ? 'RUNTIME' : a.runtime === false ? 'dev only' : 'runtime or dev unknown';
  const fix = a.fix == null
    ? 'no fix published'
    : a.fix.major
      ? `fix needs a MAJOR bump to ${a.fix.version}`
      : `fixable within the current range${a.fix.version ? ` (${a.fix.version})` : ''}`;
  return `  ${a.severity.padEnd(8)} ${a.name}  ${where}, ${fix}`;
}

function checkAudit(state) {
  const audit = auditIsolated(REPO);
  if (!audit.ok) {
    return {
      findings: [finding('not_checked', 'audit', 'npm audit did not run',
        `${audit.error}. npm audit needs the registry, so this is what a blocked network looks like. `
        + 'It is not a statement about the dependency tree.')],
      advisories: null,
    };
  }

  const current = audit.advisories;
  const { added, removed, first } = diffAudit(state?.audit?.root, current);
  const out = [];

  const runtimeNow = Object.entries(current).filter(([, a]) => a.runtime === true);
  const devNow = Object.entries(current).filter(([, a]) => a.runtime === false);
  const inventory = 'Current set, unchanged entries included for reference:\n'
    + Object.entries(current)
      .sort((a, b) => Number(b[1].runtime === true) - Number(a[1].runtime === true))
      .map(describeAdvisory).join('\n');

  if (first) {
    out.push(finding('info', 'audit_baseline', 'npm audit baseline recorded',
      'First run with this state file, so nothing here is new by definition and nothing opens an issue. '
      + `${Object.keys(current).length} advisory(ies): ${runtimeNow.length} runtime, ${devNow.length} dev only.\n${inventory}`));
    return { findings: out, advisories: current };
  }

  if (added.length === 0 && removed.length === 0) {
    out.push(finding('info', 'audit_unchanged', 'npm audit is unchanged since the last run',
      `${Object.keys(current).length} advisory(ies), the same set as last night: ${runtimeNow.length} runtime, `
      + `${devNow.length} dev only. Nothing new to act on.\n${inventory}`));
    return { findings: out, advisories: current };
  }

  if (added.length) {
    const reachesProduction = added.filter(([, a]) => a.runtime !== false);
    out.push(finding(reachesProduction.length ? 'fail' : 'warn', 'audit_new',
      `${added.length} new advisory(ies) since the last run`,
      added.map(describeAdvisory).join('\n')
      + (reachesProduction.length
        ? `\n\n${reachesProduction.length} of these can reach production, which is why this is a failure.`
        : '\n\nAll of these are dev only. They are a build machine supply chain risk: they run on whichever '
          + 'laptop or runner builds the app and cannot reach a runtime bundle. Real, but not a production '
          + 'vulnerability, and this report will not call it one.'),
      { key: added.map(([k]) => k).sort().join(',') }));
  }

  if (removed.length) {
    out.push(finding('info', 'audit_cleared', `${removed.length} advisory(ies) cleared since the last run`,
      removed.map((k) => `  ${k}`).join('\n')));
  }

  return { findings: out, advisories: current };
}

/* =========================================================================
 * 4. REACHABILITY, NOT IMPORTS
 *
 * Issue #165 said "no orphaned components" because it asked "is every file
 * imported". Every page IS imported: App.jsx imports all of them in order to
 * declare their routes. The question a user cares about is whether anything in
 * the app links to the page, and eleven feature pages have nothing pointing at
 * them.
 *
 * frontend/src/pages/More.jsx lines 123 to 139 already say so, in a comment
 * written by whoever parked them on 2026-06-10. The repository already knew. A
 * check that contradicts the repository's own record of a deliberate decision
 * has measured the wrong thing.
 *
 * What is deliberately NOT counted as dead:
 *   - <Navigate to=...> routes. Those are aliases, not pages.
 *   - Routes with a :param. Those are entered from a link that was sent to
 *     somebody: a booking manage token, a consultation form, a course.
 *   - Routes rendering the same element as a route that IS reachable, which is
 *     how /hub and / are one screen under two names.
 *   - Anything the marketing site or the backend links to. Those references
 *     are read from frontend/public/*.html, landing/*.html and from the
 *     `${SOMETHING_URL}/path` template literals in backend/src, which is how
 *     the Stripe return URLs and the legal pages clear without an exception
 *     being hardcoded for them.
 *   - A short, explicit list of URL only entry points that no static scan can
 *     prove, each with its reason written beside it so a reviewer can check it.
 * ========================================================================= */

/**
 * Entry points reached by a URL that exists outside this repository. Each one
 * needs a reason, and the reason is the thing a reviewer checks.
 */
export const URL_ONLY_ROUTES = new Map([
  ['/update-password', 'opened from the Supabase password recovery email. There is no in app link, by design.'],
  ['/data-deletion', 'published to Meta as the data deletion URL during app review. Required to stay live.'],
  ['/help/data-deletion', 'the second form of the data deletion URL given to Meta.'],
  ['/support', 'published as the support URL for App Store and Meta review.'],
]);

export function findRoutes(appSource) {
  // Split on the <Routes> blocks so the signed in shell can be told apart from
  // the public and logged out ones. The shell is the block whose catch all is
  // NotFound; the logged out block sends its catch all to /login and the public
  // block has no catch all at all. That is a property of what the blocks MEAN,
  // not of their order in the file, so it survives somebody moving them.
  const blocks = [...appSource.matchAll(/<Routes>([\s\S]*?)<\/Routes>/g)].map((m) => m[1]);
  const shell = blocks.find((b) => /<Route\s+path="\*"\s+element=\{<NotFound/.test(b));
  if (!shell) return { shell: null, routes: [] };
  const routes = [...shell.matchAll(/<Route\s+path="([^"]+)"([\s\S]*?)\/>/g)].map((m) => ({
    path: m[1],
    element: m[2].replace(/\s+/g, ' ').trim(),
  }));
  return { shell, routes };
}

export function findOrphanRoutes({ routes, references }) {
  const norm = (p) => p.replace(/\/+$/, '') || '/';
  const refs = new Set([...references].map(norm));

  const reachable = new Set();
  for (const r of routes) {
    const p = norm(r.path);
    if (p === '*' || p.includes(':') || p === '/') { reachable.add(p); continue; }
    if (/<Navigate\b/.test(r.element)) { reachable.add(p); continue; }
    if (refs.has(p)) reachable.add(p);
  }

  // An alias of a reachable route is reachable. /hub renders exactly what /
  // renders, so it is the same screen under a second name, not a dead page.
  const reachableElements = new Set(
    routes.filter((r) => reachable.has(norm(r.path))).map((r) => r.element),
  );

  const orphans = [];
  for (const r of routes) {
    const p = norm(r.path);
    if (reachable.has(p)) continue;
    if (reachableElements.has(r.element)) continue;
    if (URL_ONLY_ROUTES.has(p)) continue;
    orphans.push(p);
  }
  return [...new Set(orphans)].sort();
}

/** The route a page file is most likely mounted at, used to drop self references. */
export function pageRouteOf(file) {
  const m = /^frontend\/src\/pages\/([A-Za-z0-9_]+)\.jsx$/.exec(file);
  if (!m) return null;
  return '/' + m[1].replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function collectReferences() {
  const refs = new Set();
  const files = git('ls-files').split('\n').filter(Boolean);

  const addFrom = (text, patterns, into) => {
    for (const re of patterns) for (const m of text.matchAll(re)) into.add(m[1]);
  };

  // Inside the app: a link, a programmatic navigation, or a menu entry.
  const APP_PATTERNS = [
    /\bto=\{?['"`](\/[^'"`?#\s}$]*)/g,
    /\bnavigate\(\s*['"`](\/[^'"`?#\s$]*)/g,
    /\bhref=\{?['"`](\/[^'"`?#\s}$]*)/g,
    /\bpath:\s*['"`](\/[^'"`?#\s$]*)/g,
  ];
  for (const f of files) {
    if (!/^frontend\/src\/.*\.(jsx?|tsx?)$/.test(f)) continue;
    // App.jsx declares every route, so its own <Route path=...> must not count
    // as an inbound reference. Its <Navigate to=...> targets legitimately do.
    const text = readFileSync(path.join(REPO, f), 'utf8').replace(/<Route\s+path="[^"]*"/g, '<Route ');
    const found = new Set();
    addFrom(text, APP_PATTERNS, found);
    // A page that only ever links to itself is reachable from nowhere. Dropping
    // self references is why /integrations, whose only inbound links are two
    // lines inside Integrations.jsx, is seen for what it is.
    const self = pageRouteOf(f);
    for (const r of found) if (r !== self) refs.add(r);
  }

  // The marketing site is a real inbound link. This is how /privacy, /terms and
  // /signup clear without anybody hardcoding an exception for them.
  for (const f of files) {
    if (!/^(frontend\/public|landing)\/.*\.html$/.test(f)) continue;
    addFrom(readFileSync(path.join(REPO, f), 'utf8'), [/\bhref="(\/[^"?#]*)/g], refs);
  }

  // The backend hands URLs to Stripe, to Meta and into outbound messages. Only
  // paths built from a URL template count, so `/api/templates` inside a router
  // is never mistaken for a link to the /templates page.
  for (const f of files) {
    if (!/^backend\/src\/.*\.js$/.test(f)) continue;
    addFrom(readFileSync(path.join(REPO, f), 'utf8'), [/\$\{[A-Za-z_.]*[Uu][Rr][Ll][^}]*\}(\/[a-zA-Z0-9/-]*)/g], refs);
  }

  return refs;
}

function checkReachability() {
  const appPath = path.join(REPO, 'frontend/src/App.jsx');
  if (!existsSync(appPath)) {
    return [finding('not_checked', 'reachability', 'route reachability was not measured',
      'frontend/src/App.jsx is missing.')];
  }
  const { shell, routes } = findRoutes(readFileSync(appPath, 'utf8'));
  if (!shell) {
    return [finding('not_checked', 'reachability', 'route reachability was not measured',
      'Could not find the signed in <Routes> block in App.jsx, the one whose catch all renders <NotFound />. '
      + 'The router has probably been restructured, so this check needs updating rather than believing.')];
  }

  const orphans = findOrphanRoutes({ routes, references: collectReferences() });
  if (orphans.length === 0) {
    return [finding('info', 'reachability', 'every page in the signed in app is reachable',
      `${routes.length} routes, all reachable by a link, a redirect, a sent URL or a documented external entry point.`)];
  }

  // A warning and not a failure, on purpose. Parking a page was a decision
  // somebody made and wrote down; the fault is only that the decision is
  // invisible unless you happen to read More.jsx. Failing a nightly over it
  // would be #165's mistake in the opposite direction.
  return [finding('warn', 'reachability', `${orphans.length} pages have no inbound link`,
    'These routes exist and render, and nothing in the app, on the marketing site, or in any URL the backend '
    + 'hands out points at them. They are reachable by typing the URL and by nothing else.\n'
    + orphans.map((p) => `  ${p}`).join('\n')
    + '\n\nfrontend/src/pages/More.jsx lines 123 to 139 already record most of these as parked on 2026-06-10, '
    + 'so this is agreement with the repository rather than a discovery. Either delete them or give them a line '
    + 'in the More menu.\n\n'
    + 'This is measured as REACHABILITY (inbound to=, navigate(, href=) and not as "is the file imported", '
    + 'because App.jsx imports every page in order to declare its route, which is exactly why an import graph '
    + 'reports zero orphans here and is wrong.',
    { key: orphans.join(',') })];
}

/* =========================================================================
 * 5. THE REPOSITORY IS PUBLIC
 *
 * github.com/LDP777/florrie-ai. Issue #165 never mentioned it, which is its
 * largest omission: every fact about this codebase is downloadable by anybody,
 * including by whoever left the comment that check treated as ordinary. So the
 * report states it at the top every night, and the scan below exists because
 * of it.
 *
 * The scan is deliberately narrow. frontend/.env.production is TRACKED and
 * contains a live Stripe PUBLISHABLE key, a Supabase ANON key and a Sentry
 * DSN, all public by design and documented as such in the file itself. A
 * scanner that flags those is a scanner that gets muted within a week. So this
 * matches only shapes that are secret by definition, and it decides JWTs by
 * decoding the payload and reading the role rather than by matching `eyJ`.
 * ========================================================================= */

const SECRET_PATTERNS = [
  [/\bsk_live_[A-Za-z0-9]{20,}/, 'a Stripe SECRET key (sk_live_)'],
  [/\bsk_test_[A-Za-z0-9]{20,}/, 'a Stripe test secret key (sk_test_)'],
  [/\brk_live_[A-Za-z0-9]{20,}/, 'a Stripe restricted key (rk_live_)'],
  [/\bwhsec_[A-Za-z0-9]{20,}/, 'a Stripe webhook signing secret'],
  [/\bsbp_[a-f0-9]{40,}/, 'a Supabase personal access token'],
  [/\bghp_[A-Za-z0-9]{36}/, 'a GitHub personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}/, 'a GitHub fine grained token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'a private key'],
  [/\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, 'a SendGrid API key'],
];

/**
 * A Supabase service role key is a JWT whose payload says so. Decode it and
 * read the role; do not guess from the prefix. An anon key has the same shape
 * and is public by design, so a prefix match would fire on every deploy doc in
 * the repository and teach everybody to ignore this check.
 */
export function findServiceRoleJwt(text) {
  const roles = [];
  for (const m of text.matchAll(/\beyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{20,})\.[A-Za-z0-9_-]{10,}/g)) {
    try {
      const payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
      if (payload && typeof payload.role === 'string' && payload.role !== 'anon') roles.push(payload.role);
    } catch { /* not a JWT we can read, so not a claim we can make */ }
  }
  return [...new Set(roles)];
}

function checkPublicRepo() {
  const out = [];
  const visibility = process.env.REPO_VISIBILITY || null;

  if (!visibility) {
    out.push(finding('not_checked', 'repo_visibility', 'repository visibility was not confirmed',
      'REPO_VISIBILITY was not set. The workflow passes it straight from the GitHub event, so the check never '
      + 'has to call an API or guess. The scan below runs anyway, because assuming public is the safe way to be '
      + 'wrong about this.'));
  } else {
    out.push(finding('info', 'repo_visibility', `this repository is ${visibility.toUpperCase()}`,
      visibility === 'public'
        ? 'Everything tracked here is downloadable by anybody: the schema, the incident write ups in docs/, the '
          + 'client names in the test fixtures, and every commit message. That is the single largest fact about '
          + 'this repository and it belongs at the top of every report rather than in a footnote.'
        : 'Only collaborators can read it.'));
  }

  const files = git('ls-files').split('\n').filter(Boolean);
  const hits = [];
  for (const f of files) {
    const full = path.join(REPO, f);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
    let text;
    try { text = readFileSync(full, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue; // binary, and not worth decoding
    for (const [re, what] of SECRET_PATTERNS) {
      if (re.test(text)) hits.push({ file: f, what });
    }
    for (const role of findServiceRoleJwt(text)) {
      hits.push({ file: f, what: `a Supabase JWT with role "${role}"` });
    }
  }

  if (hits.length === 0) {
    out.push(finding('info', 'tracked_secrets', 'no secret shaped strings in tracked files',
      `${files.length} tracked files scanned. Note what this does NOT do: it reads the current tree only and not `
      + 'history, so a key committed and later removed is still in every clone anybody made. It also passes '
      + 'frontend/.env.production deliberately, because the keys in it are a Stripe PUBLISHABLE key, a Supabase '
      + 'ANON key and a Sentry DSN, which are public by design and documented as such in that file. Flagging '
      + 'those is how a scanner gets ignored.'));
  } else {
    out.push(finding('fail', 'tracked_secrets', `${hits.length} secret shaped string(s) in tracked files`,
      hits.map((h) => `  ${h.file}: ${h.what}`).join('\n')
      + '\n\nThis repository is public. Rotate first and remove second: the value is already in every clone and '
      + 'in the GitHub API cache, so deleting the line does not un-leak it.',
      { key: hits.map((h) => `${h.file}:${h.what}`).sort().join(',') }));
  }

  return out;
}

/* =========================================================================
 * 6. THE MIGRATION LEDGER
 *
 * `schema_migrations` is keyed on filename and was itself created late, by
 * supabase/migrations/20260802_schema_migrations.sql, so files applied by hand
 * before that date may have no row. That makes "pending" ambiguous, and it is
 * the reason this check is careful about what it claims.
 *
 * HOW THIS GETS DATABASE ACCESS SAFELY, which is the part worth arguing about:
 *
 *   - A dedicated Postgres role that can do exactly one thing:
 *       CREATE ROLE nightly_check LOGIN PASSWORD '...';
 *       GRANT CONNECT ON DATABASE postgres TO nightly_check;
 *       GRANT USAGE ON SCHEMA public TO nightly_check;
 *       GRANT SELECT ON public.schema_migrations TO nightly_check;
 *     Nothing else. Not the service role key, not the postgres superuser, and
 *     nothing that can read a single client record.
 *   - The connection string lives in a GitHub Actions SECRET named
 *     NIGHTLY_DATABASE_URL. It is never written into this repository, which is
 *     public, and Actions does not expose secrets to runs triggered from a
 *     fork.
 *   - Use the POOLER host on port 6543. The direct host on 5432 needs the IPv4
 *     add on to be reachable from a GitHub runner. A transaction mode pooler is
 *     unsuitable for the migration RUNNER, which needs real transactions for
 *     DDL, but it is entirely fine for one SELECT.
 *   - This reads and never writes. That is why it does not simply spawn
 *     `node backend/scripts/migrate.js status`, which would have been the
 *     obvious reuse: that command calls CREATE TABLE IF NOT EXISTS on the
 *     ledger before reading it, and an unattended nightly job should not hold a
 *     credential that can execute DDL against production. Twenty duplicated
 *     lines are a fair price for a read only credential.
 *   - Without the secret this returns not_checked and says exactly this. It
 *     never infers migration state from source code. That is rule one.
 * ========================================================================= */

const LEDGER_CREATED_BY = '20260802_schema_migrations.sql';

export function judgeLedger({ files, ledger }) {
  const out = [];
  const byName = new Map(ledger.map((r) => [r.name, r]));

  const pending = files.filter((f) => !byName.has(f.name));
  const changed = files.filter((f) => byName.has(f.name) && byName.get(f.name).checksum !== f.checksum);
  const orphans = ledger.filter((r) => !files.some((f) => f.name === r.name));

  if (changed.length) {
    // Unambiguous. A row exists, so the file definitely ran, and the bytes on
    // disk are no longer the bytes that ran.
    out.push(finding('fail', 'migration_edited', `${changed.length} applied migration(s) have been edited since they ran`,
      changed.map((f) => `  ${f.name}`).join('\n')
      + '\n\nThe database has the OLD version and will never pick the change up, because the runner skips any '
      + 'file already in the ledger. Write a new migration instead of editing an old one.',
      { key: changed.map((f) => f.name).sort().join(',') }));
  }

  if (pending.length) {
    // Ambiguous, and the check says so rather than picking the scarier reading.
    const preLedger = pending.filter((f) => f.name < LEDGER_CREATED_BY);
    out.push(finding('warn', 'migration_pending', `${pending.length} migration file(s) are not in the ledger`,
      pending.map((f) => `  ${f.name}${f.name < LEDGER_CREATED_BY ? '   (predates the ledger)' : ''}`).join('\n')
      + '\n\nThis is a WARNING and not a failure, because the ledger cannot distinguish the two possible causes. '
      + `schema_migrations was itself created by ${LEDGER_CREATED_BY}, and everything before that was pasted into `
      + 'the Supabase SQL editor by hand, so a file with no row may have been applied months ago or may never '
      + `have run. ${preLedger.length} of these ${pending.length} predate the ledger and are probably the former.`
      + '\n\nTo make this answer trustworthy, run `node backend/scripts/migrate.js baseline --yes` once against '
      + 'production. It records every file currently on disk as applied WITHOUT executing any of it, after which '
      + 'a pending file genuinely means an unapplied file and this check can be promoted to a failure.',
      { key: pending.map((f) => f.name).sort().join(',') }));
  }

  if (orphans.length) {
    out.push(finding('warn', 'migration_orphan', `${orphans.length} ledger row(s) have no file on disk`,
      orphans.map((r) => `  ${r.name}`).join('\n')
      + '\n\nSomebody deleted a migration after it ran. Harmless to the database, but the repository no longer '
      + 'records what production actually has.',
      { key: orphans.map((r) => r.name).sort().join(',') }));
  }

  if (out.length === 0) {
    out.push(finding('info', 'migration_ledger', 'the migration ledger matches the files on disk',
      `${files.length} files, ${ledger.length} ledger rows, every checksum matches.`));
  }
  return out;
}

async function checkMigrations() {
  const url = process.env.NIGHTLY_DATABASE_URL;
  const dir = path.join(REPO, 'supabase/migrations');

  const files = [];
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
    for (const name of names) {
      const sql = await readFile(path.join(dir, name), 'utf8');
      files.push({ name, checksum: createHash('sha256').update(sql, 'utf8').digest('hex') });
    }
  } catch (err) {
    return [finding('not_checked', 'migration_ledger', 'the migration files could not be read',
      String(err?.message || err))];
  }

  if (!url) {
    return [finding('not_checked', 'migration_ledger', 'the migration ledger was not read',
      `${files.length} migration files are on disk. Whether production has applied them is a question about a `
      + 'database, this run had no database credential, so it is NOT answered here and nothing else in this '
      + 'report should be read as an answer to it.\n\n'
      + 'To turn this into a real check, create a read only role and put its connection string in a GitHub '
      + 'Actions secret named NIGHTLY_DATABASE_URL:\n\n'
      + "  CREATE ROLE nightly_check LOGIN PASSWORD '...';\n"
      + '  GRANT CONNECT ON DATABASE postgres TO nightly_check;\n'
      + '  GRANT USAGE ON SCHEMA public TO nightly_check;\n'
      + '  GRANT SELECT ON public.schema_migrations TO nightly_check;\n\n'
      + 'Use the POOLER host on port 6543, which is reachable over IPv4 from a GitHub runner. That role can read '
      + 'one table and nothing else, so the worst case if the secret ever leaks is that somebody learns which '
      + 'migrations ran. See docs/NIGHTLY_CHECK.md.')];
  }

  let pg;
  try {
    ({ default: pg } = await import('pg'));
  } catch {
    return [finding('not_checked', 'migration_ledger', 'the migration ledger was not read',
      'NIGHTLY_DATABASE_URL is set but the `pg` package is not installed. It is a devDependency of the '
      + 'repository root, so run `npm ci` at the root first.')];
  }

  const client = new pg.Client({
    connectionString: url,
    // Supabase terminates TLS with its own chain, the same reason every
    // Supabase client in this repository does this. The connection is still
    // encrypted.
    ssl: { rejectUnauthorized: false },
    statement_timeout: 15_000,
    connectionTimeoutMillis: 15_000,
  });
  try {
    await client.connect();
    // Read only, deliberately. No CREATE TABLE IF NOT EXISTS, so this works
    // with a role that has SELECT on one table and nothing more.
    const { rows } = await client.query('SELECT name, checksum, applied_at, applied_by FROM schema_migrations');
    return judgeLedger({ files, ledger: rows });
  } catch (err) {
    const msg = String(err?.message || err);
    if (/schema_migrations.*does not exist/i.test(msg)) {
      return [finding('warn', 'migration_ledger', 'production has no schema_migrations table',
        'The ledger does not exist in this database, so there is no record of what has been applied. Run '
        + '`node backend/scripts/migrate.js baseline --yes` once to create it and record the current state.')];
    }
    return [finding('not_checked', 'migration_ledger', 'the migration ledger was not read',
      `Connecting to the database failed: ${msg}. That is a fact about this run, not about the schema.`)];
  } finally {
    try { await client.end(); } catch { /* nothing useful to do about it */ }
  }
}

/* =========================================================================
 * 7. THE GUARDS THAT ALREADY EXIST
 *
 * frontend/scripts has twenty check-*.mjs guards, each written after a real
 * incident. Reimplementing any of them here would be worse than useless. So
 * this does two other things: it proves every guard is still wired to
 * something that runs it, and the workflow runs the ones no other gate runs.
 *
 * check:boot is the case in point. It measures first contentful paint over a
 * throttled connection against the real dist, and NOTHING RUNS IT: not
 * `npm run build`, not ci.yml. A guard nobody runs is a guard that rots. A
 * nightly is the right home for it, because it needs a browser and a built
 * dist and it does not need to block a push.
 * ========================================================================= */

function checkGuardWiring() {
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'frontend/package.json'), 'utf8'));
  const scripts = pkg.scripts || {};
  const guardFiles = git('ls-files', 'frontend/scripts').split('\n').filter((f) => /\/check-[a-z-]+\.mjs$/.test(f));

  const wired = new Set();
  for (const body of Object.values(scripts)) {
    for (const m of String(body).matchAll(/scripts\/(check-[a-z-]+\.mjs)/g)) wired.add(m[1]);
  }
  const unwired = guardFiles.map((f) => path.basename(f)).filter((b) => !wired.has(b));

  const out = [];
  if (unwired.length) {
    out.push(finding('warn', 'guard_unwired', `${unwired.length} guard(s) have no npm script`,
      unwired.map((b) => `  frontend/scripts/${b}`).join('\n')
      + '\n\nA guard with no way to run it is a guard that rots.',
      { key: unwired.sort().join(',') }));
  }

  // Which guards are actually EXECUTED by a gate, as opposed to merely having a
  // script name. `npm run build` runs one set, ci.yml runs another.
  const buildRuns = new Set([...String(scripts.build || '').matchAll(/run (check:[a-z:-]+)/g)].map((m) => m[1]));

  // Read the workflows for STEPS, not for prose. ci.yml's comments mention
  // `npm run check:contrast:dark` while explaining why CI deliberately does
  // not run it, and an earlier draft of this counted that as evidence the
  // guard was wired. Believing a comment about what runs is the exact mistake
  // this whole file exists to stop making, so comments are stripped first.
  const runsIn = (file) => {
    const p = path.join(REPO, '.github/workflows', file);
    if (!existsSync(p)) return [];
    const steps = readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l));
    return [...steps.join('\n').matchAll(/npm run (check:[a-z:-]+)/g)].map((m) => m[1]);
  };
  const ciRuns = new Set([...runsIn('ci.yml'), ...runsIn('nightly-check.yml')]);
  const nightlyRuns = new Set();

  const ungated = Object.keys(scripts)
    .filter((s) => s.startsWith('check:'))
    .filter((s) => !buildRuns.has(s) && !ciRuns.has(s) && !nightlyRuns.has(s));

  if (ungated.length) {
    out.push(finding('info', 'guard_ungated', `${ungated.length} guard script(s) are run by no gate`,
      ungated.map((s) => `  npm run ${s} --workspace frontend`).join('\n')
      + '\n\nInformational rather than a fault. check:contrast:dark is deliberately excluded from CI because '
      + 'dark mode fails on 64 nodes and is unreachable in the app, and ci.yml says so in as many words. If any '
      + 'of the others matter, they belong in this nightly, which is the one place where a slow guard costs '
      + 'nobody anything.',
      { key: ungated.sort().join(',') }));
  }

  if (out.length === 0) {
    out.push(finding('info', 'guard_wiring', `all ${guardFiles.length} guards are wired to a gate`, ''));
  }
  return out;
}

/**
 * Boot cost, read from the guard's own output rather than remeasured here.
 * Tolerant on purpose: if the format changes this says "not checked" and the
 * report stays truthful instead of inventing a number.
 */
export function judgeBoot({ text, previous }) {
  if (!text) {
    return [finding('not_checked', 'boot', 'boot cost was not measured',
      'No BOOT_REPORT was captured. The nightly workflow runs `npm run check:boot --workspace frontend` after '
      + 'the build and points BOOT_REPORT at its output. A local run without a built dist and a browser skips '
      + 'it, which is correct.')];
  }
  const fcp = /first contentful paint\s+(\d+)\s*ms/.exec(text);
  const js = /javascript before paint\s+(\d+)\s*KB/.exec(text);
  if (!fcp || !js) {
    return [finding('not_checked', 'boot', 'boot cost was not measured',
      'BOOT_REPORT was captured but neither "first contentful paint" nor "javascript before paint" could be '
      + 'read out of it. frontend/scripts/check-boot.mjs has probably changed its output, so this check needs '
      + 'updating rather than guessing.')];
  }
  const now = { fcp_ms: Number(fcp[1]), js_before_paint_kb: Number(js[1]) };

  if (!previous) {
    return [finding('info', 'boot', 'boot cost baseline recorded',
      `First contentful paint ${now.fcp_ms}ms, ${now.js_before_paint_kb}KB of JavaScript before paint, on a `
      + 'throttled 4G phone. Nothing to compare against yet.'), now];
  }

  const growth = now.js_before_paint_kb - previous.js_before_paint_kb;
  const pct = previous.js_before_paint_kb ? (growth / previous.js_before_paint_kb) * 100 : 0;

  if (pct > 15) {
    return [finding('warn', 'boot', 'the app got meaningfully heavier to start',
      `JavaScript before first paint went from ${previous.js_before_paint_kb}KB to ${now.js_before_paint_kb}KB, `
      + `up ${Math.round(pct)}%. First contentful paint went ${previous.fcp_ms}ms to ${now.fcp_ms}ms on a `
      + 'throttled 4G phone. Something new is being loaded before anything is shown; look for what moved out of '
      + 'a lazy chunk. Ellie opens this between clients on mobile data, dozens of times a day.',
      { key: `${previous.js_before_paint_kb}->${now.js_before_paint_kb}` }), now];
  }

  return [finding('info', 'boot', 'boot cost is stable',
    `First contentful paint ${now.fcp_ms}ms, ${now.js_before_paint_kb}KB before paint `
    + `(was ${previous.js_before_paint_kb}KB, ${growth >= 0 ? '+' : ''}${growth}KB).`), now];
}

/* =========================================================================
 * 8. THE GATES THE WORKFLOW RAN
 *
 * The frontend build and the backend suite are the real regression gates and
 * they run as their own workflow steps, so their result arrives here in an
 * environment variable rather than being re-run. Re-running them inside this
 * script would double a five minute job for no new information.
 * ========================================================================= */

function checkSuites() {
  const out = [];
  const suites = Object.entries(process.env)
    .filter(([k]) => k.startsWith('SUITE_'))
    .map(([k, v]) => [k.slice('SUITE_'.length).toLowerCase().replace(/_/g, ' '), v]);

  if (suites.length === 0) {
    return [finding('not_checked', 'suites', 'the build and test gates were not run by this process',
      'No SUITE_* variables were set. The nightly workflow runs `npm run build --workspace frontend` and '
      + '`npm test --workspace backend` as their own steps and passes their outcome in. Run them yourself if '
      + 'you are running this script by hand.')];
  }
  for (const [name, result] of suites) {
    if (result === 'success') {
      out.push(finding('info', 'suite', `${name} passed`, ''));
    } else if (result === 'skipped' || result === 'cancelled') {
      out.push(finding('not_checked', 'suite', `${name} did not run`, `Outcome: ${result}.`, { key: name }));
    } else {
      out.push(finding('fail', 'suite', `${name} failed`,
        `Outcome: ${result}. This is a regression gate, so it is the finding that matters most in tonight's run. `
        + 'The step log in the workflow run has the actual failure.',
        { key: name }));
    }
  }
  return out;
}

/* =========================================================================
 * THE FIX
 *
 * What is safe to change without a human and what is not, decided once and
 * written down here so that it does not get decided again at three in the
 * morning by whoever happens to be looking.
 *
 * SAFE, and applied:
 *   Refreshing a workspace lockfile that carries advisories the root lock does
 *   not. `npm update --package-lock-only` moves resolutions WITHIN the semver
 *   ranges already in package.json. No manifest change, no major bump, no new
 *   dependency, no application code. On this repository it takes
 *   frontend/package-lock.json from 11 advisories to 4, matching the root lock
 *   exactly, and the entire diff is one lockfile. Every claim is then proved
 *   before anything is proposed: the platform matrix, the parity re-measured,
 *   the full frontend build and the whole backend suite.
 *
 * NOT SAFE, and never applied:
 *   - A MAJOR version bump. `npm audit fix --force` would take @capacitor/cli
 *     from 6 to 8, which is a native migration needing a Mac with Xcode 26 and
 *     a coordinated iOS release. A green unit suite would prove nothing at all
 *     about it, which is the worst possible combination: a confident PR that
 *     the thing verifying it cannot actually verify.
 *   - Anything touching supabase/migrations or the ledger. Applying DDL to
 *     production unattended is how you discover that your rollback plan was a
 *     sentence in a document.
 *   - Anything that sends a message. There is a real person at the other end
 *     of every WhatsApp, SMS and email this codebase can emit.
 *   - Deleting an unreachable page. "Nothing links to it" is not "nobody wants
 *     it", and More.jsx explicitly records these as parked and kept.
 *
 * AND IT NEVER PUSHES TO MAIN. The fix goes on a branch and becomes a pull
 * request with the passing suite attached. A push to main here is a full ship:
 * Vercel deploys the frontend, Railway deploys the backend, Xcode Cloud builds
 * to TestFlight. Nothing lands unattended.
 * ========================================================================= */

/**
 * The two safe remedies, and the npm invocation each one is.
 *
 *   lockfile-sync    the lock no longer describes its own package.json.
 *                    `npm install --package-lock-only` reconciles it to the
 *                    manifest that is already committed. It resolves the
 *                    ranges somebody already reviewed; it does not choose new
 *                    ones.
 *   lockfile-refresh the lock describes the manifest but has fallen behind on
 *                    patch and minor releases. `npm update --package-lock-only`
 *                    moves resolutions WITHIN those same ranges.
 *
 * Both are lockfile only. Neither edits a package.json, so neither can perform
 * a major bump, which is the line between what a machine may do here and what
 * it may not.
 */
const LOCK_ONLY = ['--package-lock-only', '--ignore-scripts', '--workspaces=false'];
const FIX_COMMANDS = {
  // install reconciles the lock with the manifest but PRESERVES any resolution
  // that already satisfies its range, so a lock that was both out of step with
  // its manifest and behind on patches needs both, in this order.
  'lockfile-sync': [['install', ...LOCK_ONLY], ['update', ...LOCK_ONLY]],
  'lockfile-refresh': [['update', ...LOCK_ONLY]],
};

function applyFixes(findings) {
  const applied = [];
  // A lock that does not describe its manifest must be reconciled before it is
  // worth updating, so sync wins where a workspace has both findings.
  const plan = new Map();
  for (const f of findings) {
    if (!f.fix || !(f.fix.kind in FIX_COMMANDS)) continue;
    const current = plan.get(f.fix.workspace);
    if (!current || f.fix.kind === 'lockfile-sync') plan.set(f.fix.workspace, f.fix.kind);
  }

  for (const [ws, kind] of plan) {
    const dir = path.join(REPO, ws);
    const lock = path.join(dir, 'package-lock.json');
    const before = readFileSync(lock, 'utf8');
    try {
      // --workspaces=false stops npm walking up and rewriting the ROOT lock
      // instead, which would be a much larger diff than the one asked for.
      // --ignore-scripts because a lockfile change must never be the thing
      // that executes somebody's postinstall.
      for (const args of FIX_COMMANDS[kind]) {
        execFileSync('npm', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      }
    } catch (err) {
      applied.push({ workspace: ws, kind, ok: false, detail: `npm ${kind} failed: ${String(err?.stderr || err?.message).split('\n')[0]}` });
      continue;
    }

    const after = readFileSync(lock, 'utf8');
    if (after === before) {
      applied.push({
        workspace: ws,
        kind,
        ok: false,
        detail: `npm ${kind} changed nothing, so the gap is not resolvable inside the semver ranges that are `
          + 'already committed. It needs a human to decide on a major bump.',
      });
      continue;
    }

    // Prove it, do not assume it. Same rule as everything else in this file.
    // A lockfile regenerated inside a Linux container is exactly how the
    // darwin binaries went missing on 19 August, so this is checked before the
    // change is allowed to survive.
    const matrix = judgePlatformMatrix(JSON.parse(after).packages);
    if (matrix.applicable && matrix.missing.length) {
      writeFileSync(lock, before);
      applied.push({ workspace: ws, kind, ok: false, detail: `reverted: it dropped ${matrix.missing.join(', ')}` });
      continue;
    }

    // And it must still describe its own manifest afterwards.
    const stillStale = judgeLockSatisfiesManifest({
      manifest: JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')),
      lock: JSON.parse(after),
    });
    if (stillStale.length) {
      writeFileSync(lock, before);
      applied.push({
        workspace: ws,
        kind,
        ok: false,
        detail: `reverted: afterwards the lock still did not describe package.json (${stillStale.map((p) => p.name).join(', ')})`,
      });
      continue;
    }

    const root = auditIsolated(REPO);
    const child = auditIsolated(dir);
    if (!root.ok || !child.ok) {
      applied.push({
        workspace: ws,
        kind,
        ok: true,
        file: `${ws}/package-lock.json`,
        detail: `${kind} applied, but advisory parity could not be re-measured because npm audit could not reach the registry`,
      });
      continue;
    }
    const stillExtra = Object.keys(child.advisories).filter((k) => !(k in root.advisories));
    applied.push({
      workspace: ws,
      kind,
      ok: true,
      file: `${ws}/package-lock.json`,
      detail: stillExtra.length
        ? `${kind} applied; ${stillExtra.length} advisory(ies) still exceed the root lock and need a human: ${stillExtra.join(', ')}`
        : `${kind} applied; ${Object.keys(child.advisories).length} advisory(ies), none that the root lock does not also carry`,
    });
  }
  return applied;
}

/* ---------------------------------------------------------------- speak -- */

/**
 * When to open an issue, when to say nothing, and when to close.
 *
 * A nightly issue that is mostly green teaches everybody to skip the nightly
 * issue, and then the one night it matters it gets skipped too.
 */
export function decideSpeech({ findings, previousFingerprints }) {
  const before = new Set(previousFingerprints || []);
  const fails = findings.filter((f) => f.severity === 'fail');
  const warns = findings.filter((f) => f.severity === 'warn');
  const newWarns = warns.filter((f) => !before.has(fingerprintOf(f)));

  return {
    // Post: something is broken, or something is newly wrong.
    speak: fails.length > 0 || newWarns.length > 0,
    // Keep an existing issue open while anything is still outstanding, without
    // posting about it again.
    keepOpen: fails.length > 0 || warns.length > 0,
    // Close only when it is genuinely all clear.
    close: fails.length === 0 && warns.length === 0,
    fails: fails.length,
    warns: warns.length,
    newWarns: newWarns.length,
  };
}

const HEADINGS = {
  fail: 'Failing',
  warn: 'Warnings',
  not_checked: 'Not checked, and why',
  info: 'For the record',
};

const LABELS = {
  fail: 'FAILING',
  warn: 'WARNING',
  not_checked: 'NOT CHECKED',
  info: 'NOTE',
};

export function renderIssue({ findings, speech, runUrl }) {
  const parts = [];
  parts.push(speech.fails
    ? `${speech.fails} failing, ${speech.warns} warning(s).`
    : `${speech.newWarns} new warning(s), nothing failing.`);
  parts.push('');
  for (const s of SEVERITY) {
    const items = findings.filter((f) => f.severity === s);
    if (!items.length) continue;
    parts.push(`## ${HEADINGS[s]}`);
    parts.push('');
    for (const f of items) parts.push(`### ${LABELS[s]}: ${f.title}\n\n${f.detail || '(no detail)'}\n`);
  }
  parts.push('---');
  parts.push('');
  parts.push('Every line above was measured. Nothing here is inferred from a code comment: anything this check');
  parts.push('could not verify is under "Not checked, and why" with the reason, because a false alarm costs more');
  parts.push('than a gap does. See `docs/NIGHTLY_CHECK.md`.');
  if (runUrl) parts.push(`\nRun: ${runUrl}`);
  return parts.join('\n');
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  const statePath = valueOf('--state');
  let state = null;
  if (statePath && existsSync(statePath)) {
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { state = null; }
  }

  if (has('--fix')) {
    // A fix run re-measures what it needs in order to decide, so it never has
    // to trust a report file written by another process.
    const applied = applyFixes(checkLockfiles());
    if (applied.length === 0) dash('nothing to fix: no finding carries a safe automatic remedy');
    for (const a of applied) (a.ok ? tick : cross)(`fix ${a.workspace}: ${a.detail}`);
    const out = valueOf('--json');
    if (out) writeFileSync(out, JSON.stringify({ applied, changed: applied.filter((a) => a.ok).map((a) => a.file) }, null, 2));
    process.exit(applied.length && !applied.some((a) => a.ok) ? 1 : 0);
  }

  console.log('nightly check\n');

  const findings = [];
  const nextState = { version: 1, updated_at: new Date().toISOString(), audit: {}, fingerprints: [], boot: null };

  findings.push(...checkPublicRepo());
  findings.push(...checkSuites());
  findings.push(...await checkApi({
    apiUrl: (process.env.NIGHTLY_API_URL || 'https://api.florrie.ai').replace(/\/+$/, ''),
    requireNetwork: has('--require-network'),
  }));
  findings.push(...await checkMigrations());
  findings.push(...checkLockfiles());

  const audit = checkAudit(state);
  findings.push(...audit.findings);
  if (audit.advisories) nextState.audit = { root: audit.advisories };

  findings.push(...checkReachability());
  findings.push(...checkGuardWiring());

  const bootPath = process.env.BOOT_REPORT;
  const bootText = bootPath && existsSync(bootPath) ? readFileSync(bootPath, 'utf8') : null;
  const [bootFinding, bootNow] = judgeBoot({ text: bootText, previous: state?.boot });
  findings.push(bootFinding);
  nextState.boot = bootNow || state?.boot || null;

  // Printed in severity order, in the style of the frontend guards.
  for (const s of SEVERITY) {
    for (const f of findings.filter((x) => x.severity === s)) {
      const line = `${f.id}: ${f.title}`;
      if (s === 'info') tick(line);
      else if (s === 'not_checked') dash(`${line} (not checked)`);
      else cross(line);
      if (f.detail && s !== 'info') for (const l of f.detail.split('\n')) console.log(`    ${l}`);
    }
  }

  const speech = decideSpeech({ findings, previousFingerprints: state?.fingerprints });
  nextState.fingerprints = findings
    .filter((f) => f.severity === 'fail' || f.severity === 'warn')
    .map(fingerprintOf);

  console.log('');
  console.log(`${speech.fails} failing, ${speech.warns} warning(s) of which ${speech.newWarns} new, `
    + `${findings.filter((f) => f.severity === 'not_checked').length} not checked.`);
  console.log(speech.speak
    ? '-> there is something to say, so an issue will be opened or updated'
    : speech.close
      ? '-> all clear, so any open nightly issue will be closed'
      : '-> nothing new, so this stays quiet and any open issue is left exactly as it is');

  if (statePath) writeFileSync(statePath, JSON.stringify(nextState, null, 2));

  const jsonPath = valueOf('--json');
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({
      generated_at: nextState.updated_at,
      findings,
      speech,
      issue_body: renderIssue({ findings, speech, runUrl: process.env.RUN_URL || null }),
      fixable: findings.filter((f) => f.fix).map((f) => ({ id: f.id, title: f.title, fix: f.fix })),
    }, null, 2));
  }

  if (has('--no-exit-code')) process.exit(0);
  process.exit(speech.fails > 0 ? 1 : 0);
}

// Only runs when invoked directly, so that the judgement functions above can be
// imported by backend/tests/unit without any of this executing.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('✗ nightly check: the check itself threw, which is a bug in the check and not a finding about the product');
    console.error(err?.stack || err);
    process.exit(2);
  });
}
