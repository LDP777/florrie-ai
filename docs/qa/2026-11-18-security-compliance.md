# Security corrections, 18 November 2026

The audit found seven database policies named for the service role that instead applied to PUBLIC. Their unrestricted INSERT checks admitted writes to internal records. The migration restricts those policies to `service_role`, pins the search path of six functions, and removes client execution of internal usage counters and trigger functions. It preserves the identity helper used by owner policies.

The migration was applied to the production Supabase project and checked after application. Existing owner policies and backend workers retain access. No customer records were changed. A read-only authenticated check confirmed access to the current salon profile and exclusion of other salons' clients and appointments. This is a targeted check, not a complete penetration test or evidence that no historic misuse occurred.

## Verification

- PGlite reproduces an unauthorised INSERT with fictional records before applying the migration. After applying it twice, anonymous/authenticated internal writes fail, owners can read their own rows, other-salon reads/updates/deletes fail, and service workers and triggers continue to work.
- Live policy roles and function privileges match the migration. The database advisor no longer reports the six mutable function search paths. The public identity helper remains intentional; the extension-in-public and leaked-password-protection warnings still need action.
- Production dependency upgrades cover Express 4.22.3, body-parser 1.20.9, proxy-addr 2.0.8, qs 6.16.2, DOMPurify 3.4.18, brace-expansion 1.1.22/2.1.8 and Zod 4.6.7. Both root and backend standalone lockfiles were updated in place. The runtime dependency audits report zero known vulnerabilities on this date.
- Zod's migration preserves validation responses and messages. Tests cover booking defaults, consent omission, anti-bot token preservation and bounded collection rejection. The old timezone test used a non-RFC UUID; its fixture now uses a valid v4 UUID. A production aggregate check found no invalid variant/version IDs in treatments, clients, appointments or courses.
- Production logging now redacts structured email/password/token/cookie and client fields through three nested envelopes. A subprocess test checks the actual production logger output. Arbitrary free-text log messages still require caller discipline.
- The privacy notice now includes receiving and replying through a salon's Florrie email address via Resend.
- Full backend suite: 245 files, 4,380 tests passed. Full project build passed, including the existing platform lockfile, Node and frontend checks.
- The first CI browser run crossed into morning and the normal catch-up dialog blocked the thoughtful-suggestion test. The test now fixes the clock and dismisses that dialog with its visible control. All seven suggestion scenarios pass locally. No production Today/appointment/Commander layout was changed.

## Remaining work

The full audit, including development dependencies, initially reported 19 affected packages. Compatible updates to Vite 6.4.6, Vitest 4.1.12, fast-uri 3.1.9, source-map-js 1.2.2 and serialize-javascript 7.1.4 reduce that to 15 (11 high, 4 moderate), caused by the remaining picomatch/glob/minimatch advisories and their dependants. Runtime-only audits remain clear. This is not a clean full dependency audit. Picomatch's latest published version is still affected; npm also proposes incompatible native-toolchain upgrades or older tool versions. Do not apply those suggestions without compatibility work. Keep dev servers local, build trusted source, and plan a tested native/build dependency upgrade or verified upstream patches.

The audit does not certify legal compliance. Complete the salon processing agreement, health-data lawful-basis/consent evidence, AI risk assessment, supplier transfer records and retention/deletion inventory. Review consumer cancellation fees and actual Stripe portal/trial behaviour. Keep the previously held general AI-permission rollout on hold until the agreed timing.

Content drafts currently use public social-media storage. Move unapproved drafts to private storage with controlled publish access and file deletion. Extend deletion coverage to separate email/review/WhatsApp connection records, retained notes and derived records, then rehearse erasure with a dedicated fictional salon. These changes need integration testing before production rollout.

Sources: [ICO privacy information](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/what-privacy-information-should-we-provide/), [ICO processor contracts](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/contracts-and-liabilities-between-controllers-and-processors-multi/what-needs-to-be-included-in-the-contract/), [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [Zod migration guide](https://zod.dev/v4/changelog).
