# The nightly check

`.github/workflows/nightly-check.yml` runs at 03:00 UTC and can be started by hand
from the Actions tab. The checks themselves live in `scripts/nightly-check.mjs`,
so they can be read, run and tested without going near a runner. Their
judgements are unit tested in `backend/tests/unit/nightly-check-judgements.test.js`.

## Why it was rebuilt

The check this replaces filed GitHub issue #165 with six findings. Three of them
were false, one was true but misjudged, one was a description of the container
it ran in, and the single largest fact about this repository (it is public) was
not mentioned at all.

The worst of the six claimed the `recurring_expenses` migration might not have
been applied. Its entire evidence was a code comment, which is a legend for two
Postgres error codes sitting directly above the predicate it documents. The
table exists. The check could not tell a defensive branch from an assertion.
There is a second comment of exactly the same shape at
`backend/src/routes/knowledge.js` line 19.

So the new one is built to three rules.

1. **Never infer a deployment state from source code.** Not from a comment, not
   from a defensive branch, not from a fallback. A file on disk says what the
   code will do if it runs. It says nothing about the database, the CDN or the
   running process.
2. **"Not checked" is a result.** Every check can answer `not_checked` with a
   reason. A false alarm costs somebody an afternoon and costs the check its
   credibility permanently; a gap costs neither, as long as it is labelled.
3. **Only speak when there is something to say.** An issue every night is an
   issue nobody opens.

## What it checks

| Check | What it measures | How it can be wrong |
| --- | --- | --- |
| `api_*` | `GET https://api.florrie.ai/health/live` and `/health` for real, parsing the exact shape `backend/src/lib/health.js` returns | Cannot see anything `/health` does not check |
| `cron_stale` | Each cron by name out of `checks.crons.jobs`, not the word "crons" | Reports what the API believes about `job_runs` |
| `lock_manifest` | Does each tracked lockfile still describe the `package.json` beside it | None. Offline and exact |
| `lock_parity` | Does a workspace lockfile carry advisories the root lock does not, runtime or dev | Needs the npm registry |
| `lock_platform*` | The darwin binaries are still in the lockfiles | None |
| `audit_*` | `npm audit`, reporting only what CHANGED since last night | Needs the registry, and needs the state cache to have survived |
| `reachability` | Which routes have no inbound `to=`, `navigate(` or `href=` from anywhere | A link built entirely at runtime would be missed |
| `migration_ledger` | `supabase/migrations/*.sql` against the `schema_migrations` rows | Not checked at all without a database credential |
| `tracked_secrets` | Secret shaped strings in tracked files | Current tree only, never history |
| `guard_*` | Every `frontend/scripts/check-*.mjs` is still wired to something that runs it | None |
| `boot` | First contentful paint and bytes before paint, from `check:boot`, against last night | Not checked if the build failed |
| `suite` | The frontend build and the backend suite, run as their own workflow steps | None. They are the real gates |

## What it cannot check, and why

* **Anything about production without a credential.** The migration ledger needs
  a database. Without `NIGHTLY_DATABASE_URL` it says the ledger was not read and
  prints the SQL to create the role. It never guesses.
* **Anything `/health` does not already cover.** The API check reads what
  `runHealthChecks` returns. Adding a dependency to the report means adding it to
  `backend/src/lib/health.js` first.
* **Whether an unreachable page is wanted.** Reachability finds pages nothing
  links to. `frontend/src/pages/More.jsx` lines 123 to 139 record most of them as
  deliberately parked on 2026-06-10. That is a product decision, so the check
  reports and does not delete.
* **History.** The secret scan reads the current tree. A key committed and later
  removed is still in every clone anybody made.
* **Whether the Vercel Root Directory is still `frontend/`.** The lockfile
  finding cites `DEPLOY.md` line 415 as its evidence and says so. If that setting
  has changed, the finding is weaker than it reads and the evidence should be
  updated.

## Running it locally

```sh
node scripts/nightly-check.mjs
```

No arguments needed and no dependencies to install. Useful flags:

