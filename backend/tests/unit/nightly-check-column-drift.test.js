/**
 * THE CHECK THAT WOULD HAVE CAUGHT #174.
 *
 * On 31 August 2026 the scheduled nightly filed issue #174 with the line
 * "Database Schema Drift: NO DRIFT DETECTED". That same night SEVEN columns the
 * backend selects did not exist in the production database: notification_prefs,
 * marketing_emails_enabled, default_location_id, the three hmrc_* columns and
 * content_posts.media_kind. Between them they cost a week of dead notification
 * settings, a marketing opt out that was ignored at the point of sending, an
 * HMRC integration that reported itself as "not linked", and a Save as Draft
 * button that always failed.
 *
 * The reason none of it was caught is that everything looking at the schema
 * compared source code to migration files. Both agreed. Production, the third
 * thing, was never asked. So scripts/nightly-check.mjs section 9 asks it, and
 * this file tests the two halves of that separately, because they fail in
 * different ways:
 *
 *   - the EXTRACTOR, which reads column names out of source. Pure text in,
 *     pure structure out. Its failure mode is reading a name wrong or, worse,
 *     silently reading nothing and making the whole check look green.
 *   - the JUDGEMENT, which diffs { table: [column] } from the code against
 *     { table: [column] } from information_schema.columns. Its failure mode is
 *     the one that cost the week: saying "no drift" when it could not look.
 *
 * The live database itself cannot be reached from a unit test, and nothing here
 * tries. That is the point of both halves being pure.
 */
process.env.TZ = 'UTC';

import { describe, it, expect } from 'vitest';
import {
  extractColumnReferences,
  parseSelect,
  judgeColumnDrift,
  KNOWN_MISSING_COLUMNS,
} from '../../../scripts/nightly-check.mjs';

const sev = (findings, s) => findings.filter((f) => f.severity === s);
const pairs = (refs) => refs.map((r) => `${r.table}.${r.column}`).sort();
const one = (file, text) => extractColumnReferences([{ file, text }]);

/* ========================================================================= *
 * THE EXTRACTOR
 * ========================================================================= */

