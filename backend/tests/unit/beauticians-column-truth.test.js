/**
 * A RATCHET FOR THE WHOLE BUG CLASS: SELECTING A beauticians COLUMN THAT DOES
 * NOT EXIST.
 *
 * PostgREST rejects the WHOLE select when one column in it is unknown, and it
 * reports that by RESOLVING with { data: null, error }, not by throwing. So a
 * select naming one column nobody created is indistinguishable, at a call site
 * that does not read `error`, from "there is nothing there". Six of these were
 * live on the beauticians table on 31 August 2026, and the most expensive was
 * notification_prefs: shouldPush read it, got null, fell into its fail-open
 * catch on every push, and the Settings toggles the owner had been setting for
 * months did nothing at all.
 *
 * So this walks supabase/migrations for every column beauticians is ever given,
 * walks backend/src for every column it is ever asked for, and refuses the
 * difference. Same shape as the source scan in
 * consent-columns-cannot-be-dropped.test.js: a wide net with a baseline that
 * can only get shorter.
 *
 * WHAT THIS TEST CANNOT SEE, AND IT MATTERS.
 *
 * It compares code against the MIGRATIONS FOLDER, which is not the same thing
 * as the live database. Migrations here are applied BY HAND, so a migration can
 * be written, committed, and never run. That is exactly what happened to all
 * six of the columns above: every one of them is created by a migration in this
 * folder, and none of them existed in production.
 *
 *   notification_prefs        002, partly applied (client_reminder_prefs, from
 *                             the same ALTER block, IS in production)
 *   default_location_id       027
 *   hmrc_nino / hmrc_access_token / hmrc_refresh_token
 *                             025
 *   marketing_emails_enabled  022
 *
 * The second describe below pins that, so nobody reads a green run here as
 * "the schema is in step with production". The thing that answers the live
 * database is backend/src/lib/schema-probe.js (hasColumn / selectable), and
 * the four still-missing columns above have no probe on them: see the report
 * for 31 August 2026.
 *
 * GENERALISING IT. The parser below is table agnostic apart from one constant,
 * so pointing it at appointments, clients or treatments is a one-line change
 * plus a baseline for each. Deliberately not done in this commit: each new
 * table needs its own read of its own findings, and a ratchet nobody has read
 * the output of is just a slow test.
 */
process.env.TZ = 'UTC';

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TABLE = 'beauticians';
const MIGRATIONS = new URL('../../../supabase/migrations/', import.meta.url).pathname;
const SRC = new URL('../../src/', import.meta.url).pathname;

/* ------------------------------------------------------------ the schema -- */

