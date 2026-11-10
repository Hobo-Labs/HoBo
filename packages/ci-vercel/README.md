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
  hosts, `pooled.db.prisma.io`, and Supabase's pooler host on port 6543; its
  port 5432 is session mode). Each repair checks the two connections against a
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