describe('reading the columns the backend asks for', () => {
  it('reads a single line select', () => {
    const { references } = one('a.js', "supabase.from('beauticians').select('id, email')");
    expect(pairs(references)).toEqual(['beauticians.email', 'beauticians.id']);
  });

  /*
   * Nearly every long select in this codebase is a backtick spanning ten or
   * twenty lines. routes/inbox.js is the example. An extractor that only read
   * single quoted strings would cover almost nothing and would still report a
   * confident green.
   */
  it('reads a select spread over many lines', () => {
    const { references, dynamic } = one('inbox.js', `
      const { data } = await supabase
        .from('messages')
        .select(\`
          id,
          client_id,
          content,
          created_at
        \`)
        .eq('beautician_id', id);
    `);
    expect(pairs(references)).toEqual([
      'messages.client_id', 'messages.content', 'messages.created_at', 'messages.id',
    ]);
    expect(dynamic).toHaveLength(0);
  });

  /*
   * An embed's columns belong to the EMBEDDED table. Getting this backwards
   * would report every client column as a missing beauticians column, which is
   * the single loudest way this check could be wrong.
   */
  it('gives an embedded table its own columns, and does not treat the embed name as a column', () => {
    const { references } = one('a.js', "from('appointments').select('id, clients(first_name, phone)')");
    expect(pairs(references)).toEqual([
      'appointments.id', 'clients.first_name', 'clients.phone',
    ]);
    expect(pairs(references)).not.toContain('appointments.clients');
  });

  it('handles a nested embed, an aliased embed and a !hint', () => {
    const { references } = one('a.js',
      "from('appointments').select('id, client:clients(id, messages!inner(id, content))')");
    expect(pairs(references)).toEqual([
      'appointments.id', 'clients.id', 'messages.content', 'messages.id',
    ]);
  });

  it('follows an alias to the real column, because the alias exists only in the JSON', () => {
    const { references } = one('a.js', "from('beauticians').select('name:first_name, mail:email')");
    expect(pairs(references)).toEqual(['beauticians.email', 'beauticians.first_name']);
  });

  it('reads through a ::cast and a ->>json path to the column underneath', () => {
    const { references } = one('a.js', "from('beauticians').select('id::text, prefs:notification_prefs->>push')");
    expect(pairs(references)).toEqual(['beauticians.id', 'beauticians.notification_prefs']);
  });

  it('ignores * and count, which name nothing and so cannot drift', () => {
    const { references, dynamic } = one('a.js', "from('content_posts').select('*, appointments(count)')");
    expect(references).toEqual([]);
    expect(dynamic).toEqual([]);
  });

  it('ignores a bare select(), which means every column exactly like *', () => {
    const { references, dynamic } = one('a.js', "from('packages').insert(row).select().single()");
    expect(references).toEqual([]);
    expect(dynamic).toEqual([]);
  });

  /*
   * The honest half. A column list built at runtime cannot be resolved without
   * running the code, so it is COUNTED and named rather than quietly dropped.
   * Quietly dropping what you cannot read is exactly how "NO DRIFT DETECTED"
   * got printed on 31 August 2026.
   */
  it('skips a template literal select and counts it rather than pretending to cover it', () => {
    const { references, dynamic } = one('notifications.js', [
      "const cols = probe();",
      "await supabase.from('beauticians').select(`id, ${cols}`).eq('id', x);",
    ].join('\n'));
    expect(references).toEqual([]);
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0]).toMatchObject({ file: 'notifications.js', table: 'beauticians', line: 2 });
    expect(dynamic[0].why).toMatch(/template literal/);
  });

  it('skips a select whose argument is a call, and counts that too', () => {
    const { references, dynamic } = one('money.js',
      "from('expenses').select(await selectable(supabase, 'expenses', ['amount_cents'], ['hmrc_category']))");
    expect(references).toEqual([]);
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0].why).toMatch(/expression rather than a literal/);
  });

  /*
   * services/cleanup.js declares its column list once as a plain string and
   * uses it in two queries. Resolving that name is reading a literal, not
   * guessing at one, and it is worth doing: that select is how the unpaid
   * appointment cleanup reads its rows.
   */
  it('resolves a select whose argument is a plain string constant in the same file', () => {
    const { references, dynamic } = one('cleanup.js', [
      "const SELECT = 'id, starts_at, clients(first_name)';",
      "await supabase.from('appointments').select(SELECT).lt('x', now);",
    ].join('\n'));
    expect(pairs(references)).toEqual(['appointments.id', 'appointments.starts_at', 'clients.first_name']);
    expect(dynamic).toEqual([]);
  });

  it('finds nothing at all for a table nothing selects from', () => {
    const { references } = one('a.js', "from('beauticians').select('id')");
    expect(references.filter((r) => r.table === 'job_runs')).toEqual([]);
  });

  it('does not read a column name out of a comment', () => {
    const { references } = one('a.js', [
      "// from('beauticians').select('hmrc_nino')",
      "/* .select('marketing_emails_enabled') */",
      "from('beauticians').select('id')",
    ].join('\n'));
    expect(pairs(references)).toEqual(['beauticians.id']);
  });

  it('reports the line of the select and does not let one statement borrow the next one\'s columns', () => {
    const { references } = one('a.js', [
      "await supabase.from('beauticians').select('id');",
      "await supabase.from('clients').select('first_name');",
    ].join('\n'));
    expect(references.map((r) => `${r.table}.${r.column}@${r.line}`).sort())
      .toEqual(['beauticians.id@1', 'clients.first_name@2']);
  });

  /*
   * Severity turns on this. lib/health.js and routes/inbox.js both read the
   * error and ask again without the column, so those selects lose one field
   * rather than the whole row.
   */
  it('sees the isMissingColumnError guard that lib/health.js uses', () => {
    const { references } = one('health.js', `
      const withExpiry = await supabase
        .from('beauticians')
        .select('id, instagram_token_expires_at')
        .not('instagram_page_id', 'is', null);
      if (withExpiry.error) {
        if (!isMissingColumnError(withExpiry.error)) return { status: 'unknown' };
      }
    `);
    expect(references.every((r) => r.guarded)).toBe(true);
  });

  it('calls a select with no error handling unguarded', () => {
    const { references } = one('hmrc.js', `
      const { data } = await supabase
        .from('beauticians')
        .select('hmrc_nino, hmrc_access_token')
        .eq('id', req.beautician.id)
        .single();
      res.json({ linked: !!(data?.hmrc_nino && data?.hmrc_access_token) });
    `);
    expect(references.every((r) => r.guarded)).toBe(false);
  });

  it('records what else the same statement loses, because PostgREST rejects all of it', () => {
    const { references } = one('a.js', "from('beauticians').select('hmrc_nino, hmrc_access_token, id')");
    const nino = references.find((r) => r.column === 'hmrc_nino');
    expect(nino.alsoLost.sort()).toEqual(['beauticians.hmrc_access_token', 'beauticians.id']);
  });
});

describe('parseSelect on its own', () => {
  it('returns nothing for an empty list rather than a phantom column', () => {
    expect(parseSelect('', 'beauticians')).toEqual([]);
    expect(parseSelect('   ', 'beauticians')).toEqual([]);
  });

  it('does not split on a comma inside an embed', () => {
    expect(parseSelect('id, clients(a, b), status', 'appointments')).toEqual([
      { table: 'appointments', column: 'id' },
      { table: 'clients', column: 'a' },
      { table: 'clients', column: 'b' },
      { table: 'appointments', column: 'status' },
    ]);
  });
});

