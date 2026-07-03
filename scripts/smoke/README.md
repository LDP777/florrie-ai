# Florrie smoke suite

`florrie_smoke.js` runs in a logged-in florrie.ai browser tab (paste into the
console, or execute via browser automation). Read-only apart from one block
roundtrip on 2030-01-15 that deletes itself. Run it before and after any
session that touches booking, blocks, money or the public page.

Alongside the API suite, sweep these pages at 390px and check the console for
errors and blank screens: /today, /calendar/week, /book/ellindigo, /money,
/inbox, /settings.