function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every column any migration gives the table, and which file gave it. */
function columnsFromMigrations() {
  const created = new Map();   // column -> migration filename
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS, file), 'utf8'));

    // The CREATE TABLE body. Constraint lines look like column lines, so the
    // leading keyword is checked rather than assumed.
    const ct = sql.match(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?${TABLE}\\s*\\(([\\s\\S]*?)\\n\\)\\s*;`, 'i'));
    if (ct) {
      for (const line of ct[1].split('\n')) {
        const m = line.match(/^\s*"?([a-z_][a-z0-9_]*)"?\s+[a-z]/i);
        if (!m) continue;
        if (['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'EXCLUDE', 'LIKE'].includes(m[1].toUpperCase())) continue;
        if (!created.has(m[1])) created.set(m[1], file);
      }
    }

    // ALTER TABLE ... ADD COLUMN, one statement at a time so a multi-column
    // ALTER (021, 025, 027 and friends all use one) is read whole.
    const alter = new RegExp(`ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(?:public\\.)?${TABLE}\\b([\\s\\S]*?);`, 'gi');
    for (const stmt of sql.matchAll(alter)) {
      const body = stmt[1];
      for (const a of body.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
        if (!created.has(a[1])) created.set(a[1], file);
      }
      // A rename creates the new name (067 renamed instagram_token).
      for (const a of body.matchAll(/RENAME\s+COLUMN\s+"?([a-z_][a-z0-9_]*)"?\s+TO\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
        if (!created.has(a[2])) created.set(a[2], file);
      }
      for (const a of body.matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
        created.delete(a[1]);
      }
    }
  }
  return created;
}

/* --------------------------------------------------------------- the code -- */

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Blank comments so a column named in prose is not read as code. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * Every column named in a `from('beauticians').select('...')` in src.
 *
 * Skipped on purpose, and each skip is a hole worth knowing about:
 *   - a template literal select, because the column list is built at runtime.
 *     services/notifications.js (readSmsRouting) does this deliberately, and it
 *     asks lib/schema-probe.js first, which is the correct way to name a column
 *     the database may not have.
 *   - writes. update/insert can name a missing column too, and PostgREST
 *     rejects those the same way. Selects first because a rejected write at
 *     least tends to surface as a visible 500.
 */
function columnsUsedInSrc() {
  const used = new Map();      // column -> first "file:line" that asks for it
  const dynamic = [];          // template-literal selects, reported not graded

  for (const file of walk(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(new RegExp(`from\\(\\s*['"]${TABLE}['"]\\s*\\)`, 'g'))) {
      const where = `${file.replace(SRC, 'src/')}:${src.slice(0, m.index).split('\n').length}`;

      // Look forward only as far as the next `from(`, so an update in one
      // query cannot borrow the select of the next one.
      let after = src.slice(m.index + 5, m.index + 1500);
      const nextFrom = after.search(/\bfrom\s*\(/);
      if (nextFrom > -1) after = after.slice(0, nextFrom);

      const sel = after.match(/\.select\(\s*(['"`])([\s\S]*?)\1/);
      const write = after.search(/\.(update|insert|upsert|delete)\s*\(/);
      if (!sel) continue;
      if (write > -1 && write < sel.index) continue;
      if (sel[1] === '`') { dynamic.push({ where, cols: sel[2].trim() }); continue; }

      // Drop embedded resources, `treatments(name)` and the like: those are
      // other tables' columns.
      const cols = sel[2].replace(/[a-z_]+\s*\([^)]*\)/gi, '');
      for (const raw of cols.split(',')) {
        const col = raw.trim().replace(/^.*:/, '').trim();     // alias:column
        if (!col || col === '*') continue;
        if (!/^[a-z_][a-z0-9_]*$/.test(col)) continue;
        if (!used.has(col)) used.set(col, where);
      }
    }
  }
  return { used, dynamic };
}

/* ---------------------------------------------------------------- the list --
 * Columns the backend selects that NO migration creates. Recorded 31 August
 * 2026. Shorten it, never lengthen it: a new entry is a select that will be
 * rejected wholesale by PostgREST, taking every other column in the same
 * statement down with it.
 */
const ALLOWED_MISSING = new Map([
  // lib/health.js asks for it so the Instagram token monitor can say how many
  // days are left on a token, and READS the error: isMissingColumnError sends
  // it round again without the column and reports expiry as untracked. A
  // deliberate degrade rather than an oversight, which is the only reason it
  // is allowed to stay. Nothing creates it: 021_instagram_columns.sql adds
  // instagram_page_id and instagram_page_token and stops there.
  ['instagram_token_expires_at', 'src/lib/health.js'],
]);

describe('the backend never selects a beauticians column no migration creates', () => {
  const created = columnsFromMigrations();
  const { used, dynamic } = columnsUsedInSrc();

  it('reads a real schema out of the migrations', () => {
    // A parser that quietly matched nothing would make every assertion below
    // pass for the wrong reason.
    expect(created.size).toBeGreaterThan(50);
    for (const core of ['id', 'email', 'first_name', 'booking_slug', 'working_hours', 'notification_prefs']) {
      expect([...created.keys()], `${core} should come out of the migrations`).toContain(core);
    }
  });

  it('finds the selects it is supposed to be grading', () => {
    expect(used.size).toBeGreaterThan(30);
    expect([...used.keys()]).toContain('notification_prefs');
  });

  it('names no column that does not exist', () => {
    const missing = [...used]
      .filter(([col]) => !created.has(col) && !ALLOWED_MISSING.has(col))
      .map(([col, where]) => `${col}  (${where})`);

    expect(missing, [
      'A select names a beauticians column no migration creates. PostgREST',
      'rejects the WHOLE select for one unknown column and resolves',
      '{ data: null, error }, so every other column in that statement comes',
      'back as nothing at all. Add the column in a migration, or drop it from',
      'the select.',
    ].join('\n')).toEqual([]);
  });

  it('the allowlist is not stale', () => {
    const stillMissing = [...ALLOWED_MISSING.keys()].filter(col => used.has(col) && !created.has(col));
    const gone = [...ALLOWED_MISSING.keys()].filter(col => !stillMissing.includes(col));
    expect(gone, `Fixed, created or no longer selected. Remove from ALLOWED_MISSING:\n${gone.join('\n')}`).toEqual([]);
  });

  it('the one dynamic select is the one that probes the database first', () => {
    // readSmsRouting builds its column list from lib/schema-probe.js answers,
    // which is the right way to name a column the live database may not have.
    // A NEW dynamic select is not automatically wrong, but it is invisible to
    // everything above, so it has to be looked at.
    expect(dynamic.map(d => d.where)).toEqual(['src/routes/webhooks.js:819']);
  });
});

/**
 * THE HOLE IN THE RATCHET, ASSERTED SO IT IS NOT MISTAKEN FOR COVERAGE.
 *
 * Every one of the six columns that were missing from PRODUCTION on 31 August
 * 2026 is created by a migration in this folder, so the ratchet above sees
 * nothing wrong with any of them and never could. Migrations here are applied
 * by hand; "written" and "run" are different states and only one of them is in
 * git.
 */
describe('a migration that exists is not a migration that has been run', () => {
  const created = columnsFromMigrations();

  const WRITTEN_BUT_ABSENT_FROM_PRODUCTION = {
    notification_prefs: '002_team_and_notifications.sql',
    default_location_id: '027_multi_location.sql',
    hmrc_nino: '025_hmrc_mtd.sql',
    hmrc_access_token: '025_hmrc_mtd.sql',
    hmrc_refresh_token: '025_hmrc_mtd.sql',
    marketing_emails_enabled: '022_email_sends.sql',
  };

  it('each one is created by the migration that was never applied', () => {
    for (const [col, file] of Object.entries(WRITTEN_BUT_ABSENT_FROM_PRODUCTION)) {
      expect(created.get(col), `${col} should still be created by ${file}`).toBe(file);
    }
  });

  it('notification_prefs also has the 31 August 2026 migration that actually ran', () => {
    // 002 is not edited: it has been applied by hand to live databases, so a
    // change there is a change nobody applies. 023 re-adds the column with
    // 002's exact default and is idempotent.
    const files = readdirSync(MIGRATIONS);
    expect(files).toContain('20260831_backend023_notification_prefs.sql');
    const sql = readFileSync(join(MIGRATIONS, '20260831_backend023_notification_prefs.sql'), 'utf8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS notification_prefs JSONB/);
    expect(sql).toMatch(/booking_pending/);
    expect(sql).toMatch(/COMMENT ON COLUMN beauticians\.notification_prefs/);
  });

  it('every pref key the backend can suppress on has a row in Settings', () => {
    // The other half of the same failure: a key the sender reads and the UI
    // never writes is a switch she cannot reach, and a row the UI writes that
    // no sender reads is a switch that does nothing.
    const push = readFileSync(join(SRC, 'services/push-notifications.js'), 'utf8');
    const block = push.match(/const ACTION_TO_PREF = \{([\s\S]*?)\n\};/);
    expect(block, 'ACTION_TO_PREF has moved').toBeTruthy();
    const keys = [...block[1].matchAll(/:\s*'([a-z_]+)'/g)].map(m => m[1]);
    expect(keys).toContain('booking_pending');
    expect(keys).toContain('booking_confirmed');

    const settings = readFileSync(new URL('../../../frontend/src/pages/Settings.jsx', import.meta.url).pathname, 'utf8');
    for (const key of new Set(keys)) {
      expect(settings, `notification_prefs.${key} can silence a push and has no toggle in Settings`)
        .toContain(`notification_prefs?.${key}`);
    }
  });
});
