/**
 * A Supabase query builder has no `.catch()`.
 *
 * Ellie sent Shauna the consultation form. The text arrived — she found it in
 * the message history. The app told her "Could not send the form just now. Try
 * again in a moment." So she sent it again.
 *
 * The line that did it, in sendConsultationFormSMS, was this, and its own
 * comment is the whole story:
 *
 *     await supabase.from('messages').insert({ ... }).catch(() => {});  // non-fatal
 *
 * @supabase/postgrest-js's PostgrestBuilder implements `then()` and nothing
 * else — no `catch`, no `finally` (PostgrestBuilder.ts:113, :307). It is a
 * thenable, not a Promise. So `.catch` is `undefined`, calling it throws
 * TypeError synchronously, and it throws AFTER the form record is written and
 * AFTER the SMS has gone. The route's catch turns that into a 500 and the
 * sheet says it failed.
 *
 * Two things worth separating. `.catch` on a builder is a TypeError — loud,
 * and what bit her. `.catch` on an AWAITED builder would be a different and
 * quieter bug: PostgREST reports failures by RESOLVING with `{ error }` rather
 * than rejecting, so a handler attached there would never run either way.
 * Both are pinned below.
 *
 * This is a two-line fix and a class of bug, so the test is about the class.
 */
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient('https://stub.supabase.co', 'anon-key-not-used');

describe('the shape of a Supabase query builder', () => {
  it('is a thenable, not a Promise — there is no catch on it', () => {
    const builder = supabase.from('messages').insert({ id: 1 });

    expect(typeof builder.then).toBe('function');
    // The assertion the bug is made of.
    expect(builder.catch).toBeUndefined();
    expect(builder.finally).toBeUndefined();
    expect(builder).not.toBeInstanceOf(Promise);
  });

  it('so calling .catch on one throws, and throws where the damage is done', () => {
    const builder = supabase.from('messages').insert({ id: 1 });

    // Synchronous. Not a rejected promise a caller might handle — a TypeError
    // thrown on the spot, which unwinds straight past the "non-fatal" comment
    // and out of the function, after the SMS has already left.
    expect(() => builder.catch(() => {})).toThrow(TypeError);
  });

  it('and awaiting it first does not help, because a failure resolves', async () => {
    // Not a live call — the point is the SHAPE of what await gives back. A
    // PostgREST failure comes back as a value with an `error` on it, so
    // .catch() on the awaited result is dead code even where it parses.
    const settled = { data: null, error: { message: 'column does not exist' } };
    expect(settled.error).toBeTruthy();
    // Which is why every write worth checking has to read `error`, and the
    // ones that genuinely do not care must say so with a comment rather than
    // with a `.catch` that does nothing.
    expect(Object.prototype.hasOwnProperty.call(settled, 'error')).toBe(true);
  });
});

describe('no builder in the tree calls .catch', () => {
  it('has none left', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const SRC = new URL('../../src/', import.meta.url).pathname;

    const files = [];
    (function walk(dir) {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e.endsWith('.js')) files.push(p);
      }
    })(SRC);

    // A builder chain ending in .catch, on one statement. Matched across
    // newlines because the chains in this codebase are formatted one call per
    // line, which is how the booking.js one hid for so long.
    const offenders = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const re = /supabase(?:Admin)?\s*\.from\(([\s\S]{0,600}?)\.catch\(/g;
      let m;
      while ((m = re.exec(src))) {
        // Only when nothing between ends the statement. Braces do NOT
        // disqualify — an insert's payload is an object literal, so excluding
        // `}` was why a first version of this test passed while both real
        // offenders were still sitting in the tree.
        if (/;/.test(m[1])) continue;
        offenders.push(`${f.slice(SRC.length)}: ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
