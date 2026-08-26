/**
 * AN AUDIT TRAIL THAT HAS NEVER HELD A ROW.
 *
 * ai_actions.outcome has a CHECK from 001_initial_schema.sql allowing exactly
 * success, pending, failed and escalated. Five insert sites across two files
 * wrote 'failure'. Postgres rejected every one of them with 23514, and every
 * one of those inserts sits inside a try/catch that turns the rejection into a
 * logger.warn nobody reads.
 *
 * The consequence is not cosmetic. logSendFailure in notifications.js is THE
 * place a permanently failing send was designed to become visible to a human.
 * It has been discarding its own rows since the day it was written, which is
 * why a WhatsApp confirmation going out with no link, to every client, for at
 * least a fortnight, was invisible to everybody including the code written to
 * catch exactly that.
 *
 * Renaming the five values fixes the five. This stops the sixth, which is the
 * only part that survives the next person.
 *
 * The same argument applies to action_type, which lost its CHECK in migration
 * 051 precisely because values are partly generated at runtime, and to status,
 * which 20260803_schema_drift_columns.sql added deliberately with no default.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../../src/', import.meta.url).pathname;
const MIGRATIONS = new URL('../../../supabase/migrations/', import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() && p.endsWith('.js') ? [p] : [];
  });
}

/** Blank comments so a value discussed in prose is not read as code. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * The allowed set, read from the migrations rather than retyped here, so this
 * test follows the schema instead of asserting a memory of it.
 */
function allowedOutcomes() {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
  let allowed = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    // Both the CREATE TABLE form and any later ADD CONSTRAINT that replaces it.
    for (const m of sql.matchAll(/outcome[^,;]*?CHECK\s*\(\s*outcome\s+IN\s*\(([^)]*)\)/gi)) {
      allowed = new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
    }
    for (const m of sql.matchAll(/ai_actions_outcome_check[\s\S]{0,200}?outcome\s+IN\s*\(([^)]*)\)/gi)) {
      allowed = new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
    }
    if (/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+ai_actions_outcome_check\s*;/i.test(sql)
        && !/ADD\s+CONSTRAINT\s+ai_actions_outcome_check/i.test(sql)) {
      allowed = null; // the constraint was dropped and not replaced
    }
  }
  return allowed;
}

describe('every ai_actions.outcome we write is a value the CHECK allows', () => {
  const allowed = allowedOutcomes();

  it('finds the CHECK in the migrations at all', () => {
    // If this fails, the constraint was dropped or reworded and the scan below
    // is measuring nothing. Better to fail here than to pass vacuously.
    expect(allowed, 'no ai_actions outcome CHECK found in supabase/migrations').toBeTruthy();
    expect([...allowed].sort()).toEqual(['escalated', 'failed', 'pending', 'success']);
  });

  it('writes no outcome value the database will reject', () => {
    const offenders = [];

    for (const file of walk(SRC)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/\boutcome\s*:\s*'([^']+)'/g)) {
        if (allowed.has(m[1])) continue;
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${file.replace(SRC, 'src/')}:${line}  outcome: '${m[1]}'`);
      }
    }

    expect(offenders, [
      'These inserts will be rejected with 23514 and swallowed by their own',
      `catch. ai_actions.outcome allows only: ${[...allowed].sort().join(', ')}.`,
      'A rejected audit row is worse than no audit row, because the code',
      'reads as though somebody would find out.',
      '',
      ...offenders,
    ].join('\n')).toEqual([]);
  });
});
