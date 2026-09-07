# Florrie brief and shared interactions

The brief now separates next steps, connected roles and learning into three views. Today places a compact, expandable team widget above the diary. Its work records come from the existing light status endpoint. Switching brief views reuses the same response, and missing evidence stays unavailable.

The app uses three actual MIT packages listed on [Libraries.dev](https://libraries.dev/), pinned in the workspace lockfile:

- `thinking-orbs` 0.3.1: the Florrie avatar, route and button loading, voice listening and processing, caption generation, and message sending.
- `border-beam` 1.3.0: focused shared inputs and composers, plus actual pending work.
- `liquid-gooey` 0.2.1: the shared navigation dock, Today, Content and brief view selection.

[Harshil Tomar’s design reference](https://x.com/hartdrawss/status/2096841131338150047) informed the shared type sizes, spacing, softer surfaces, consistent radii and semantic colour tokens. Florrie keeps its plum palette and existing fonts. Shared cards, headers, buttons and inputs carry these rules into the other pages; this is not a claim that every bespoke screen has been rebuilt.

## Runtime behaviour

Effects load in separate chunks when visible. Offscreen effects pause or unmount; reduced-motion users get paused orbs and static selection. Motion is decorative. The working and listening states follow real UI requests and recording state, rather than inventing agent activity.

Decoration errors have local boundaries. Inputs and buttons sit outside those boundaries and retain their DOM nodes, drafts and handlers if an effect cannot load. All decoration layers ignore pointer events. Tab labels remain readable while their highlight travels.

Today’s diary does not await the team status request. The brief discards responses from a previous account. Authentication, payment, subscription, treatment records, message permissions and posting logic are unchanged.

## Verification

- Production frontend build and lockfile checks passed.
- All 82 populated screens passed light contrast, overflow and numeral checks.
- The More suite passed, including page failure/retry checks and Voice, Content and Inbox layouts at 320, 390 and 1024 pixels.
- Today’s slow-count, diary timeout and retry checks passed.
- Intelligence checks passed for partial evidence, permission visibility, failed dismissal/retry, unknown role status, account isolation, and editable voice handoff.
- The real library chunks were exercised in Chromium and WebKit: visible canvas and SVG surface, stable draft input, one synthetic voice command, working indicator completion, reduced motion and aborted-effect fallback.
- Screenshots use fictional test data. No client message, booking or public post was created during verification.

Release results are recorded in the deployment handoff after completion. Browser verification does not replace a physical iPhone check.
