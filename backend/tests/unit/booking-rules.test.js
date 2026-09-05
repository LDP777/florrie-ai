/**
 * The pure rules behind booking someone in over a conversation.
 *
 * Two things here are worth more than the rest put together:
 *   1. matchSlotChoice must NEVER return a slot that was not offered. It is
 *      the piece that turns "the 4 one" into a real appointment, and a wrong
 *      answer books a client into the wrong hour, which is the same class of
 *      harm as the 28 Jul incident.
 *   2. Anything formatWallTime prints must be a time the reply claims guard
 *      accepts straight back. If those two ever disagree, Florrie's own guard
 *      starts refusing times she genuinely verified.
 */
import { describe, it, expect } from 'vitest';
import {
  combineTreatments, resolveDepositCents, formatWallTime, formatWallDate,
  describeSlot, matchTreatment, dayPreferenceFrom, chooseOffers, matchSlotChoice,
  timeCandidates, isLive, looksLikeRejection,
} from '../../src/lib/booking-rules.js';
import { timesMentionedIn } from '../../src/lib/reply-claims-guard.js';

const slot = (date, time) => ({ iso: `${date}T${time}:00.000Z`, date, time });

// A Friday in BST, in the wall frame.
const FRI = new Date('2026-08-07T09:00:00.000Z');

describe('combineTreatments', () => {
  it('adds durations but takes the longest buffer', () => {
    const c = combineTreatments([
      { duration_minutes: 60, buffer_minutes: 10, price_cents: 4000 },
      { duration_minutes: 30, buffer_minutes: 15, price_cents: 1500 },
    ]);
    expect(c.durationMinutes).toBe(90);
    expect(c.bufferMinutes).toBe(15);
    expect(c.totalMinutes).toBe(105);
    expect(c.priceCents).toBe(5500);
  });

  it('copes with an empty list rather than returning -Infinity', () => {
    expect(combineTreatments([]).bufferMinutes).toBe(0);
  });
});

describe('resolveDepositCents', () => {
  it('prefers a percentage deposit over a flat one', () => {
    const cents = resolveDepositCents({
      treatments: [{ price_cents: 5000, deposit_cents: 1000, deposit_percent: 25 }],
    });
    expect(cents).toBe(1250);
  });

  // The salon fallback now needs the switch as well as the amount. The four
  // cases below used to pass without require_deposit, which is exactly how a
  // salon that had never opened the payments page ended up charging the
  // migration default of £10. deposit-switch-is-honoured.test.js covers the
  // switched-off side.
  it('falls back to the salon setting when the treatment has no deposit', () => {
    expect(resolveDepositCents({
      treatments: [{ price_cents: 4000, deposit_cents: 0, deposit_percent: 0 }],
      paymentSettings: { require_deposit: true, deposit_amount: '£15' },
    })).toBe(1500);
  });

  it('handles a percentage salon setting', () => {
    expect(resolveDepositCents({
      treatments: [{ price_cents: 4000 }],
      paymentSettings: { require_deposit: true, deposit_amount: '50%' },
    })).toBe(2000);
  });

  it('takes nothing when the salon has set nothing, rather than a default £10', () => {
    expect(resolveDepositCents({ treatments: [{ price_cents: 4000 }] })).toBe(0);
  });

  it('never charges more than the treatment costs', () => {
    expect(resolveDepositCents({
      treatments: [{ price_cents: 800, deposit_cents: 5000 }],
    })).toBe(800);
  });

  it('survives a numeric deposit_amount, which the original threw on', () => {
    expect(resolveDepositCents({
      treatments: [{ price_cents: 4000 }],
      paymentSettings: { require_deposit: true, deposit_amount: 20 },
    })).toBe(2000);
  });

  it('takes nothing for a free treatment', () => {
    expect(resolveDepositCents({ treatments: [{ price_cents: 0 }] })).toBe(0);
  });
});

