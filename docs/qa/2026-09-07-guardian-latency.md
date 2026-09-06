# Guardian upcoming checks

Production verification of build 732 found that templates and client records loaded, while upcoming checks timed out twice at the frontend's 15-second request limit. The backend health endpoint returned 200 in 0.64 seconds.

The alerts route awaited each client's evidence serially. It now reads evidence for up to six clients concurrently and assembles results in the original appointment order. Client identity, salon scope, reference date, evidence rules and reaction handling are unchanged.

Validation: 75 focused tests passed, including patch-test evidence and bounded concurrency/order. The wider suite passed 2,408 tests in 140 files with TZ=UTC. The disposable PostgreSQL test could not run locally because the existing dependency tree lacks PGlite; GitHub CI must run it before release is considered verified. Updated the consent-query inventory's line numbers after moving code; no consent exception was added.

Production improvement still requires timing the live upcoming-checks retry after deployment. This is a diagnosed serialization bottleneck, not yet a measured production speedup.
