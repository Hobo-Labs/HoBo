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

## Hosted relay

This package provides a Vercel Node Function HTTP boundary, a Postgres-backed
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

A scheduler calls the authenticated repair endpoint every 15 minutes; it submits
a repair message to the private queue. Normal work uses an immediate queue
wakeup. The HoBo deployment uses a Neon scheduled trigger; operators using Vercel
Cron must configure it explicitly and observe their plan's schedule limits. The
queue schedules a delayed continuation for larger delivery histories.

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

Node 24 is required. Bootstrap mode uses these Vercel secret bindings:

- `DATABASE_URL`: a PostgreSQL connection, preferably pooled.
- `DATABASE_URL_UNPOOLED`: a direct connection to the same PostgreSQL database
  and role, required after GitHub App bootstrap. Repair scanners hold session
  advisory locks across requests; transaction-pooling endpoints cannot provide
  this guarantee. Neon supplies both variables through its Vercel integration.
  Neon pooler URLs are rejected for the direct connection. Each repair checks
  the two connections against a committed random database marker before using
  it. For other providers, the operator must supply a true direct endpoint.
  A repair invocation opens at most one direct connection and closes it after
  use. Concurrent repair invocations each require a separate connection; there
  is no global concurrency cap, so database connection limits constrain scale.
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
