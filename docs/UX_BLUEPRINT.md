# Florrie Mobile UX Blueprint
Build-ready redesign spec (research-backed). iOS-first React PWA in Capacitor.
Brand: cream #fef8f4, maroon #92405e, Playfair/Noto Serif display, Plus Jakarta Sans/DM Sans body.
Fixed 5-tab bottom nav (Today, Inbox, Florrie centre petal, Content, Money) + home-indicator inset.

## Root cause of "buttons get covered / headers overlap"
1. Scroll containers don't reserve the fixed-nav height -> last items slide under it.
2. safe-area insets only resolve with viewport-fit=cover (we have it) AND must be applied in the scroller + nav.
3. Multiple top-corner elements (global Floating Back/More + a page's own header) claim the same corner -> overlap. ONE header owner per screen.

## P0 checklist (ship-blockers)
- Every scroll region ends with padding-bottom >= nav-height + safe-bottom + 16.
- Bottom nav pads itself by env(safe-area-inset-bottom).
- Exactly ONE header per screen owns the top inset; no second top-corner element.
- No primary action hidden behind nav at any scroll position.
- Sheet footers sit above keyboard + home indicator, at z above the nav.
## P1
- Tap targets >= 44x44 (pad hit area, don't shrink touch zone). 8px min gap.
- Primary action reachable in bottom third (sticky footer or centre petal).
- All spacing/radius/type/colour from tokens; no raw hex.
- One button hierarchy, one card style, one elevation ramp.

## Tokens
Spacing (4pt base): 4,8,12,16(base),20,24,32,40,48,64
Radius: xs6, sm10, md16(cards), lg22(sheets), xl28(hero), pill999
Type: DisplayL 32/600 Playfair; DisplayM 26/600; Title 20/600 Jakarta; BodyL 17/400; Body 15/400; Caption 13/500; Micro 11/600
Tap: min44, comfort48, gap8, icon 44 hit / 24 glyph
Elevation (warm, low): e1 0 1px 2px rgba(92,40,46,.06); e2 0 4px 16px rgba(92,40,46,.08); e3 0 -8px 32px rgba(92,40,46,.12)
Z-layers: base0, sticky-cta20, header30, bottom-nav40, scrim50, sheet60, toast70
Layout: nav-height 56, header-height 52, scroll-pad-bottom = nav+safe-bottom+16
Motion: fast140, base220, slow320; ease-out cubic-bezier(.22,1,.36,1)

## Bottom sheets
Transient/contextual only (never page replacement, never stacked). Grab handle + explicit X.
Top corners lg(22). Sticky footer padding-bottom max(16, safe-bottom). Sheet z(60) above nav(40).
Keyboard: sheet rises, footer CTA pinned above keyboard. Back gesture dismisses.

## Bottom nav
5 tabs max (we're at ceiling). 56 + safe-bottom. Hairline top border, no heavy shadow.
Centre petal = raised circular primary action (~56-60, maroon, lifted ~8px, e2). Badges in accent maroon, cap 9+.

## 10 do/don'ts (Florrie-specific)
1 One primary action per screen, bottom third. Don't bury Save/Complete/Send top-right.
2 Reserve scroll-pad-bottom on every scroller (it's a token, not a judgement call).
3 One header owns the top inset; merge title + actions; kill duplicate corner buttons.
4 Sheets for quick tasks; push a full page for multi-step. Never stack sheets.
5 Money figure is the loudest thing on Money tab (DisplayL Playfair maroon).
6 Pad icon-only controls to 44 hit area even if glyph is 24.
7 Centre petal = lifted unmistakable primary action, not a flat 5th tab.
8 Warm maroon-tinted shadows + hairline borders on cream; never grey Material shadows.
9 Calm motion 200-280ms; subtle haptics on complete/money. No bounce/parallax.
10 Every value from tokens; delete raw hex, don't add more.

## Competitor teardown (borrow)
- GlossGenius: the craft bar to clear - editorial, Instagram-worthy receipts/checkout; ruthless feature restraint.
- Fresha: frictionless book/modify/cancel loop, instant calendar sync, minimal-step funnel.
- Booksy: Express Booking fast path for known/repeat clients -> maps to our known-client + rebook engine.
- Treatwell (contrast): marketplace lead-gen, weak ownership - we keep the pro owning the relationship.
- Acuity (cautionary): drag-to-reschedule + contact-from-anywhere good; but slow loads + unreliable reminders lose trust -> Florrie must be fast (skeletons over spinners) and visibly reliable.
Cross-cutting: premium money/checkout surface; fewest-tap booking; fast path for repeat clients.
