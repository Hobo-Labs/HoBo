# HoBo CI Vercel support

## Run Vercel CI checks locally

`@hobo/ci-vercel/turbo-ci` runs the checks declared for the new Vercel CI
runtime on a developer machine or a HoBo-owned runner. The existing HTTP relay
and Sandbox integration are described below.

Vercel CI selects tasks with `"tags": ["ci"]` in `turbo.json`. HoBo asks Turbo
for those resolved task tags, honors `!ci`, package overrides and
`$TURBO_EXTENDS$`, then runs the exact `package#task` entrypoints. Turbo owns the
dependency graph, input hashes, strict environment filtering, outputs and cache.
A dependency tagged `!ci` still runs when a selected check requires it. Package
labels alone do not opt tasks into CI.

From this repository's root:

```sh
pnpm ci:local --dry-run
pnpm ci:local
pnpm ci:local --affected --base origin/main
```

The checked-in [package configuration](turbo.json) initially selects only this
package's `test` and `typecheck`. Other packages can opt in with the same task
tags. This does not enable hosted CI or any GitHub Actions workflow.
The local runner requires Turbo >=2.11.10 <3; the root dependency is pinned to
2.11.10 because the planner consumes its GraphQL task metadata. Vercel's own
documented minimum is Turbo 2.11.7. Recheck the CLI contract before upgrading.

For another checkout, use `pnpm ci:local --cwd /path/to/repository`. Dependencies
and the repository's Turbo version must already be installed. The SDK exposes
`planTurboCi({cwd})` and `runTurboCi({cwd, signal})`; after building the package,
`pnpm --filter @hobo/ci-vercel ci:local --cwd /path/to/repository` uses its CLI.

`--affected` requires an explicit `--base` and sufficient Git history; `--head`
defaults to `HEAD`. The planner intersects CI entrypoints with Turbo's
input-aware `affectedTasks` query **before** emitting explicit selectors.
Appending `--affected` to qualified selectors does not narrow them in Turbo
2.11.10. Invalid refs fail planning. The default runs every tagged check and
lets Turbo reuse matching cached results. An empty selection succeeds without
starting a task runner. Dry runs query and inspect the graph but execute no checks.

Local cache is the default (`--cache=local:rw`), even for a checkout linked to
Vercel Remote Cache. `--remote-cache` explicitly enables both local and configured
remote cache reads/writes. That can share results with Vercel or another cache
server, subject to input/environment/platform compatibility and provider terms.
It does not change where checks execute. Each invocation uses
`--concurrency=100%` and `--continue=never`, streams task logs, returns Turbo's
exit code, and asks Turbo to stop its task process groups on cancellation. The
CLI continues handling repeated interrupts until shutdown completes. POSIX hosts are
required. Run only trusted checkout code: this is not an isolation boundary.

### Billing and runtime boundaries

