# Florrie Component Style Spec (apply across screens, with UX_BLUEPRINT.md)
React inline-style objects. Cream #fef8f4, accent #92405e (var --accent), Playfair display (var --font-display), Plus Jakarta body (var --font-body). Warm maroon-tinted shadows only, never grey. Tokens in index.css :root (--space-*, --radius-*, --tap-min/comfort, --elev-1/2/3).

CARD: bg #fff, radius var(--radius-md)16, border 1px rgba(146,64,94,.10), shadow var(--elev-1), padding 20, gap 12.
CARD HERO: bg linear-gradient(160deg,#fff,#fdf1ea), radius 22, border rgba(146,64,94,.14), shadow var(--elev-2), padding 24.
BTN PRIMARY: filled var(--accent), #fff, radius 999, minHeight 48, fontSize 17/600, shadow 0 4px 14px rgba(146,64,94,.28).
BTN SECONDARY: transparent, color accent, border 1.5px rgba(146,64,94,.35).
BTN GHOST: transparent, color accent, minHeight 44.
ICON BTN: 44x44 hit area, 24px glyph, bg rgba(146,64,94,.06) or transparent.
LIST ROW: minHeight 48, padding 12 16, gap 12. avatar 40 round bg rgba(146,64,94,.10) Playfair. title 15/600 #2b1d22, subtitle 13/400 #6e5a60, trailing 15/600. divider 1px rgba(146,64,94,.10) inset under text.
SCREEN TITLE: Playfair 26/600 #2b1d22. SECTION HEADER: Playfair 20/600. EYEBROW: Jakarta 11/600 uppercase ls .08em accent.
HERO FIGURE (money): Playfair 32-40/600 var(--accent), letterSpacing -.02em, tabular-nums. label 13/500 uppercase #9a8a8f.
FILTER PILL: 13/500 minHeight 44 padding 0 16 radius 999 border rgba(146,64,94,.18). active: bg accent #fff.
STATUS PILL: 11/600 uppercase padding 4 8 radius 999, soft tint (confirmed green / pending amber / cancelled red / neutral maroon).
COUNT BADGE: 11/600 minWidth 18 h18 radius 999 bg accent #fff.
INPUT: fontSize 17 (no iOS zoom), minHeight 48, padding 0 16, border 1.5px rgba(146,64,94,.16) radius 10. focus: border accent + 0 0 0 3px rgba(146,64,94,.10). label 13/600 #6e5a60.
EMPTY STATE: centered, icon 64 round tint, title Playfair 20, subtitle 15 #6e5a60, one CTA max.
BOTTOM SHEET: scrim rgba(43,29,34,.40); sheet bg #fef8f4 radius-top 22 shadow --elev-3 maxHeight 92vh; handle 36x5 rgba(146,64,94,.20); sticky footer paddingBottom calc(16 + safe-bottom).
TEXT COLORS: primary #2b1d22 (never #000), subtitle #6e5a60, meta #9a8a8f.
DO: maroon shadows only; Playfair for titles+money, Jakarta for body/taps; one primary per screen; 44px hit areas; tabular-nums on changing numbers.