/* ========================================================================= *
 * THE JUDGEMENT
 *
 * { table: [column] } from the code against { table: [column] } from the
 * database. No network, no filesystem, no clock.
 * ========================================================================= */

const ref = (table, column, extra = {}) => ({
  table, column, file: 'backend/src/routes/x.js', line: 10, guarded: false, alsoLost: [], ...extra,
});

describe('diffing what the code asks for against what production has', () => {
  it('says the live schema was NOT read, and never says no drift, when there is no credential', () => {
    const out = judgeColumnDrift({
      references: [ref('beauticians', 'notification_prefs')],
      live: null,
      unreadable: 'had no database credential, because NIGHTLY_DATABASE_URL is not set',
    });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('not_checked');
    expect(out[0].title).toMatch(/was NOT checked/);
    expect(out[0].detail).toMatch(/NIGHTLY_DATABASE_URL is not set/);
    // The sentence that #174 needed and did not have.
    expect(out[0].detail).toMatch(/It is NOT evidence that the live schema matches the code/);
    expect(out[0].detail).toMatch(/A check that could not look says it could not look/);
    // And it must never accidentally emit the clean sentence.
    expect(sev(out, 'info')).toHaveLength(0);
    expect(out.some((f) => /exists in production/.test(f.title))).toBe(false);
  });

  it('says the same thing, with the error, when the query itself fails', () => {
    const out = judgeColumnDrift({
      references: [ref('beauticians', 'id')],
      live: null,
      unreadable: 'could not read information_schema.columns: permission denied',
    });
    expect(out[0].severity).toBe('not_checked');
    expect(out[0].detail).toMatch(/permission denied/);
  });

  /*
   * The whole point of the rewrite. "I looked and found nothing" and "I could
   * not look" have to be two different sentences, because #174 printed the
   * first while doing the second.
   */
  it('the clean sentence says the database was read, which is not the same as no drift detected', () => {
    const out = judgeColumnDrift({
      references: [ref('beauticians', 'id'), ref('beauticians', 'email')],
      live: { beauticians: ['id', 'email', 'first_name'] },
      filesScanned: 3,
    });
    expect(sev(out, 'fail')).toHaveLength(0);
    expect(sev(out, 'warn')).toHaveLength(0);
    expect(out[0].severity).toBe('info');
    expect(out[0].title).toBe('every column the backend selects exists in production');
    expect(out[0].detail).toMatch(/Read information_schema\.columns in the live database/);
    expect(out[0].detail).toMatch(/different sentence/);
  });

  it('fails on a column production does not have, and names every file:line that asks for it', () => {
    const out = judgeColumnDrift({
      references: [
        ref('beauticians', 'hmrc_nino', { file: 'backend/src/routes/hmrc.js', line: 31 }),
        ref('beauticians', 'hmrc_nino', { file: 'backend/src/services/hmrc-mtd.js', line: 169 }),
      ],
      live: { beauticians: ['id', 'email'] },
    });
    const [f] = sev(out, 'fail');
    expect(f.title).toBe('production has no beauticians.hmrc_nino');
    expect(f.detail).toContain('backend/src/routes/hmrc.js:31');
    expect(f.detail).toContain('backend/src/services/hmrc-mtd.js:169');
    expect(f.key).toBe('beauticians.hmrc_nino');
  });

  it('says what the finding breaks, out of the list written on 31 August 2026', () => {
    const out = judgeColumnDrift({
      references: [ref('beauticians', 'marketing_emails_enabled')],
      live: { beauticians: ['id'] },
    });
    expect(out[0].detail).toMatch(/PECR/);
  });

  it('names the other columns the same statement loses', () => {
    const out = judgeColumnDrift({
      references: [ref('beauticians', 'notification_prefs', { alsoLost: ['beauticians.timezone'] })],
      live: { beauticians: ['id', 'timezone'] },
    });
    expect(out[0].detail).toMatch(/Taken down with it in the same statement\(s\): beauticians\.timezone\./);
  });

  it('warns rather than fails when the call site demonstrably degrades', () => {
    const out = judgeColumnDrift({
      references: [ref('beauticians', 'instagram_token_expires_at', { guarded: true })],
      live: { beauticians: ['id'] },
    });
    expect(sev(out, 'fail')).toHaveLength(0);
    expect(sev(out, 'warn')).toHaveLength(1);
    expect(out[0].detail).toMatch(/isMissingColumnError/);
  });

  it('fails when only some of the call sites degrade, because the other one still breaks', () => {
    const out = judgeColumnDrift({
      references: [
        ref('beauticians', 'instagram_token_expires_at', { guarded: true, file: 'a.js' }),
        ref('beauticians', 'instagram_token_expires_at', { guarded: false, file: 'b.js' }),
      ],
      live: { beauticians: ['id'] },
    });
    expect(sev(out, 'fail')).toHaveLength(1);
  });

  it('fails on anything not on the list, guarded or not, because it is new', () => {
    const out = judgeColumnDrift({
      references: [ref('clients', 'lateness_score', { guarded: true })],
      live: { clients: ['id', 'first_name'] },
    });
    expect(sev(out, 'fail')).toHaveLength(1);
    expect(out[0].detail).toMatch(/NOT on the list recorded on 31 August 2026/);
  });

  /*
   * information_schema.columns shows a role only the relations it has a
   * privilege on. A role that can read nothing would otherwise "discover" that
   * every column in the codebase is missing, which is the loudest possible
   * false alarm.
   */
  it('does not call a table it cannot see a table full of missing columns', () => {
    const out = judgeColumnDrift({
      references: [ref('job_runs', 'job_name'), ref('beauticians', 'id')],
      live: { beauticians: ['id'], job_runs: [] },
    });
    expect(sev(out, 'fail')).toHaveLength(0);
    const [unseen] = out.filter((f) => f.id === 'column_drift_invisible');
    expect(unseen.severity).toBe('not_checked');
    expect(unseen.detail).toContain('job_runs');
    expect(unseen.detail).toMatch(/no privilege on them/);
  });

  it('treats a table missing from the live map exactly like one with no visible columns', () => {
    const out = judgeColumnDrift({
      references: [ref('job_runs', 'job_name')],
      live: {},
    });
    expect(sev(out, 'fail')).toHaveLength(0);
    expect(out.some((f) => f.id === 'column_drift_invisible')).toBe(true);
    // Nothing was compared, so the clean sentence must not appear either.
    expect(out.some((f) => /exists in production/.test(f.title))).toBe(false);
  });

  it('counts the runtime built selects even on a clean night', () => {
    const out = judgeColumnDrift({
      references: [ref('beauticians', 'id')],
      dynamic: [{ file: 'backend/src/routes/webhooks.js', line: 820, table: 'beauticians', why: 'a template literal' }],
      live: { beauticians: ['id'] },
    });
    const [d] = out.filter((f) => f.id === 'column_drift_dynamic');
    expect(d.severity).toBe('info');
    expect(d.title).toMatch(/^1 select\(s\) build their column list at runtime/);
    expect(d.detail).toContain('backend/src/routes/webhooks.js:820');
  });

  it('counts them even when it could not look at the database at all', () => {
    const out = judgeColumnDrift({
      references: [],
      dynamic: [{ file: 'a.js', line: 1, table: 'beauticians', why: 'a template literal' }],
      live: null,
      unreadable: 'had no database credential',
    });
    expect(out.map((f) => f.id)).toEqual(['column_drift', 'column_drift_dynamic']);
  });

  it('says so when a column on the list has been created, so the list can be shortened', () => {
    const out = judgeColumnDrift({
      references: [ref('beauticians', 'notification_prefs')],
      live: { beauticians: ['id', 'notification_prefs'] },
    });
    const [stale] = out.filter((f) => f.id === 'column_drift_allowlist');
    expect(stale.severity).toBe('info');
    expect(stale.detail).toContain('beauticians.notification_prefs');
    expect(stale.detail).toMatch(/Delete these from KNOWN_MISSING_COLUMNS/);
  });
});