As checked October 29, 2026, the [Vercel CI documentation](https://vercel.com/docs/ci)
and [CLI reference](https://vercel.com/docs/cli/ci) document hosted push-triggered
execution, not a self-hosted runner registration or local `vercel ci run`.
HoBo executes the same Turbo checks locally; it does not impersonate a Vercel
worker or publish Vercel CI success checks.

To avoid Vercel CI compute charges, keep hosted Vercel CI disabled in that
repository's Vercel settings. Tagging tasks does not itself enable it. If CI is
already enabled, turn it off there; a local run does not disable it. Configure
branch protection to require the actual HoBo/GitHub check when using the existing
[Actions relay](../ci-gh-actions/README.md) for automated checks. A local success
does not satisfy a required Vercel CI status.

[Vercel CI pricing](https://vercel.com/docs/ci/pricing) bills bootstrapping as
well as executed tasks. Warming the remote cache can avoid task CPU minutes but
does not guarantee a free hosted invocation. This runner makes no Vercel API
calls and uses no Vercel compute. Commands inside checks, remote caches, the
separate relay, Sandbox runners and deployments may still incur their own costs.

Vercel CPU/image tags describe cloud resource choices; local checks use the
caller's OS and installed tools. HoBo does not reproduce Vercel's per-task VM
isolation, bootstrap snapshots, project secrets, deployment waits or OIDC header
injection. Persistent tasks, managed OIDC tags (including package defaults) and
virtual `#deployment` dependencies are refused before execution. An explicit
`ci:oidc:none` task override is supported. Supply local test services and ordinary
environment variables through existing Turbo `env`/`passThroughEnv` declarations;
keep cloud-only deployment checks on their intended runtime.

### Local runner gates

`test/turbo-ci.test.ts` exercises real Turbo processes for tag inheritance,
opt-outs, required dependencies, cache restoration, affected roots, failures,
cancellation and cloud-feature refusals. `test/turbo-ci-cli.test.ts` verifies empty
dry-run JSON and repeated interrupts against the real CLI. The CLI consumer PACT in
`contracts/turbo-ci.consumer.test.ts` verifies the metadata contract against the
installed binary without Vercel credentials. TypeScript covers the SDK and CLI.
The runner hands the caller's environment, `TURBO_CACHE_DIR` and remote-cache
settings included, to Turbo, so both runner suites drop inherited `TURBO_*`
variables (`test/isolated-turbo-env.ts`): their fixtures hash identically in every
temp dir, and the shared CI cache would otherwise replay a task instead of running
the script the test observes.
The plan uses generated [Protobuf](data-models/turbo_ci.proto), with independent
[CUE constraints and fixtures](data-models/turbo-ci/plan.cue). Check codegen with
`pnpm codegen:check --filter packages/ci-vercel`; run `cue vet -d '#TurboCiPlan'
packages/ci-vercel/data-models/turbo-ci/plan.cue <fixture.json>` for each plan
fixture (invalid fixtures must fail). Plan fixtures are separate from queue
fixtures because schema-tools applies every top-level CUE schema to that
directory's entire fixture corpus.

Planning is an ephemeral query, not a new durable relay command. It does not
write relay events or projections. Turbo persists its ordinary local task cache;
the generated plan is printed by `--dry-run` and is not accepted as executable
input. The existing relay command/event and PostgreSQL replay semantics remain
independent.

## The relay as a HoBo app

HoBo deploys its own relay, so the relay is declared in HoBo's own app model.
[`src/bindle.ts`](src/bindle.ts) is the Bindle (`hobo-ci-relay`), at the path the
CLI's project loader looks for (`src/bindle.ts`), so this directory is a HoBo
project:

| Resource | Kind | What it is here |
|---|---|---|
| `relay` | `api` | the HTTP entry, `api/relay.ts`, which every route is rewritten to |
| `hobo-ci` | `queue` | the private queue topic `api/queue.ts` consumes |
| `hobo-ci-repair` | `schedule` | the repair tick, every 15 minutes, onto that queue |
| `state` | `data` | the PostgreSQL event store, inbox and projections |
| `secrets` | `secret` | where the relay's secrets are held |

The Bindle names no provider (`assertNoBindleProviderSelection` holds, and the
test below also scans the declaration for provider names): the target is chosen
where the deploy is run. Two facts the Bindle model cannot carry yet are
exported beside it, keyed by its resource names: `RELAY_REPAIR_SCHEDULE` (the
cadence `*/15 * * * *`; `b.schedule()` takes none) and `relayState`
(`postgres.database({ jsonb, pooling, connectivity: ["tls-tcp"] })` from
`@hobo/data-postgres`, a `data.postgres/v1` capability requirement; `b.data()`
takes none). `relayConfig` is the relay's `config()` schema: every setting the
source reads, by name and with no value. Its `env.*` fields are the non-secret
configuration a deploy may set; its `secret.*` fields (`DATABASE_URL`,
`DATABASE_URL_UNPOOLED`, `CRON_SECRET`, the session key, tokens, the GitHub App
key and secrets) are named only: the operator, the storage integration or the
relay's own vault holds them.

The declaration is not deployed code. No entry file and no other source imports
it, and the package's build (`tsconfig.json`) leaves it out, so what Vercel
compiles and bundles for the relay is unchanged and needs neither
`@hobo/bindles` nor `@hobo/data-postgres` (devDependencies); `tsconfig.check.json`
type-checks it.

`test/relay-bindle.test.ts` ties the declaration to the relay so it cannot
drift: the queue topic and its consumer file equal `vercel.json`'s queue
trigger, the route destination equals the HTTP entry, every `queue.send` topic
and repair name in `src/entry.ts` equals the declared ones, and the declared
settings are exactly the `HOBO_CI_*`, `CRON_SECRET` and `DATABASE_URL*` names
the source reads. `vercel.json` declares no schedule on this branch (the hosted
relay is ticked by an external trigger, which `test/scheduled-repair.test.ts`
pins), so the schedule's name, cadence and topic are compared with
`vercel.json` only once it declares one, and then must match exactly.

### Deploying the relay with HoBo

`hobo ci deploy` reads this declaration and deploys the relay to Vercel from a
git ref, through HoBo's own Vercel provider
([`@hobo/hobo`](../hobo/README.md), `createVercelDeployProvider`'s git-artifact
mode):

```sh
# From the repository root: print the plan; nothing is sent, no token is read.
hobo ci deploy --cwd packages/ci-vercel \
  --repo <owner>/<repository> --ref main --project hobo-ci \
  --team team_… --set HOBO_CI_PUBLIC_URL=https://… --dry-run

# A real run reads VERCEL_TOKEN from the environment. Preview is the default;
# production has to be asked for, and --sha pins the commit.
VERCEL_TOKEN=… hobo ci deploy --cwd packages/ci-vercel \
  --repo <owner>/<repository> --ref main --sha <40-hex commit> \
  --project hobo-ci --team team_… --target production
```

It needs a Vercel access token for the project's scope, the project's own
settings to build this directory (root directory `packages/ci-vercel`, or pass
`--root-directory`), and Vercel's GitHub integration able to read the
repository. `--set` takes only the `env.*` fields of `relayConfig`; a
`secret.*` field, an undeclared name or a credential-shaped value is refused
before anything is sent. It does not set `DATABASE_URL`,
`DATABASE_URL_UNPOOLED`, `CRON_SECRET` or any other secret, does not create or
connect a database, queue or storage integration, does not create the project
unless `--create-project` is given, and does not create the schedule or its
external trigger. Those stay with the operator, as described below.

**Status: exercised against a fake transport only. No live deployment of the
relay was made from this repository by this change.**

## Database

The relay speaks plain Postgres through `pg` and creates its own tables on first start. Nothing in
its store depends on a particular host. Point it at any Postgres with two variables, which are the
same URL when no pooler sits in front of the database:

```sh
DATABASE_URL=postgres://hobo_ci:<password>@<host>:5432/hobo_ci
DATABASE_URL_UNPOOLED=postgres://hobo_ci:<password>@<host>:5432/hobo_ci
```

[`deploy/postgres/compose.yaml`](deploy/postgres/compose.yaml) runs a self-hosted Postgres 17 with a
named volume, a password from a file and a health check. The database must be reachable from where
the relay runs, over TLS.

Checked against a self-hosted PostgreSQL 16.15: the store's real-database tests pass
(`HOBO_TEST_POSTGRES_URL=… vitest run` in `@hobo/ci`, 68 tests), and the relay starts, creates its
18 tables and reports that it is waiting for the GitHub App.

Two things still tie a production relay to Neon. Its start-up reads credentials from a
runtime-config broker whose address is fixed in `src/entry.ts`; setting
`HOBO_CI_GITHUB_APP_ID` (with its key and webhook secret) or `HOBO_CI_BOOTSTRAP_TOKEN_SHA256` in the
relay's environment bypasses the broker. And its schema is created by statements inside the store;
the plan is a Drizzle schema with generated migrations (see
[CI Relay Mesh](../../docs/design/ci-relay-mesh.md)).

## Hosted relay

The relay's HTTP surface is not this package's: `createRelayHandler` (Fetch),
`createNodeRelayHandler` (Node adapter) and the failure log live in
[`@hobo/ci-gh-actions`](../ci-gh-actions/README.md#one-http-layer) and are the
same code `hobo ci serve` and the container image run. This package is the
Vercel host around it: the function entrypoint, which paths stream
(`src/relay-streams.ts`), the queue consumer, the scheduler, the Postgres store
wiring and the Sandbox runner.

It runs the same relay core as the Node service ([one relay, thin
hosts](../ci-gh-actions/README.md#one-relay-thin-hosts)); what is specific to
this host is the `PostgresCiStore`, the queue wake-up and 15-minute schedule
that call the worker tick, the Sandbox runner backend, the GitHub App bootstrap
and OAuth onboarding, and the webhook and queued-job repair.

The relay's [MCP server](../ci-gh-actions/README.md#mcp-server) is mounted at
`/mcp` with `sessions: "none"`: a function instance does not outlive its
request, so each request stands alone and is answered with JSON, `/mcp` is not
a streaming path, and resource subscriptions are not advertised. Tools and
resources work as on the Node service, and `wait_for_events` is the change
feed. A wait holds the function for its duration, so its ceiling comes from
the function's own limit: `vercel.json` gives `api/relay.ts` a `maxDuration`
of 300 seconds (the limit the queue consumer's two-minute wait for a worker
pass already assumes), `src/function-limits.ts` holds the same number, and
`mcpWaitCeilingMs` keeps 30 seconds of it back and never exceeds 50, the most
an MCP client waits by default. `test/function-limits.test.ts` fails if the
two numbers differ. The server reads through `PostgresCiStore.observer()`, so
an agent's reads take no partition lock and are never queued in front of
webhook admission.

This package provides a Vercel Node Function entrypoint, a Postgres-backed
relay, a private queue consumer, and an independent scheduler. Signed
GitHub deliveries are committed before acknowledgement. Queue notifications
wake the worker immediately; the scheduler recovers committed work whose wakeup
was lost and asks GitHub to redeliver failed App deliveries. `/readyz` requires
the database, queue, scheduler and GitHub repair path to have recently succeeded;
a new deployment reports unready until its first repair scan completes. A
successful partial scan retains the last completed-scan health while it queues
its continuation. Actual scan failures mark the relay unready, and completed-scan
health expires after 45 minutes. Delivery and queued-job scanners record their
completed cycles independently, since their pagination can finish on different
wakeups. A new deployment waits for both scanners to complete; a queued scan
may wait for the existing ten-minute cooldown. This is scanner liveness, not a
point-in-time guarantee that every repository is covered after inventory changes.
The webhook intake is available during initial repair.

The queue uses **parse, don't validate**: `QueueMessageSchema` parses provider
input into derived types for a committed-delivery wakeup, a scheduled or
continuation repair, or the authenticated manual-tick command. The protobuf and
CUE definitions in [data-models](data-models/) describe the queue messages and
their constraints; provider-supplied metadata does not become routing authority.

The GitHub App and Vercel scheduler are actors that submit commands through the
signed HTTP intake or private queue. The PostgreSQL event-store records CI events
and the durable webhook inbox; lease and configuration projections are its
materialized views. Worker health is a separate PostgreSQL read store recording
the latest successful and failed processing times. The Vercel function is
stateless: it reads the current policy snapshot from PostgreSQL on each operation,
and never treats a process-local cache or a queue wakeup as the event-store.

A Vercel Schedule named `hobo-ci-repair`, declared in `vercel.json`, publishes a
repair message to the private `hobo-ci` queue every 15 minutes. The target is
the queue topic, not a URL, so no shared secret is involved and nothing public
can trigger it; the consumer accepts only that schedule name. Fifteen minutes is
the shortest interval Vercel's Hobby plan allows, and that plan adds up to 15
minutes of jitter. Every deployment declares the schedule, so a deployment
outside production acknowledges the scheduler's run without working it. Normal
work uses an immediate queue wakeup, and the queue schedules a delayed
continuation for larger delivery histories. `GET /internal/tick` remains for an
operator's own scheduler; an earlier Neon scheduled trigger used it and can be
retired once the schedule is seen running.

Production queue messages stay pinned to their publishing deployment. Each
new callback forwards a validated wakeup to the canonical relay and acknowledges
it only after the current worker succeeds. Keep the canonical URL and the
broker-held `CRON_SECRET` stable while those messages can be retried. The
handoff does not change callbacks from deployments predating this mechanism;
retire or drain those separately. Messages expire after one hour, while the
database inbox remains the source of truth for recovery.
Vercel's Hobby plan is limited to personal, non-commercial use. PostgreSQL,
queue operations and Functions can incur usage charges according to the chosen
plans. A temporary deployment or Vercel Drop alone is not a durable inbound App
endpoint.

## Hosting the relay and its database on Vercel

The relay is a Vercel Function plus a private queue consumer and a schedule; all
three are declared in `vercel.json` and need nothing outside Vercel. Its
database cannot be a container on Vercel. Vercel's container runtime and
Daemons have no persistent disk; Vercel's own guide says "You can't run your
own Postgres or Redis container with local disk" and that durable storage
attached to containers "has not shipped". Vercel's first-party storage is Blob
and Global Config, neither of which is a database. PostgreSQL on Vercel is a
Marketplace store (Storage tab), and the ones that are not Neon are Supabase,
Prisma Postgres and Amazon Aurora PostgreSQL.

| Store | Fit | Watch for |
| --- | --- | --- |
| Supabase | Always-on instance; a session-mode endpoint for repair | If the connection fails with `unable to verify the first certificate`, its certificates chain to Supabase's own root: set `HOBO_CI_DATABASE_CA_CERT` |
| Prisma Postgres | Direct and pooled strings | The free plan is metered by operations (200,000 a month); a relay that polls can exhaust it, the same kind of plan quota that stopped the Neon database |
| Aurora PostgreSQL | Durable, billed by AWS | Authenticates with short-lived IAM tokens instead of a URL; the relay does not support that yet |

To move the relay onto one:

1. In the Vercel project, open Storage, create the store and connect it to the
   project's Production environment. If the old store is still connected, give
   the new one a prefix and set `HOBO_CI_DATABASE_ENV_PREFIX` to it.
2. If the provider's certificates chain to its own root, add that root
   certificate as `HOBO_CI_DATABASE_CA_CERT`.
3. Redeploy. The relay creates its tables on first use. A new database has no
   GitHub App record, so the relay starts in bootstrap mode; complete
   [GitHub onboarding](../ci-gh-actions/ONBOARDING.md) again, or restore the old
   database into the new one first to keep the existing App.
4. Confirm `GET /readyz` and disconnect the old store.

`scripts/bootstrap-postgres-contract.ts` runs the whole relay flow against a
real PostgreSQL. `HOBO_CI_TEST_POSTGRES_BINDING` (`supabase`,
`prisma-postgres`) makes it use a provider's variable names and
`HOBO_CI_TEST_POSTGRES_CA_FILE` a private certificate authority; it passes
under all three bindings against a TLS-only PostgreSQL 16. It has not been run
against a hosted Supabase or Prisma Postgres database.

### Running on several databases: the database fleet

One database on one plan is one quota away from an outage. The relay can run
on a **fleet** instead: several PostgreSQL databases from different providers,
exactly one of them the **writer** at any time, the others **standbys** that
are kept current, and a policy that moves the writer before a quota runs out
or when the writer is down. The mechanism is the provider-neutral fleet in
[`@hobo/data-postgres`](../data-postgres/README.md#the-fleet); this package
supplies the `pg` adapter, the provider profiles, the runtime fence and the
schedule.

With `HOBO_CI_DATABASE_BACKENDS` unset the relay is the single-database relay
described above, unchanged. With one backend listed it is the same relay on
that backend. Everything below applies only with two or more.

#### Configure

Connect each store to the project under its own prefix, then list them:

```text
HOBO_CI_DATABASE_BACKENDS=neon=NEON_,supabase=SUPABASE_,prisma=PRISMA_:prisma-postgres
```

Each entry is `id=PREFIX` or `id=PREFIX:profile`. The id is an opaque name
used in logs and in the assignment. The prefix is how that store's variables
are read, with the same names as above (`NEON_DATABASE_URL` and
`NEON_DATABASE_URL_UNPOOLED`, `SUPABASE_POSTGRES_URL` and
`SUPABASE_POSTGRES_URL_NON_POOLING`, `PRISMA_DATABASE_URL_POOLED` and
`PRISMA_DATABASE_URL`); one backend may have an empty prefix (`main=`). Every
backend needs both its pooled and its session-scoped connection. The profile
defaults to the id when a profile of that name exists and to `postgres`
otherwise. **The first backend listed is the writer of a fleet that has never
decided anything**, so list the database that holds the data first.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOBO_CI_DATABASE_BACKENDS` | unset | The fleet. Mutually exclusive with `HOBO_CI_DATABASE_ENV_PREFIX` |
| `<PREFIX>HOBO_CI_DATABASE_CA_CERT` | none | That backend's private certificate authority (Supabase). Per backend, so one provider's root is not imposed on another |
| `HOBO_CI_DATABASE_RPO_SECONDS` | 1200 | Recovery point objective: the oldest standby a failover may promote |
| `HOBO_CI_DATABASE_FAILOVER_AFTER_SECONDS` | 60 | How long the writer must fail before a failover |
| `HOBO_CI_DATABASE_LEASE_SECONDS` | 30 | How long an instance trusts the assignment it last confirmed |
| `HOBO_CI_DATABASE_MONTHLY_BUDGET_MICROS` | 0 | Monthly budget for the relay database, in millionths of a US dollar |

Anything malformed (a bad pair, a repeated id or prefix, an unknown profile, a
backend with no connection, a non-numeric setting) stops the relay at startup.
Errors name variables, never values.

Any number of backends works. A majority of them must answer for the relay to
run: three tolerate one down, five tolerate two. An even count buys nothing
(four tolerate one, two tolerate none), so use an odd one.

#### Provider profiles

`src/database-fleet-config.ts` holds what the relay knows about each kind of
backend as data, one record per profile; no code branches on a provider.

| Field | What it says |
| --- | --- |
| `connection` | How its connections are found: today, variables under the prefix. It is a function, so a provider whose credential is a short-lived token minted per connection can supply pool settings with an async `password`. None does yet |
| `transactionPoolers` | Addresses of its transaction-mode poolers, refused for that backend's session connection. A pooler with its own hostname is also in `KNOWN_TRANSACTION_POOLERS`, matched against every connection; one that differs from the direct endpoint only by port (PgBouncer on 6432) is refused only for the backend whose profile names it |
| `privateCertificateAuthority` | Whether its certificates chain to its own root |
| `hosting` | `managed` or `self-hosted` |
| `financial` | Plan, fixed monthly fee, allowances per unit and what happens beyond them, with the source and the date of every number |

Profiles today:

| Profile | Pooler refused for session work | Private certificate authority |
| --- | --- | --- |
| `neon` | `-pooler` hosts | no |
| `supabase` | port 6543 on the shared pooler host and on the project host | yes |
| `prisma-postgres` | `pooled.db.prisma.io` | no |
| `planetscale-postgres` | port 6432 | no |
| `azure-postgres-flexible` | port 6432 | no |
| `gcp-cloudsql-postgres`, `gcp-alloydb` | port 6432 | depends |
| `aws-rds-postgres`, `aws-aurora-postgres` | none by address: RDS Proxy has its own hostname and no pattern for it is recorded | yes |
| `azure-horizondb` (preview) | none: no built-in pooler | depends |
| `pgedge-cloud` | none recorded | depends |
| `postgres` | none: any PostgreSQL the operator runs or rents | depends |

The pooler and certificate facts come from the PostgreSQL backend catalog,
which cites each to the provider's documentation. Every provider here is
reached with a password connection string; identity-token authentication (AWS
IAM, Google IAM, Microsoft Entra) is not implemented. **Only Prisma Postgres's free plan has
recorded numbers** (200,000 operations a month and 2 GB, from the Vercel
Marketplace page, as recorded by the project owner; what happens beyond them
is recorded as unknown and treated as a hard stop). Every other profile's fees
and allowances are recorded as unknown. The policy does not guess: it neither
leaves a writer because of an unknown nor makes a planned switch to a standby
with one. Until those numbers are recorded, the only planned switch this
configuration can make is *onto* Prisma Postgres, and a failover is the only
way off it.

#### How it works

**Who the writer is.** Each backend holds a small append-only table,
`hobo_ci_fleet_assignments`. An entry is decided when a majority of the
backends hold it. An instance reads the newest entry from a majority when it
starts and again when its lease is half spent. It uses a backend only while
the entry it confirmed names that backend, is not sealed, and is younger than
the lease by its own wall clock. That is checked before every statement, so
an instance that was frozen and resumed cannot write on an old assignment. In
every other case (no majority, an undecided newest entry, a sealed fleet) it
answers `503` with `Retry-After`. `GET /readyz` then carries
`{"ready": false, "reason": "store-unavailable"}`, and `GET /healthz` still
answers `200`: it reports on the process, and restarting a relay that is
waiting for a writer would not find one. When the writer changes it closes its
pools and builds the application again on the new writer.

**Keeping standbys current.** The Vercel Schedule's repair message (every 15
minutes) first runs one reconcile tick: it copies the writer to each standby
in one consistent snapshot, verifies each copy by digest, and records a
watermark. Only tables that changed are rewritten. The tick is served by the
fleet, not by the application, so it still runs when the writer is down.

**Choosing the writer.** The same tick measures each backend (reachable or
why not, standby lag, statements sent this month, database size) and asks the
policy. The budget question is answered by `evaluateBudgetPolicy` from
`@hobo/core`, with each recorded allowance as a constraint.

**Metering.** Every statement the relay sends to a backend is counted,
including lease reads and copies, and added to `hobo_ci_fleet_usage` on that
backend at most once a minute. One statement is counted as one operation.

#### What the recovery point objective means with a 15-minute schedule

A standby is as fresh as the last tick. If the writer dies just before a tick,
that tick finds standbys about 15 minutes old, waits out
`HOBO_CI_DATABASE_FAILOVER_AFTER_SECONDS`, and promotes one. So:

- **What a failover can lose:** up to one schedule interval of writes, about
  15 minutes. The promoted standby's age is recorded as `loss_window_ms`.
- **How long the relay is down:** up to one interval plus the failover
  threshold, about 16 minutes, because nothing looks between ticks.
- **The objective must exceed the interval.** A standby is always about one
  interval old when a failure is noticed. The default of 20 minutes allows
  that. An objective below about 16 minutes means a failover never happens and
  the relay waits for the writer or for a person.
- **A planned switch loses nothing** and costs one lease plus a few seconds of
  `503` (about 35 seconds by default) while writers stop and the final copy
  runs. GitHub deliveries refused in that window are redelivered by the
  relay's webhook repair.

#### What happens on each failure

| Failure | What the relay does | What is lost |
| --- | --- | --- |
| A standby is unreachable | Keeps running; that standby is not copied to and its lag grows | Nothing |
| The writer is unreachable, or answers that a quota is exceeded | `503` until the next tick; the tick fails over to the freshest standby within the objective | Up to `loss_window_ms`, at most about one interval |
| The writer is down and every standby is older than the objective | `503`; the tick logs `hold` with the reason per standby and promotes nothing | Nothing. Waits for the writer or for `overrideAssignment` |
| The writer's metered allowance is projected to run out within 3 days | Planned switch to a standby with at least 6 days of headroom | Nothing |
| The writer is over budget and no standby is provably better | Keeps the writer; logs `keep` with `no-feasible-standby` | Nothing, until the plan stops the writer; then it is a failover |
| A majority of backends are unreachable (a double fault with three) | `503` everywhere, by design; nothing changes until a majority answers again | Nothing |
| A tick is interrupted after sealing | `503` until the next tick, which finishes or undoes the switch | Nothing |
| A proposer is interrupted mid-write | `503` (`undecided`) until the next tick completes that same entry | Nothing |
| The old writer comes back | Its log is repaired; it is a standby and the next copy overwrites it | Its writes after the last copy were already counted as lost |
| Two ticks run at once | One decision per epoch; the other tick stops | Nothing |
| Every backend holds a different entry for one epoch | `503` until a person calls `overrideAssignment` | Nothing |
| A standby's schema differs from the writer's | The tick runs the relay's table initialisers on both and copies again; if it still differs the copy is refused, naming the column | Nothing; that standby is not a failover target |
| The database outgrows the copy limits (2,000,000 rows or 512 MiB of row text) | The copy is refused as `oversized`; standbys stop advancing | Nothing, but lag grows until the objective forbids failover |

#### Limits

- **Copy cost grows with the database, not with the change.** Every tick
  digests every copied table on the writer and on each standby, and rewrites
  each table that changed, whole. An idle tick is five statements on the
  writer and about ten on each standby.
- **The recovery point floor is the schedule interval.** A shorter schedule
  buys a smaller loss and costs more statements.
- **Statements are money on a metered plan.** Lease reads are one statement
  per backend each time an active instance's lease is half spent (every 15
  seconds by default), from every warm instance. On a plan that allows 200,000
  operations a month, one continuously busy instance spends most of that on
  lease reads alone. Raise `HOBO_CI_DATABASE_LEASE_SECONDS` to trade a longer
  switch and a longer window of writes to an old writer for fewer reads.
- **A double fault stops the relay by design.**
- **A failover can lose more than `loss_window_ms`** if some instances could
  still reach the old writer: they keep writing to it for at most one lease.
- **A backend that returns without its `hobo_ci_fleet_assignments` table** (a
  restore, a reset) must be removed from the list or have its log restored
  before it rejoins. Changing the list changes what a majority is: do it one
  backend at a time while all are healthy.
- **The usage count is a lower bound** (an instance stopped before it writes
  its counter loses that count), and Neon's compute-hours are not measured at
  all.
- **A standby's schema comes from the checked-in migrations.**
  `prepareRelaySchema` (`src/relay-schema.ts`) is the fleet's schema seam. On
  a standby it applies `RELAY_SCHEMA_MIGRATIONS`, the migration sets
  `@hobo/ci`, `@hobo/ci-gh-actions` and this package ship from their
  `db/migrations/`, with the one runner (`applyMigrations` in
  `@hobo/ci/schema-migrations`), over the fleet's control connection. No
  relay store is opened on a standby, so the application writes nothing
  there: the runner's writes are DDL and its ledger,
  `hobo_ci_schema_migrations`, which the fleet does not copy. There is no
  second list of DDL: the sets are copies of the reviewed SQL, held to it by
  `db:check`, and the same SQL the writer's embedded DDL is proven to equal.
  - *When.* For both sides of a copy that found the standby's columns
    different from the writer's (the standby first), and, because a standby
    that lacks only an index would never be offered that way, once per
    instance for each standby whose ledger is not at this release: one read
    of the ledger, and a migration run only if it is behind.
  - *The writer's side* runs the stores' own initialisers first, as the
    application does when it starts there, and then the same migrations. Only
    the initialisers can move a table from an earlier release's layout
    forward; the migrations then record what the writer holds.
  - *Repeating and racing.* Each set is one transaction under the migration
    lock and the locks the stores' initialisation takes, so several
    instances, or a writer starting meanwhile, apply once.
  - *A backend ahead of this release* (its ledger holds a migration this
    release does not have, because a newer relay prepared it) is refused
    before any statement and left exactly as it is; nothing is downgraded.
    The error names the backend by its fleet id and the migration ids, never
    a host or a connection string. While its columns still match the writer's
    it keeps receiving copies; once they differ, its copies fail until the
    newer release is deployed here or the backend leaves the fleet.
  - *A standby that cannot converge* (a table at a layout older than the
    baseline, which the guarded `CREATE TABLE` skips) is refused the same
    way, with nothing recorded. It holds only copies: drop that table on the
    standby and the next tick creates and refills it.

#### Structured events

Each is one JSON line, with backend ids, numbers and fixed tokens only: never
a connection string, a host name or an error message.

| Event | When |
| --- | --- |
| `hobo_ci_database_fleet_fence` | An instance's view of the assignment changes |
| `hobo_ci_database_fleet_application` | The application is built on a writer |
| `hobo_ci_database_fleet_replication` | Every copy: status, refusal or failure class, rows, bytes rewritten, duration |
| `hobo_ci_database_fleet_decision` | Every tick: action, reasons, target, loss window, every standby ranked |
| `hobo_ci_database_fleet_transition` | Every attempt to change the assignment and whether it was decided |
| `hobo_ci_database_fleet_unsettled` | A tick stopped: `undecided` or `no-majority` |
| `hobo_ci_database_fleet_schema` | A backend's schema was prepared or could not be: `backend`, `role` (`writer`/`standby`), `status` (`applied`, `ahead`, `refused`, `failed`), and migration ids (those applied, or the unknown ones of a backend that is ahead). Nothing is written when there was nothing to apply |
| `hobo_ci_database_fleet_failure` | A tick threw |

#### Admission by HoBo's own conformance suite

`src/database-fleet-conformance.ts` runs `conformance.data.postgres/v1` from
`@hobo/data-postgres` against a backend (`qualifyBackend`), with the suite's
`sql` cases executed verbatim on one session. The proof below runs it against
all three servers before using them. It is not yet a gate at startup: the
relay does not refuse a backend that was never qualified.

#### Tests and proof on real PostgreSQL

`test/database-fleet-postgres.test.ts` and
`test/database-fleet-reconcile-postgres.test.ts` run the fleet's SQL, the
reconciler and the relay's real schema against real PostgreSQL. They are
skipped unless `HOBO_CI_TEST_FLEET_POSTGRES` names three separate servers,
comma-separated; each test creates and drops its own databases:

```bash
export HOBO_CI_TEST_FLEET_POSTGRES="postgres://hobo_ci@127.0.0.1:15441/postgres,postgres://hobo_ci@127.0.0.1:15442/postgres,postgres://hobo_ci@127.0.0.1:15443/postgres"
pnpm --filter @hobo/ci-vercel exec vitest run test/database-fleet-postgres.test.ts test/database-fleet-reconcile-postgres.test.ts
```

`scripts/database-fleet-proof.ts` is the end-to-end proof. It runs the real
relay (bootstrap entry, GitHub App creation against a stubbed GitHub, signed
webhook deliveries into the real inbox) behind the fleet on three servers and
**stops and starts the servers**. It also needs one stop and one start shell
command per server, in the same order, as a JSON array:

```bash
export HOBO_CI_TEST_FLEET_CONTROL='[{"stop":"…pg_ctl -D <data-a> -m fast -w stop","start":"…pg_ctl -D <data-a> -o \"-p 15441 …\" -w start"},{…},{…}]'
node --import tsx packages/ci-vercel/scripts/database-fleet-proof.ts
```

It creates and drops its own databases, leaves every server running, prints
no connection string, and asserts, in order:

| # | Property | How it is shown |
| --- | --- | --- |
| 1 | Empty backends become a fleet | First assignment decided on 3 of 3 logs; the relay's tables created on every backend; deliveries committed on the writer |
| 2 | Standbys equal the writer | Per-table digests and sequence positions equal on all three; watermark and lag recorded |
| 3 | Planned switch on a budget signal | Usage pushed past a placeholder allowance: sealed, final copy, new writer; every acknowledged delivery present on the new writer; a second relay instance refused within one lease and serving again on the new writer; no sequence collision |
| 5 | Recovery point guard | Writer's server stopped, objective of one second: decision `hold`, assignment unchanged |
| 4 | Unplanned failover | Same outage, normal objective: freshest standby promoted after the threshold; `loss_window_ms` equals its lag; the missing deliveries are exactly those acknowledged after the last copy, listed by id |
| 6 | The old writer returns | A copy into it is refused on itself until its log is repaired; then it is overwritten; a forged copy into the real writer is refused |
| 7 | Loss of majority | Two of three servers stopped: `503` with `Retry-After` although the writer is up, while `/healthz` stays `200`; a tick changes nothing; recovery when one returns |
| 8 | Two reconcilers at once | At most one decided entry per epoch; the three logs identical |

Every plan number in the proof is a placeholder. It passed on 2026-11-10
against three local PostgreSQL 16 clusters. It has not been run against a
hosted Neon, Supabase or Prisma Postgres database.

One dependency on Neon remains outside the database. Production reads its
GitHub App and control secrets from a broker hosted on Neon when
`HOBO_CI_GITHUB_APP_ID` and `HOBO_CI_BOOTSTRAP_TOKEN_SHA256` are both unset;
setting the relay's secrets as Vercel environment variables takes that path
out of use. The Neon scheduled trigger is replaced by the Vercel Schedule
above.

Node 24 is required. Bootstrap mode uses these Vercel secret bindings:

- The database, as one pooled and one session-scoped connection string to the
  same PostgreSQL database and role. The relay reads the names a Vercel storage
  integration injects, so connecting a store needs no hand-copied value:

  | Store | Pooled (HTTP traffic) | Session-scoped (repair) |
  | --- | --- | --- |
  | Any PostgreSQL, set by hand | `DATABASE_URL` | `DATABASE_URL_UNPOOLED` |
  | Prisma Postgres | `DATABASE_URL_POOLED` | `DATABASE_URL` |
  | Supabase | `POSTGRES_URL` | `POSTGRES_URL_NON_POOLING` |

  The first row wins when both of its names are set. The session-scoped
  connection is required after GitHub App bootstrap: repair scanners hold
  session advisory locks across requests, which a transaction-mode pooler
  cannot provide. Known poolers are refused for it by address (Neon `-pooler`
  hosts, `pooled.db.prisma.io`, and port 6543 on Supabase's pooler host and
  project host; its port 5432 is session mode or direct). Each repair checks the two connections against a
  committed random database marker before using it. For any other provider the
  operator must supply a true session endpoint. A repair invocation opens at
  most one such connection and closes it after use. Concurrent repair
  invocations each require a separate connection; there is no global
  concurrency cap, so database connection limits constrain scale.
- `HOBO_CI_DATABASE_ENV_PREFIX` (optional): read the names above under this
  prefix, for a store connected with one (`RELAY_` reads `RELAY_POSTGRES_URL`).
  This is how a new store is attached and selected while the old one is still
  connected.
- `HOBO_CI_DATABASE_CA_CERT` (optional): the PEM certificate authority of a
  database whose server certificate chains to the provider's own root, as
  Supabase's and Amazon RDS's do. The certificate is verified against it;
  verification is never switched off. Without it such a connection fails with
  `unable to verify the first certificate`.
- `HOBO_CI_PUBLIC_URL`: the stable HTTPS origin used by GitHub.
- `HOBO_CI_SESSION_KEY`: a canonical, unpadded base64url encoding of 32 random bytes.
- `HOBO_CI_BOOTSTRAP_ACCOUNT_ID` and `HOBO_CI_BOOTSTRAP_TOKEN_SHA256`: the owner
  account and lowercase SHA-256 digest of its distinct bootstrap bearer token.
- `HOBO_CI_CONTROL_TOKENS_JSON` and `HOBO_CI_CONFIG_JSON`: trusted control tokens
  and the initial account/provider configuration. The configuration seeds only
  an empty ledger and does not replace later changes.

`CRON_SECRET` is required and must be at least 32 bytes. The scheduler sends it
as `Authorization: Bearer <secret>` to `GET /internal/tick`; the endpoint only
queues repair, and the private consumer records schedule health after processing.
The queue handoff uses the same server-side credential for its authenticated
`POST /internal/queue-wakeup`; the credential never appears in the payload.
In bootstrap mode, do not set App ID, private
key or webhook secret: those are saved in the encrypted vault after the GitHub
App manifest flow. See [GitHub onboarding](../ci-gh-actions/ONBOARDING.md). For an
existing App, provide `HOBO_CI_GITHUB_APP_ID`, `HOBO_CI_GITHUB_APP_PRIVATE_KEY`,
and `HOBO_CI_WEBHOOK_SECRET`. Adding `HOBO_CI_GITHUB_APP_CLIENT_ID`,
`HOBO_CI_GITHUB_APP_CLIENT_SECRET` and `HOBO_CI_SESSION_KEY` enables browser
installation; these three settings must be supplied together.

The reviewed sibling `ci-gh-actions` workflow and bootstrap files are embedded
into the build by `scripts/generate-assets.mts`; a contract test verifies their
contents match the sources. Both asset generators format their output with the
repo-pinned Biome before writing, and the proxy bundle's `--check` mode compares
against those formatted bytes. A deployment must verify rewrites, the private queue
trigger and scheduler before production use. Contract tests run without live
GitHub or Vercel credentials. The real-process proxy shutdown test uses a
35-second Vitest deadline so cold TypeScript startup on slower filesystems is
not mistaken for a shutdown failure; its child-process timeout stays bounded
at 30 seconds.

The isolated Sandbox runner integration is configured via
`HOBO_CI_SANDBOX_ENABLED=1`, `HOBO_CI_SANDBOX_TEAM_ID`,
`HOBO_CI_SANDBOX_PROJECT_ID`, `HOBO_CI_SANDBOX_ISSUER` (the pinned Vercel
team issuer), and `HOBO_CI_SANDBOX_DOMAINS_JSON`
(an explicit hostname allowlist). GitHub runner setup, checkout, Node setup,
and artifact transfer can require `github.com`, `api.github.com`,
`codeload.github.com`, `raw.githubusercontent.com`, `nodejs.org`,
`release-assets.githubusercontent.com`, `*.actions.githubusercontent.com`,
and `*.blob.core.windows.net`. Add the hosts used by each workflow's own
dependencies and redirect targets; this list does not cover every workflow.
The only permitted wildcard patterns are
`*.actions.githubusercontent.com` and `*.blob.core.windows.net`, which GitHub
documents for runner traffic. The Azure Blob suffix includes third-party storage
accounts; enabling it permits job traffic to those accounts as well.
`HOBO_CI_SANDBOX_PLAN` defaults to `hobby`. It requires a
matching two-VM Sandbox offer with current pricing and allocation evidence. The
proxy also accepts Vercel's global issuer and the exact team-ID issuer when the
signed token matches the expected audience, team, project, and bound Sandbox.
It does not accept another team's issuer path.
The implementation creates a temporary proxy VM before the runner VM and stops both
after the job. It downloads and verifies the runner archive before uploading it to
the runner VM. Both VMs, their network usage, and quota-control calls are
included in the reservation and settlement estimate.

On October 27, 2026, [the full GitHub acceptance workflow](https://github.com/Tyler-R-Kendrick/HoBo/actions/runs/40569580252/attempts/2)
passed on a Vercel Sandbox runner: setup, checkout, Node setup, runner identity and
checked-out revision verification, artifact upload and post-job steps succeeded.
The matching relay lease recorded the job, stopped both Sandboxes, deleted the
runner and settled the measured usage. This verifies the Vercel path for that
workflow and configuration; it does not verify external runner vendors or every
workflow's dependencies. On October 29, 2026, the built product CLI repeated that
acceptance through `hobo ci rerun --wait` in
[attempt 4](https://github.com/Tyler-R-Kendrick/HoBo/actions/runs/40569580252/attempts/4).
GitHub job `123727970151` matched lease `b1c3b545-ee2b-4bfd-be2c-1a47cb4d1257`;
both sandbox stages stopped, runner deletion was confirmed and 259,321
microdollars settled against a 637,800 microdollar reservation. Before admission,
the supported rate reattestation operation refreshed expired zero-credit pricing
evidence after checking the published rates; budgets and usage accounting stayed
unchanged. Live Sandbox tests on a Pro team also verified 16 MiB
transfers through an exposed port and matched forwarding identity claims to the
guest session; see [Sandbox egress](SANDBOX-EGRESS.md). The gateway's maximum
transfer size remains unverified.
The Vercel runtime admits isolated jobs only when Sandbox is explicitly configured;
without it, readiness remains false and isolated jobs are not launched. Recovery
first fences in-flight launch states and retains ambiguous create
or registration outcomes until their identities can be recovered. It also denies
the nonisolated workflow bridge because repository visibility
could change after a shared-label runner is registered. The readiness endpoint
also requires recent worker health. The
direct Function proxy is disabled in this production composition; the separate
proxy VM handles Sandbox traffic.

The proxy byte quota is not a hard limit on the provider bill. Traffic to the
public proxy port can be billed before authentication, and network overhead,
provider metering and Function usage can differ from the estimate. CPU usage
is charged conservatively because the provider has not documented the
aggregation of its CPU metric.

Once both Sandboxes have stopped, their measured usage is available, and runner
deletion is confirmed, the relay settles the cost even if assignment is unknown;
later GitHub observations can attach the job without declaring the runner idle.
After an ambiguous GitHub JIT registration, the relay looks for the unique runner by its
deterministic name and deletes it before settling. An absent or ambiguous
lookup holds the reservation because the original request could still finish;
there is no automated operator resolution for that case yet. A VM whose create response was lost is
looked up by deterministic name and stopped; the reservation stays held until
its identity, termination and usage are proven.

The managed relay embeds the reviewed Actions host workflow and standalone
bootstrap from `@hobo/ci-gh-actions`. Its build regenerates
`src/_generated-assets/relay-assets.ts`; commit that snapshot whenever the shared host
source changes. `test/relay-assets.test.ts` checks byte equality with the source.
The sandbox proxy bundle also lives in `src/_generated-assets/`: this directory
keeps non-protobuf generators out of the protobuf-owned `src/_generated/` tree.
The local persistent listener can wait without an age-based deadline; the
embedded hosted bridge still supplies and enforces its lease timeout.

### Liveness, readiness and back-off

- `/healthz` answers 200 from the process alone. It never touches the database, so a probe can tell
  "restart me" from "my store is down".
- `/readyz` answers 503 with a `reason` a probe can act on: `store-unavailable` when the GitHub App
  bootstrap store cannot be reached, `bootstrap-required` when no App is registered yet.
- After the store fails it is left alone before the next attempt: 5 s, doubling to a minute. Every
  request used to dial it again.
- A 503 for an unavailable store carries `Retry-After: 5`.

With `HOBO_CI_EVENTS_URL` set, each failure below is also delivered as a CloudEvent (see the
[runner queue runbook](../ci/RUNNER-QUEUE.md)).

### Failure log

Every path that refuses a request with a fixed 503 body also writes one JSON line to stderr, so the
platform's runtime logs show why. The log is the relay's (`@hobo/ci-gh-actions` `src/failure-log.ts`),
so every host of the relay writes the same lines; `hobo_ci_relay_init_failed` is this host's own. Before this the relay failed silently: a relay that could not
start looked like a relay nobody was calling.

| Event | When | Fields |
|---|---|---|
| `hobo_ci_relay_init_failed` | Startup failed; every request answers 503 until it succeeds | `stage`: `runtime-config` (identity token, runtime broker) or `application` |
| `hobo_ci_relay_request_failed` | A request threw after startup, including the GitHub App bootstrap store failing to load | `method`, `route`, `headersSent` |
| `hobo_ci_webhook_ingest_failed` | A signed delivery could not be committed (GitHub redelivers) | `event` |
| `hobo_ci_control_failed` | An account or registration API call threw | `method`, `route` |
| `hobo_ci_ready_check_failed` | The readiness check itself threw | none |

The GitHub App bootstrap store reports `bootstrap store initialization failed` with the database
error as its cause, so the line shows why the store could not be reached.

Each line carries the error's class, its message and its cause's message, with URL credentials and
anything shaped like a token removed and the text capped at 300 characters. A route has its
identifiers replaced. One line per event name is written every 10 seconds per instance; `suppressed`
counts the ones held back since the last line. No request body, header or credential is logged, and
a failing logger never changes the response.

## Postgres schema

The two PostgreSQL tables this package owns (`hobo_ci_database_probes` and
`hobo_ci_worker_health`) are declared in [`db/schema.ts`](db/schema.ts), with
migrations in `db/migrations/`. `pnpm --filter @hobo/ci-vercel run db:generate`,
`db:check`, `db:migrate` and `db:verify` run the tooling `@hobo/ci` provides.
The code still creates both tables from the DDL embedded in `src/`;
`db/migrations/embedded-ddl.lock.json` and `db:verify` hold that DDL to the
declared schema. The full description, including how to migrate a database the
relay is already using, is in
[`@hobo/ci`](../ci/README.md#postgres-schema-and-migrations). A deployed relay
needs all three packages' migrations: `@hobo/ci`, `@hobo/ci-gh-actions` and this
one.
