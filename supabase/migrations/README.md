# Migrations

**This is the only migration directory.** If a `.sql` file changes the shape of
the database and it is not in here, it does not exist.

Until August 2026 there were three sources and no runner:

| Where | What was in it | What happened to it |
|---|---|---|
| `supabase/migrations/` | 81 files, numbered `001`..`080` plus four date-stamped ones | Kept. This is now canonical. |
| `backend/src/migrations/` | 12 files numbered `009`..`020`, **colliding with the numbers in here** | Moved in, renamed, directory deleted. |
| `docs/*.sql` | A mix of one-off operator scripts and hand-pasted copies of migrations that are already numbered in here | Stays in `docs/`. It is **not** a migration source. See below. |

Nothing tracked what had been applied. Every migration was pasted into the
Supabase SQL editor by hand. That is why the backend checks
`isMissingColumnError` in six different places: the code genuinely could not
know whether a column existed.

## Apply order is filename order

The runner sorts filenames lexicographically and applies them in that order.
Two families sort in sequence:

1. `001_` .. `080_`, the main lineage.
2. `YYYYMMDD_`, everything added out of band. These sort after all the numbered
   files, and in true date order among themselves.

Applying the numbered lineage first and the date-stamped files after is a valid
replay: the date-stamped files depend on tables the numbered ones create, never
the other way round.

**New migrations use the date form: `YYYYMMDD_short_name.sql`.** Do not add
another number to the `0NN_` series. Numbers were what collided in the first
place, dates cannot collide with a directory you have not looked at, and the
date form always sorts last, which is where a new migration belongs.

## The colliding files

The twelve files that came from `backend/src/migrations/` kept their original
number inside the new name, so the record of what was applied is not lost:

```
009_consultation_forms.sql              -> 20260409_backend009_consultation_forms.sql
010_add_ons_extended.sql                -> 20260409_backend010_add_ons_extended.sql
011_waitlist.sql                        -> 20260409_backend011_waitlist.sql
012_schema_catchup.sql                  -> 20260710_backend012_schema_catchup.sql
013_memberships_catchup.sql             -> 20260712_backend013_memberships_catchup.sql
014_confirmation_sent_at.sql            -> 20260725_backend014_confirmation_sent_at.sql
015_client_blocking.sql                 -> 20260725_backend015_client_blocking.sql
016_junk_flag_and_instagram_username.sql-> 20260727_backend016_junk_flag_and_instagram_username.sql
017_instagram_redirect_throttle.sql     -> 20260727_backend017_instagram_redirect_throttle.sql
018_client_archiving.sql                -> 20260801_backend018_client_archiving.sql
019_knowledge_base.sql                  -> 20260801_backend019_knowledge_base.sql
020_job_runs.sql                        -> 20260802_backend020_job_runs.sql
```

The date is the date the file was written and applied, so they now sort in the
order they really ran. `backendNNN` records which number they used to carry,
because both directories had an `009`, an `018` and so on, and the commit
messages, the incident notes and the code comments all refer to them by those
old numbers.

### Known collisions, left alone on purpose

- `20260409_backend011_waitlist.sql` creates a landing-page signup table called
  `waitlist`. `001_initial_schema.sql` already creates a client/treatment
  `waitlist` table, and `070_waitlist_pro_columns.sql` documents that the 001
  one is canonical. Because backend011 is `CREATE TABLE IF NOT EXISTS` and now
  sorts after 001, a replay makes it a harmless no-op. That matches production.
- `20260331_waitlist_signups.sql` is the same signup table under a different
  name, and is a no-op for the same reason.

- `067_instagram_page_token_rename.sql` and `067_last_visit_accuracy.sql` share
  a number. They do not share a name, and the name is the only thing that
  matters: `schema_migrations.name` is the primary key, and `loadFiles()` sorts
  by filename, so the two files are two distinct ledger rows applied in a
  deterministic order. **Do not renumber either one.** A rename makes the
  runner see a filename it has never recorded, so it treats an already-applied
  migration as pending and runs it again against production, and it leaves the
  old name behind as an orphan row. The duplicate number costs nothing; fixing
  it costs a re-run.

