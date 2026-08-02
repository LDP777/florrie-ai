#!/usr/bin/env node
/**
 * The migration runner.
 *
 * WHY THIS EXISTS
 * There were three migration directories, no runner, and no tracking table.
 * Every migration was pasted into the Supabase SQL editor by hand, so the
 * only record of what had been applied was somebody remembering. The result
 * is visible all over the backend: isMissingColumnError is checked in six
 * places because the code genuinely cannot know whether a column exists, and
 * more than one incident in this repo starts with an insert failing against a
 * column or constraint that was not what the code assumed.
 *
 * This runner applies every file in supabase/migrations that is not already
 * in the schema_migrations ledger, in filename order, each one inside its own
 * transaction, recording name, sha256 checksum and applied_at.
 *
 * IT IS SAFE TO POINT AT A DATABASE WHERE EVERYTHING WAS APPLIED BY HAND.
 * Run `baseline` first. That records every file currently on disk as applied
 * WITHOUT executing any of it, so the first real `up` has nothing to do and
 * cannot try to re-run ninety files against production.
 *
 * USAGE
 *   export DATABASE_URL="postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres"
 *
 *   node backend/scripts/migrate.js status              what is applied, what is pending
 *   node backend/scripts/migrate.js baseline --yes      record all current files as applied
 *   node backend/scripts/migrate.js up                  apply everything pending
 *   node backend/scripts/migrate.js up --dry-run        print what up would do
 *
 * Use the DIRECT connection string (port 5432), not the pooled PgBouncer one
 * (6543). PgBouncer in transaction mode cannot be trusted with multi-statement
 * DDL transactions, and this script needs real transactions to be worth
 * anything.
 *
 * AFTER ANY MIGRATION THAT ADDS A COLUMN OR TABLE: restart Railway, do not
 * redeploy it. PgBouncer caches the PostgREST schema, and a redeploy does not
 * clear it. This has cost this project real time twice.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../../supabase/migrations');

// The ledger has to exist before the ledger can record anything, so the
// runner creates it itself. This is byte-identical to the CREATE TABLE in
// supabase/migrations/20260802_schema_migrations.sql, which then applies as a
// no-op and records itself like any other file.
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by TEXT NOT NULL DEFAULT 'runner',
  duration_ms INTEGER
);`;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function loadFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  const names = entries.filter((n) => n.endsWith('.sql')).sort();
  const files = [];
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
    files.push({ name, sql, checksum: sha256(sql) });
  }
  return files;
}

async function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    console.error('Use the DIRECT Supabase connection string (port 5432), not the pooled one (6543).');
    process.exit(1);
  }
  // pg is a devDependency: this script is an operator tool and never runs
  // inside the API process, so the server image does not need it.
  let pg;
  try {
    ({ default: pg } = await import('pg'));
  } catch {
    console.error('The pg package is missing. Run `npm install` at the repo root first.');
    process.exit(1);
  }
  const client = new pg.Client({
    connectionString: url,
    // Supabase terminates TLS with its own chain. Verification is off for the
    // same reason every Supabase client does it; the connection is still
    // encrypted.
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function readLedger(client) {
  await client.query(LEDGER_DDL);
  const { rows } = await client.query('SELECT name, checksum, applied_at, applied_by FROM schema_migrations');
  return new Map(rows.map((r) => [r.name, r]));
}

function partition(files, ledger) {
  const pending = [];
  const applied = [];
  const changed = [];
  for (const file of files) {
    const row = ledger.get(file.name);
    if (!row) { pending.push(file); continue; }
    applied.push(file);
    if (row.checksum !== file.checksum) changed.push({ file, row });
  }
  // A row in the ledger with no file on disk means somebody deleted a
  // migration after it ran. Worth saying out loud; not worth failing over.
  const orphans = [...ledger.keys()].filter((name) => !files.some((f) => f.name === name));
  return { pending, applied, changed, orphans };
}

function reportChanged(changed) {
  if (changed.length === 0) return;
  console.log('');
  console.log(`WARNING: ${changed.length} applied migration(s) have been edited since they ran:`);
  for (const { file } of changed) console.log(`  ${file.name}`);
  console.log('The database has the OLD version. Write a new migration rather than editing an old one.');
}

async function cmdStatus() {
  const files = await loadFiles();
  const client = await connect();
  try {
    const ledger = await readLedger(client);
    const { pending, applied, changed, orphans } = partition(files, ledger);

    console.log(`migrations on disk : ${files.length}`);
    console.log(`applied            : ${applied.length}`);
    console.log(`pending            : ${pending.length}`);
    if (pending.length) {
      console.log('');
      console.log('Pending, in the order they would be applied:');
      for (const f of pending) console.log(`  ${f.name}`);
    }
    if (orphans.length) {
      console.log('');
      console.log('In the ledger but not on disk:');
      for (const name of orphans) console.log(`  ${name}`);
    }
    reportChanged(changed);
  } finally {
    await client.end();
  }
}

async function cmdBaseline({ confirmed }) {
  const files = await loadFiles();
  const client = await connect();
  try {
    const ledger = await readLedger(client);
    const { pending } = partition(files, ledger);

    if (pending.length === 0) {
      console.log('Nothing to baseline: every file on disk is already in the ledger.');
      return;
    }

    console.log(`This will record ${pending.length} migration(s) as ALREADY APPLIED without running them:`);
    for (const f of pending) console.log(`  ${f.name}`);
    console.log('');
    console.log('Only do this against a database where these were genuinely applied by hand.');

    if (!confirmed) {
      console.log('');
      console.log('Nothing was written. Re-run with --yes to confirm.');
      return;
    }

    await client.query('BEGIN');
    try {
      for (const f of pending) {
        await client.query(
          `INSERT INTO schema_migrations (name, checksum, applied_by)
           VALUES ($1, $2, 'baseline')
           ON CONFLICT (name) DO NOTHING`,
          [f.name, f.checksum],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    console.log('');
    console.log(`Baselined ${pending.length} migration(s). \`up\` now has nothing to do.`);
  } finally {
    await client.end();
  }
}

async function cmdUp({ dryRun }) {
  const files = await loadFiles();
  const client = await connect();
  try {
    const ledger = await readLedger(client);
    const { pending, changed } = partition(files, ledger);
    reportChanged(changed);

    if (pending.length === 0) {
      console.log('Nothing to apply. The database is up to date.');
      return;
    }

    // A first run that wants to apply the whole history is almost always a
    // missing baseline, not a genuinely empty database. Say so before doing
    // something irreversible to production.
    if (ledger.size === 0 && pending.length > 5) {
      console.log(`The ledger is empty and there are ${pending.length} migrations on disk.`);
      console.log('If these were applied by hand already, run `baseline --yes` FIRST.');
      console.log('If this really is a fresh database, run `up --force-empty`.');
      if (!process.argv.includes('--force-empty')) return;
    }

    console.log(`Applying ${pending.length} migration(s):`);
    for (const file of pending) {
      if (dryRun) {
        console.log(`  would apply ${file.name} (${file.sql.length} bytes)`);
        continue;
      }
      const startedAt = Date.now();
      // One transaction per file. A migration either lands whole or not at
      // all, which is the difference between a failed deploy and a database
      // in a state no file describes.
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query(
          `INSERT INTO schema_migrations (name, checksum, applied_by, duration_ms)
           VALUES ($1, $2, 'runner', $3)`,
          [file.name, file.checksum, Date.now() - startedAt],
        );
        await client.query('COMMIT');
        console.log(`  applied ${file.name} (${Date.now() - startedAt}ms)`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  FAILED  ${file.name}`);
        console.error(`  ${err.message}`);
        console.error('');
        console.error('Rolled back. Nothing after this file was attempted. Fix the file and run `up` again.');
        process.exitCode = 1;
        return;
      }
    }

    if (!dryRun) {
      console.log('');
      console.log('Done. If any of these added a table or column, RESTART Railway (not redeploy)');
      console.log('so PgBouncer picks up the new PostgREST schema.');
    }
  } finally {
    await client.end();
  }
}

const command = process.argv[2] || 'status';
const flags = new Set(process.argv.slice(3));

const commands = {
  status: () => cmdStatus(),
  baseline: () => cmdBaseline({ confirmed: flags.has('--yes') }),
  up: () => cmdUp({ dryRun: flags.has('--dry-run') }),
};

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error('Usage: node backend/scripts/migrate.js [status|baseline|up] [--yes|--dry-run]');
  process.exit(1);
}

commands[command]().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