| Flag | Effect |
| --- | --- |
| `--require-network` | Treat an unreachable API as a failure. Only pass this where egress is known to work. The workflow passes it; a sandbox should not |
| `--state <path>` | Read and write the remembered advisory set and boot figures, so the run can say what changed |
| `--json <path>` | Write the machine readable report, including the rendered issue body |
| `--no-exit-code` | Always exit 0, for a caller that wants the report even after a failure |
| `--fix` | Apply the safe fixes and stop. Changes lockfiles and nothing else |

Reading the output, which follows the same convention as the guards in
`frontend/scripts/`:

```
✗ lock_parity: frontend/package-lock.json carries 7 advisory(ies) the root lock does not
- migration_ledger: the migration ledger was not read (not checked)
✓ tracked_secrets: no secret shaped strings in tracked files
```

* `✗` is a failing or warning finding. The detail is indented beneath it.
* `-` with `(not checked)` is a gap, with the reason for the gap. It never opens
  an issue and it is never a fault.
* `✓` is a note. Printed for the record, never spoken about.

The exit code is 1 when anything is failing and 0 otherwise, so it composes with
other scripts. Warnings do not change the exit code.

Without a network, the API check, the audit and the parity check all report
`not_checked` with the transport error quoted. That is the correct behaviour and
not a degraded mode: it is exactly what the old check got wrong.

## How it decides to speak

One issue, found by the `nightly-check` label, for the whole life of the check.

| Situation | What happens |
| --- | --- |
| Anything failing | Open the issue, or comment on it if it is already open |
| A warning that was not there last night | Same |
| The same warnings as last night, nothing failing | Nothing. The open issue is left exactly as it is |
| Nothing failing and no warnings at all | Close the issue |
| Only `not_checked` findings | Treated as all clear. A gap is not a fault |
| The check itself produced no report | Say so, and say that nothing was verified |

"New" is decided by a fingerprint of the finding's identity plus the facts that
define it, so twelve unreachable pages becoming thirteen counts as new, while the
same twelve for the fortieth night does not.

The state lives in an `actions/cache` entry keyed `nightly-state-<run id>`, restored
by the `nightly-state-` prefix. A cache miss is harmless: the run records a
baseline and says in the report that it did.

## What it fixes, and what it deliberately will not

Fixed automatically, as a pull request:

* **A workspace lockfile that no longer describes its own `package.json`**, with
  `npm install --package-lock-only` followed by `npm update --package-lock-only`.
* **A workspace lockfile that has fallen behind the root lock**, with
  `npm update --package-lock-only`.

Both are lockfile only. Neither touches a `package.json`, so neither can perform
a major version bump. Before the branch is pushed, the workflow proves it:

1. The platform matrix survived, or the change is reverted.
2. The lockfile still describes its manifest, or the change is reverted.
3. Advisory parity with the root lock is re-measured.
4. Each changed lockfile is **installed from on its own**, in a copy of the tree
   with the workspace root deleted. This is the only way to make npm read a
   workspace lockfile at all, and it reproduces what Vercel does with Root
   Directory `frontend/`.
5. The frontend build runs against that standalone install, and the backend suite
   against its own.
6. `scripts/check-lockfile.mjs`, the root build and the root suite all run too.

Never fixed automatically:

* **A major version bump.** `npm audit fix --force` would take `@capacitor/cli`
  from 6 to 8 and clear the critical `tar` advisory with it. That is a native
  migration needing a Mac with Xcode 26 and a coordinated iOS release, and a
  green unit suite would prove nothing about it. A confident pull request that
  the thing verifying it cannot actually verify is the worst outcome available.
* **Anything touching `supabase/migrations` or the ledger.** Applying DDL to
  production unattended is how you discover your rollback plan was a sentence in
  a document.
* **Anything that sends a message.** There is a real person at the other end of
  every WhatsApp, SMS and email this codebase can emit.
* **Deleting an unreachable page.** "Nothing links to it" is not "nobody wants
  it", and `More.jsx` explicitly records these as parked and kept.