/* ========================================================================= *
 * THE LIST
 * ========================================================================= */

describe('the seven columns issue #174 said were fine', () => {
  const SEVEN = [
    'beauticians.notification_prefs',
    'beauticians.marketing_emails_enabled',
    'beauticians.default_location_id',
    'beauticians.hmrc_access_token',
    'beauticians.hmrc_nino',
    'beauticians.hmrc_refresh_token',
    'content_posts.media_kind',
  ];

  it('is on the list, every one of them, with a note saying what it breaks', () => {
    for (const key of SEVEN) {
      const entry = KNOWN_MISSING_COLUMNS.get(key);
      expect(entry, `${key} is missing from KNOWN_MISSING_COLUMNS`).toBeTruthy();
      expect(entry.breaks.length, `${key} needs a note saying what it breaks`).toBeGreaterThan(40);
    }
  });

  it('records that content_posts.media_kind is the one this check would NOT have found', () => {
    // The backend only ever reads it off a select('*'); the name is written by
    // frontend/src/pages/ContentAutopilot.jsx. Saying so on the entry is the
    // difference between a list and a list somebody can act on.
    expect(KNOWN_MISSING_COLUMNS.get('content_posts.media_kind').breaks)
      .toMatch(/WOULD NOT HAVE FOUND IT/);
  });
});