describe('formatWallTime', () => {
  it('speaks a salon time the way a person would', () => {
    expect(formatWallTime('15:30')).toBe('3.30pm');
    expect(formatWallTime('16:00')).toBe('4pm');
    expect(formatWallTime('09:15')).toBe('9.15am');
    expect(formatWallTime('12:00')).toBe('12pm');
    expect(formatWallTime('19:00')).toBe('7pm');
  });

  it('round trips through the reply claims guard for every salon quarter hour', () => {
    // THE CONTRACT. Florrie is only allowed to name times from the verified
    // list, and the guard checks that by normalising what she wrote. If a
    // phrasing here does not normalise back to the slot it came from, a
    // genuinely free time gets refused on the way out and the client is told
    // nothing at all. Whole opening hours, both sides of noon.
    for (let h = 7; h <= 21; h++) {
      for (const m of ['00', '15', '30', '45']) {
        const hhmm = `${String(h).padStart(2, '0')}:${m}`;
        expect(timesMentionedIn(formatWallTime(hhmm))).toEqual([hhmm]);
      }
    }
  });
});

describe('formatWallDate', () => {
  it('reads the wall date with no timezone conversion', () => {
    // A BST date. Anything that Intl-converted would slide to the 6th.
    expect(formatWallDate('2026-08-07')).toBe('Friday 7 August');
  });

  it('prefers today and tomorrow when they apply', () => {
    expect(formatWallDate('2026-08-07', '2026-08-07')).toBe('today');
    expect(formatWallDate('2026-08-08', '2026-08-07')).toBe('tomorrow');
    expect(formatWallDate('2026-08-09', '2026-08-07')).toBe('Sunday 9 August');
  });

  it('crosses a month end', () => {
    expect(formatWallDate('2026-09-01', '2026-08-31')).toBe('tomorrow');
  });

  it('describes a slot as a whole phrase', () => {
    expect(describeSlot(slot('2026-08-07', '15:30'))).toBe('Friday 7 August at 3.30pm');
  });
});

