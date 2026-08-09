# Clients — redesign plan

Measured on a 390×844 phone against the built app, not read off the source.
`node scripts/shoot-live.mjs /clients` for the picture; the numbers below come
from a probe of the live DOM.

---

## What the page is for

Ellie opens Clients for one of two reasons:

1. **To find one person.** Someone's just messaged, or is about to walk in.
2. **To notice someone.** Who hasn't been in for a while. Who's worth a nudge.

It is not a database table, and today it is laid out like one.

---

## What's actually wrong

### 1. A third of the screen before the first client

Chrome ends at **y=282 of 844**. Take off the floating nav (~96px) and the list
gets **466px — 55% of the phone**, about six rows. To find a client she scrolls
past: a title, three buttons, a search box, five filter chips on three lines,
and a sort pill.

The three lines of chips are the expensive part, and two of the three buttons up
top are ones she almost never presses.

### 2. The filter chips overlap each other's tap targets

Chips are 32px tall at a 38px pitch. Their 44px accessible tap bands overlap by
**6px vertically across 23–61px horizontally**. Measured pairs:

```
All      <-> Cooling    6px × 52px
Active   <-> Cooling    6px × 23px
Active   <-> Dormant    6px × 44px
Cooling  <-> New        6px × 61px
```

Tapping near the top of "Cooling" lands on "All". This is a real
mis-tap, not a theoretical one, and it exists *because* the chips wrap — a
single row cannot have vertical neighbours.

### 3. Every chip carries a count, including zero

`All 0 · Active 0 · Cooling 0 · Dormant 0 · New 0`. Five labels competing with
five numbers, and the number is only interesting when it is not zero and not
"all of them".

### 4. The tag chips are unreadable, and no check can catch them

`Clients.jsx:751` paints tag text in the tag's **own colour** on a 16% wash of
**that same colour**. Measured against the eight colours the tag picker offers:

| colour    | ratio  |             |
|-----------|--------|-------------|
| `#FFC107` | 1.48:1 | invisible   |
| `#FF9800` | 1.86:1 | fails       |
| `#03A9F4` | 2.20:1 | fails       |
| `#F44336` | 2.92:1 | fails       |
| `#B9466D` | 3.97:1 | fails       |
| `#6b6b6b` | 4.24:1 | fails       |
| `#306F33` | 4.73:1 | passes      |
| `#9C27B0` | 4.78:1 | passes      |

**Six of eight fail.** `check-swatches` cannot see it and neither can
`check-live` on a normal run, because the colour arrives from the database at
runtime — it is not a literal anywhere in the source. This is the one defect on
the page that will keep coming back on its own.

### 5. The row says nothing she can act on

Today: an initial, a name, and `3 visits · Last: 12 Jul`.

Neither number answers either of her two questions. "3 visits" is trivia. "Last:
12 Jul" is the raw fact underneath the question she actually has, which is *is
this someone I should be chasing?*

### 6. Select and Export sit in the best real estate on the page

Both are rare. Both are in the top-right, where the thumb naturally goes, next
to the one button that is not rare.

---

## The redesign

### Phase 1 — subtraction (half a day, no new data)

Everything here is removing or rearranging what already exists.

**Header → one row.**
`Clients` and a single `+ Add`. `Select` and `Export` move behind a `⋯` that
opens a small sheet. Reclaims a full row and makes `+ Add` unambiguous.

**Filters → one horizontally scrolling rail.**
All five chips on one line that scrolls sideways under the search box. This is
the fix for the overlap as much as for the height: one row has no vertical
neighbours, so the 44px bands cannot collide. `Sort` becomes an icon button
pinned to the right of the rail, outside the scroll.

Saves two rows. Chrome drops from **282px to about 200px** — the list goes from
six rows visible to eight.

**Counts only where they mean something.**
Drop the count on `All`; drop it anywhere it is zero. A chip reading `Dormant 4`
is information. `Dormant 0` is furniture.

**Tag chips → a dot and neutral text.**
An 8px filled circle in the tag's colour, then the tag name in
`var(--text-secondary)`. The colour still identifies the tag; nothing depends on
that colour being readable. Permanently immune, and one line of change.

Then add a **build-time check on the picker palette** — every colour it offers,
graded against the surfaces it is used on — so the next colour added to the list
is graded before it ships. This is the piece that stops it recurring.

### Phase 2 — make the row worth its height (about a day)

The list query gains two joins: the client's **next appointment** and their
**total spend**. Both already exist elsewhere in the app.

The row becomes name, one **state line**, and money:

```
  ●  Priya K                                    £360
     In 2 days · Lash lift & tint
─────────────────────────────────────────────────────
  ●  Sarah M                                    £128
     Last in 12 Jul · usually rebooks every 6 weeks
─────────────────────────────────────────────────────
  ●  Jo Whitfield-Barrowman                     £940
     Not been in since March
```

The state line answers the question rather than handing over the raw fact:

- booked → `In 2 days · Lash lift & tint`
- recent, on rhythm → `Last in 12 Jul · usually rebooks every 6 weeks`
- overdue against her own rhythm → `Not been in since March`
- brand new → `New — first visit Tuesday`

The avatar keeps the initial and gains a **ring** in the client's tag colour, so
the tag is legible at a glance without a second chip.

Money right-aligned and tabular, as everywhere else in the app.

### Phase 3 — let Florrie do the noticing

**A "Slipping away" section**, pinned above the list when anyone is overdue
against their own rhythm, with a one-tap nudge. This is the reason to open the
page rather than search. It is also the only part of this plan that is
Florrie doing something rather than Ellie reading something.

**Virtualise the list** past ~200 clients. Every row renders today.

---

## Order and cost

| | what | cost | risk |
|---|---|---|---|
| 1 | header, filter rail, counts, tag chips, palette check | half a day | low — subtraction only |
| 2 | the row rewrite + two joins | ~a day | medium — touches the list query |
| 3 | slipping-away section, virtualisation | ~a day | medium |

Phase 1 fixes the mis-tap and the unreadable tags and buys back two rows of
screen. If only one phase happens, it should be that one.

---

## What I am not proposing

- Not changing the client detail sheet. Levi has not complained about it and I
  have not measured it.
- Not adding avatars/photos. More network, more layout, no answer to either
  question.
- Not merging Clients into Today. They are different questions.