**It never pushes to `main`.** A push to `main` here is a full ship: Vercel
deploys the frontend, Railway deploys the backend, Xcode Cloud builds to
TestFlight. The fix goes to the branch `nightly/lockfile-drift` and becomes a
pull request. The branch name is stable and force pushed, so a lockfile still
drifting a week later updates the same pull request rather than opening a
seventh one.

## Giving it database access, safely

The migration ledger check is off until somebody creates the credential, and it
says so in every report until then. Nothing about a database goes in this
repository, which is public.

Create a role that can do exactly one thing:

```sql
CREATE ROLE nightly_check LOGIN PASSWORD 'generate-something-long';
GRANT CONNECT ON DATABASE postgres TO nightly_check;
GRANT USAGE ON SCHEMA public TO nightly_check;
GRANT SELECT ON public.schema_migrations TO nightly_check;
```

Then add the connection string as a GitHub Actions secret named
`NIGHTLY_DATABASE_URL`, under Settings, Secrets and variables, Actions.

Three details that matter:

* **Use the pooler host, port 6543.** The direct host on 5432 needs the Supabase
  IPv4 add on to be reachable from a GitHub runner. A transaction mode pooler is
  the wrong tool for `backend/scripts/migrate.js`, which needs real transactions
  for DDL, but it is entirely fine for one `SELECT`.
* **The check reads and never writes.** That is why it does not simply run
  `node backend/scripts/migrate.js status`, which would have been the obvious
  reuse: that command calls `CREATE TABLE IF NOT EXISTS` on the ledger before
  reading it, and an unattended nightly job should not hold a credential that can
  execute DDL against production.
* **Secrets are not exposed to workflow runs triggered from a fork**, which
  matters on a public repository.

### The ledger is not yet trustworthy

`schema_migrations` is keyed on filename and was itself created late, by
`supabase/migrations/20260802_schema_migrations.sql`. Everything before that was
pasted into the Supabase SQL editor by hand, so a file with no row may have been
applied months ago or may never have run.

The check therefore reports a pending file as a **warning**, marks the ones that
predate the ledger, and says it cannot tell the two cases apart. A **checksum
mismatch** is a different matter: a row exists, so the file definitely ran, and
the bytes on disk are no longer the bytes that ran. That is reported as a
failure.

To make pending mean something, run this once against production:

```sh
DATABASE_URL='...' node backend/scripts/migrate.js baseline --yes
```

It records every file currently on disk as applied without executing any of it.
After that, a pending file genuinely means an unapplied file, and the check can
be promoted from a warning to a failure.

## The two structural problems it will keep reporting

Neither is fixable by this check, and both are worth doing properly.

**Three tracked lockfiles.** npm maintains the root lock of a workspace and
leaves the workspace locks where they were. `frontend/package-lock.json` and
`backend/package-lock.json` therefore only move when somebody runs npm inside
those directories, and nothing notices, because every gate reads the root: CI
runs `npm ci` at the root, and `npm audit` from `frontend/` walks **up** to the
root lock. That is why `npm audit` in `frontend/` reported 4 vulnerabilities
while `frontend/package-lock.json` audited on its own reported 11, several of them
high and one of them `react-router-dom`, a runtime dependency. The nightly can
refresh those locks; the durable fix is to stop having them, by moving the Vercel
Root Directory to the repository root, which is a deployment setting and not a
change to this repository.

**Migrations applied by hand.** See above. Until `baseline` has been run once,
nothing can answer "is production up to date" with confidence, including a human.

## Adding a check

Write the judgement as an exported pure function taking plain data and returning
findings, put the input and output shapes in
`backend/tests/unit/nightly-check-judgements.test.js`, and keep the network or
filesystem in a separate wrapper. Every judgement in the file is testable without
a network, a database or a runner, and that is what makes it possible to prove it
does not repeat #165.

If a check cannot answer, return `not_checked` with the reason. That is always a
better answer than a guess.
