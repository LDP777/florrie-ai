# Migrations: what to run, in order

Levi, this is the whole thing. Nothing here has been run for you.

The production database already has every migration in `supabase/migrations`
applied, because they were pasted into the Supabase SQL editor by hand. The
runner has to be told that before it is allowed to run anything, or it would
try to replay ninety files against a live database.

## One-off setup

**1. Get the direct connection string.**

Supabase dashboard, project settings, Database, Connection string, URI.
Use the **direct** one on port **5432**. Not the pooled one on 6543: PgBouncer
in transaction mode cannot be trusted with multi-statement DDL transactions,
and the whole point of this runner is that each migration is one transaction.

```bash
export DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@db.driyreevwogxngqyshtc.supabase.co:5432/postgres"
```

**2. Install dependencies once, at the repo root.**

```bash
cd ~/ai-company/projects/florrie-ai
npm install
```

**3. Look before you touch anything.**

```bash
node backend/scripts/migrate.js status
```

Expect: 92 migrations on disk, 0 applied, 92 pending. That is correct and
expected on the first run. It does not mean the database is empty, it means
the ledger is empty, which is exactly the problem this fixes. The command is
read-only apart from creating the empty `schema_migrations` table.

**4. Baseline. This is the important step.**

```bash
node backend/scripts/migrate.js baseline --yes
```

This records every file currently on disk as already applied, **without
executing any of it**. Run it exactly once, against production, now, while it
is true that all of them have been applied.

Without `--yes` it prints what it would record and writes nothing, so you can
read the list first if you want.

**5. Confirm.**

```bash
node backend/scripts/migrate.js status
```

Expect: 92 applied, 0 pending.

That is setup finished. From here on the runner is the only thing that touches
schema.

## Every time after that

When a migration file is added to `supabase/migrations`:

```bash
node backend/scripts/migrate.js status        # confirm only the new file is pending
node backend/scripts/migrate.js up --dry-run  # see exactly what it would run
node backend/scripts/migrate.js up            # apply it
```

Each file runs inside its own transaction. If one fails, it is rolled back
whole, nothing after it is attempted, and the ledger is not written. Fix the
file and run `up` again.

**Then restart Railway. Restart, not redeploy.** PgBouncer caches the PostgREST
schema, and a redeploy does not clear it. Skipping this is why a column that
exists in the database can still read as missing to the API, which has cost
this project real time twice.

## If something looks wrong

- **`status` shows a file as pending that you know was applied by hand.**
  It was added after the baseline. Either run it (`up`), or if you are certain
  it is already in the database, run `baseline --yes` again: baseline only ever
  records files that are not yet in the ledger, so it is safe to repeat.

- **"WARNING: N applied migration(s) have been edited since they ran."**
  Somebody changed a migration file after it was applied. The database has the
  old version. Do not try to fix it by editing further: write a new migration.
  The warning is informational, it does not block anything.

- **`up` refuses because the ledger is empty and there are many pending.**
  That is the guard against replaying history onto production. If it genuinely
  is a fresh database (a new staging project, say), run
  `node backend/scripts/migrate.js up --force-empty`.

## What does not go through the runner

`docs/*.sql` other than this file is diagnostics and one-off data repair:
`money_diagnostic.sql`, `find_duplicate_clients.sql`, `backfill_takings.sql`,
`RECOMPUTE_CLIENT_SPEND.sql`, `MONEY_RECONCILIATION.sql`,
`COMP_PILOT_ACCOUNT.sql`, and so on. Those are run once, by a human, on
purpose, in the SQL editor. Replaying a one-time data repair against a later
database is how you corrupt it, so the runner must never see them.

The rule: schema changes live in `supabase/migrations` and the runner applies
them. Data repairs live in `docs/` and you run them yourself.

See `supabase/migrations/README.md` for the naming convention and for the
record of which files came from where.