describe('matchTreatment', () => {
  const MENU = [
    { id: 'a', name: 'Classic Lash Extensions' },
    { id: 'b', name: 'Hybrid Lash Extensions' },
    { id: 'c', name: 'Lash Lift' },
    { id: 'd', name: 'Brow Lamination' },
  ];

  it('asks when "lashes" could be three different treatments', () => {
    const m = matchTreatment('any chance of lashes friday?', MENU);
    expect(m.ambiguous).toBe(true);
    expect(m.treatment).toBeUndefined();
    expect(m.candidates.map(t => t.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('resolves when she names one', () => {
    expect(matchTreatment('can I have a hybrid lash set please', MENU).treatment.id).toBe('b');
  });

  it('handles the plural and the singular alike', () => {
    expect(matchTreatment('brows please', MENU).treatment.id).toBe('d');
  });

  it('returns nothing rather than guessing at an unrelated message', () => {
    const m = matchTreatment('are you open on bank holidays?', MENU);
    expect(m.treatment).toBeUndefined();
    expect(m.ambiguous).toBe(false);
  });

  // Ellie's actual brow menu, as it stood on 4 September 2026, when a new
  // client asking for "the lamination + hybrid dye" was offered the
  // maintenance version. Her words: "It was going so well until it said brow
  // lamination maintenance when she asked for brow lamination and hybrid dye".
  const ELLIE = [
    { id: 'full-stain', name: 'Brow Lamination & Hybrid stain' },
    { id: 'full-tint', name: 'Brow Lamination & tint' },
    { id: 'maint-stain', name: 'Brow lamination maintenance - Hybrid dye' },
    { id: 'maint-tint', name: 'Brow lamination maintenance - Tint' },
    { id: 'wax', name: 'Brow wax' },
  ];

  it('never offers maintenance to somebody who did not ask for it', () => {
    expect(matchTreatment("I'd like to book for the lamination + hybrid dye x", ELLIE).treatment.id).toBe('full-stain');
    expect(matchTreatment('brow lamination and tint please', ELLIE).treatment.id).toBe('full-tint');
  });

  it('reads dye and stain as the same thing, and tint as a different one', () => {
    expect(matchTreatment('lamination with hybrid stain', ELLIE).treatment.id).toBe('full-stain');
    expect(matchTreatment('lami and hybrid dye', ELLIE).treatment.id).toBe('full-stain');
    const m = matchTreatment('lamination please', ELLIE);
    expect(m.ambiguous).toBe(true);
    expect(m.candidates.map(t => t.id).sort()).toEqual(['full-stain', 'full-tint']);
  });

  it('offers maintenance when she says so', () => {
    expect(matchTreatment('lamination maintenance with hybrid dye', ELLIE).treatment.id).toBe('maint-stain');
    expect(matchTreatment('can I book a lamination top up and tint', ELLIE).treatment.id).toBe('maint-tint');
    const m = matchTreatment('lamination maintenance', ELLIE);
    expect(m.ambiguous).toBe(true);
    expect(m.candidates.map(t => t.id).sort()).toEqual(['maint-stain', 'maint-tint']);
  });

  it('still matches a menu that only lists the maintenance version', () => {
    const ONLY = [{ id: 'infill', name: 'Lash infills' }, { id: 'brow', name: 'Brow wax' }];
    expect(matchTreatment('lashes on friday?', ONLY).treatment.id).toBe('infill');
  });
});

describe('dayPreferenceFrom', () => {
  it('reads a weekday as the next one, today included', () => {
    // FRI is itself a Friday.
    expect(dayPreferenceFrom('any chance friday?', FRI)).toEqual(['2026-08-07']);
    expect(dayPreferenceFrom('how about monday', FRI)).toEqual(['2026-08-10']);
  });

  it('handles today and tomorrow in the salon frame', () => {
    expect(dayPreferenceFrom('anything today?', FRI)).toEqual(['2026-08-07']);
    expect(dayPreferenceFrom('tomorrow works', FRI)).toEqual(['2026-08-08']);
  });

  it('pushes next week out by seven days', () => {
    expect(dayPreferenceFrom('friday next week', FRI)).toEqual(['2026-08-14']);
  });

  it('reads a day of the month', () => {
    expect(dayPreferenceFrom('the 13th if you have it', FRI)).toEqual(['2026-08-13']);
  });

  it('returns null when no day was named', () => {
    expect(dayPreferenceFrom('whenever suits you', FRI)).toBeNull();
  });
});

describe('chooseOffers', () => {
  const day = (date, times) => times.map(t => slot(date, t));

  it('spreads across one day rather than offering three in a row', () => {
    const slots = day('2026-08-07', ['09:00', '09:15', '09:30', '12:00', '15:30', '16:00', '19:00']);
    const { offers } = chooseOffers(slots, { max: 3 });
    expect(offers.map(o => o.time)).toEqual(['09:00', '12:00', '19:00']);
  });

  it('never offers more than asked for', () => {
    const slots = day('2026-08-07', ['09:00', '09:15', '09:30', '09:45']);
    expect(chooseOffers(slots, { max: 3 }).offers).toHaveLength(3);
  });

  it('narrows to the day she asked for', () => {
    const slots = [...day('2026-08-06', ['10:00']), ...day('2026-08-07', ['15:30', '16:00'])];
    const { offers, narrowedToRequestedDays } = chooseOffers(slots, { dates: ['2026-08-07'], max: 3 });
    expect(narrowedToRequestedDays).toBe(true);
    expect(offers.every(o => o.date === '2026-08-07')).toBe(true);
  });

  it('says so when the day she asked for has nothing, rather than pretending', () => {
    const slots = day('2026-08-06', ['10:00', '14:00']);
    const { offers, narrowedToRequestedDays } = chooseOffers(slots, { dates: ['2026-08-07'], max: 3 });
    expect(narrowedToRequestedDays).toBe(false);
    expect(offers.length).toBeGreaterThan(0);
  });

  it('offers nothing from an empty diary', () => {
    expect(chooseOffers([], { max: 3 }).offers).toEqual([]);
  });
});

describe('timeCandidates', () => {
  it('reads a bare afternoon number the way a salon client means it', () => {
    expect(timeCandidates('the 4 one')).toEqual(['16:00']);
  });

  it('does not re-read "half 3" as a bare 3', () => {
    expect(timeCandidates('friday at half 3')).toEqual(['15:30']);
  });

  it('understands spoken times', () => {
    expect(timeCandidates('half four please')).toEqual(['16:30']);
    expect(timeCandidates('quarter to five')).toEqual(['16:45']);
    expect(timeCandidates('quarter past ten')).toEqual(['10:15']);
  });

  it('ignores a date ordinal', () => {
    expect(timeCandidates('friday the 13th')).toEqual([]);
  });

  it('keeps am and pm honest', () => {
    expect(timeCandidates('10am works')).toEqual(['10:00']);
    expect(timeCandidates('4:30pm')).toEqual(['16:30']);
  });
});

describe('matchSlotChoice', () => {
  const OFFERED = [slot('2026-08-07', '15:30'), slot('2026-08-07', '16:00'), slot('2026-08-07', '19:00')];

  it('resolves "the 4 one"', () => {
    expect(matchSlotChoice('the 4 one please', OFFERED, { fromWall: FRI }).slot.time).toBe('16:00');
  });

  it('resolves "friday at half 3"', () => {
    expect(matchSlotChoice('friday at half 3', OFFERED, { fromWall: FRI }).slot.time).toBe('15:30');
  });

  it('resolves "the last one"', () => {
    expect(matchSlotChoice('the last one', OFFERED, { fromWall: FRI }).slot.time).toBe('19:00');
  });

  it('resolves an ordinal position', () => {
    expect(matchSlotChoice('second one please', OFFERED, { fromWall: FRI }).slot.time).toBe('16:00');
  });

  it('resolves a plain "7pm"', () => {
    expect(matchSlotChoice('7pm', OFFERED, { fromWall: FRI }).slot.time).toBe('19:00');
  });

  it('NEVER returns a slot that was not offered', () => {
    // The whole point. 5pm was never on the list, so this is a new request,
    // not a choice, and it must not be rounded to the nearest thing offered.
    const r = matchSlotChoice('can I do 5pm instead', OFFERED, { fromWall: FRI });
    expect(r.slot).toBeUndefined();
    expect(r.unclear).toBe(true);
  });

  it('asks rather than guessing when two offers fit what she said', () => {
    const twoDays = [slot('2026-08-06', '16:00'), slot('2026-08-07', '16:00')];
    const r = matchSlotChoice('the 4 one', twoDays, { fromWall: FRI });
    expect(r.ambiguous).toBe(true);
    expect(r.candidates).toHaveLength(2);
  });

  it('narrows by day then by time', () => {
    const twoDays = [slot('2026-08-06', '16:00'), slot('2026-08-07', '16:00')];
    expect(matchSlotChoice('friday at 4', twoDays, { fromWall: FRI }).slot.date).toBe('2026-08-07');
  });

  it('treats a plain yes as a choice only when there is one thing to choose', () => {
    expect(matchSlotChoice('yes please', [OFFERED[0]], { fromWall: FRI }).slot.time).toBe('15:30');
    expect(matchSlotChoice('yes please', OFFERED, { fromWall: FRI }).unclear).toBe(true);
  });

  it('spots a rejection', () => {
    expect(matchSlotChoice('none of those work sorry', OFFERED, { fromWall: FRI }).rejected).toBe(true);
    expect(looksLikeRejection('anything later?')).toBe(true);
  });
});

describe('isLive', () => {
  const now = new Date('2026-08-07T10:00:00.000Z');

  it('keeps a fresh negotiation', () => {
    expect(isLive({ expires_at: '2026-08-07T11:00:00.000Z' }, now)).toBe(true);
  });

  it('drops last week, so an old offer cannot hijack a new hello', () => {
    expect(isLive({ expires_at: '2026-07-30T11:00:00.000Z' }, now)).toBe(false);
  });

  it('treats a missing row as dead', () => {
    expect(isLive(null, now)).toBe(false);
    expect(isLive({}, now)).toBe(false);
  });
});