Neither is worth rewriting. Rewriting history is how the record of what
actually ran gets lost.

## The gaps in the numbering are not missing files

`013`, `014`, `047`, `049`, `062` and `075` have never existed in this
directory, in any commit. Nothing was deleted, and there is no ledger row
waiting for them. Contiguity is not a thing the runner checks or needs: it
sorts whatever `.sql` files it finds and applies the ones the ledger has not
seen. A gap is a number somebody skipped, nothing more.

New migrations use the date form anyway, so the `0NN_` series will not grow.

## Why `docs/*.sql` is not a migration source

Every DDL file in `docs/` is a hand-pasted copy of a migration that is already
numbered in here:

| docs file | already in this directory as |
|---|---|
| `APPLY_IN_SUPABASE_2026-06-10_anon_lockdown.sql` | `054_anon_lockdown.sql` |
| `APPLY_IN_SUPABASE_2026-06-10_voice_optout.sql` | `055_voice_metrics_and_optout.sql` |
| `APPLY_IN_SUPABASE_2026-06-10_status_vocab.sql` | `056_fix_appointment_status_vocab.sql` |
| `APPLY_IN_SUPABASE_2026-06-10_loyalty.sql` | `057_loyalty_accrual.sql` |
| `APPLY_IN_SUPABASE_2026-06-10_loyalty_reward.sql` | `058_loyalty_reward.sql` |
| `APPLY_IN_SUPABASE_2026-06-10_wa_provider.sql` | `059_wa_provider.sql` |
| `APPLY_IN_SUPABASE_2026-06-11_native_push.sql` | `060_native_push_tokens.sql` |
| `APPLY_IN_SUPABASE_2026-06-17_outbound_and_metering.sql` | `064` + `065` + `066` |
| `APPLY_073_overlap_exclude_manual.sql` | `073_overlap_exclude_manual.sql` |
| `20260705_live_activity_tokens.sql` | `20260705_live_activity_tokens.sql` |
| `2026-07-10_manage_patchtest_fixes.sql` | `20260710_backend012_schema_catchup.sql` |

They are kept as the operator notes they are, because several of them record
what production actually looked like before the change, which the migration
itself does not. The rest of `docs/*.sql` is diagnostics and one-off data
repair (`money_diagnostic.sql`, `find_duplicate_clients.sql`,
`backfill_takings.sql`, `RECOMPUTE_CLIENT_SPEND.sql`, `COMP_PILOT_ACCOUNT.sql`
and so on). Those are scripts, not schema, and they must never be added to a
migration runner: replaying a one-time data repair on a later database is how
you corrupt it.

**Rule: if it changes schema, it belongs here and it gets applied by the
runner. If it repairs or inspects data, it belongs in `docs/` and a human runs
it once, on purpose.**

## The ledger

`schema_migrations` (created by `20260802_schema_migrations.sql`) holds one row
per applied file: name, sha256 checksum of the file as it was when it ran,
`applied_at`, and whether it was executed by the runner or recorded as a
baseline.

The checksum is evidence, not a lock. If somebody edits a migration that has
already run, `migrate.js` says so, because the database has the old version and
the next environment would get the new one.

## Running them

Runner: `backend/scripts/migrate.js`. Full instructions, including the exact
first-time sequence for the existing production database, are in
`docs/MIGRATIONS.md`.

Short version:

```bash
export DATABASE_URL="postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres"

node backend/scripts/migrate.js status           # what is applied, what is pending
node backend/scripts/migrate.js baseline --yes   # FIRST RUN ONLY on the existing prod database
node backend/scripts/migrate.js up               # apply everything pending
```

Use the direct connection string on port 5432, not the pooled one on 6543.

After any migration that adds a table or a column, **restart** Railway. Do not
redeploy it. PgBouncer caches the PostgREST schema and a redeploy does not
clear it.
