/**
 * The things a hostile review found in the merged work, locked down.
 *
 * These were real defects in code that had already passed its own tests,
 * because they only appear when two features built separately meet.
 */
import { describe, it, expect } from 'vitest';
import { safeAsExample } from '../../src/lib/idiolect.js';

describe('style examples never carry someone else private business', () => {
  // These strings go verbatim into a prompt written for a DIFFERENT client.
  it('keeps an ordinary message about how she writes', () => {
    expect(safeAsExample('hey lovely, yes I can do friday at 4 xx')).toBe(true);
    expect(safeAsExample('aw thank you so much!! see you soon x')).toBe(true);
  });

  it('drops anything clinical', () => {
    expect(safeAsExample('your patch test came back fine, no reaction at all x')).toBe(false);
    expect(safeAsExample('are you still on the antibiotics hun?')).toBe(false);
    expect(safeAsExample('sorry your eyes were so swollen and sore after')).toBe(false);
  });

  it('drops anything that reaches outside the text', () => {
    expect(safeAsExample('give me a ring on 07700 900123 lovely')).toBe(false);
    expect(safeAsExample('pop it here www.florrie.ai/book x')).toBe(false);
    expect(safeAsExample('email me at ellie@ellindigo.co.uk')).toBe(false);
  });

  // A message naming a second person is about somebody who is not in the
  // conversation it would be quoted into.
  it('drops a message naming other people', () => {
    expect(safeAsExample('Sarah and Megan are both in before you that day')).toBe(false);
  });

  it('drops empty and whitespace', () => {
    expect(safeAsExample('')).toBe(false);
    expect(safeAsExample('   ')).toBe(false);
    expect(safeAsExample(null)).toBe(false);
  });
});
