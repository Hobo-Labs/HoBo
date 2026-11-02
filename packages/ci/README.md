# HoBo.CI

HoBo CI is a sibling SDK family in the HoBo monorepo:

The product CLI exposes repository setup and run commands through `hobo ci`;
see [CLI setup and Vercel command parity](../hobo/CI.md). This package and the
Actions client package include public package metadata and MIT licenses so the
published CLI can resolve its CI dependencies. No registry publication follows
from changing that metadata.

| SDK | State |
| --- | --- |
| `@hobo/ci` | Portable pipelines, allocation routing and durable budget reservations |
| [`@hobo/ci-gh-actions`](../ci-gh-actions/README.md) | Hosted relay, tenant API, repository installer and JIT-runner host |
| [`@hobo/ci-vercel`](../ci-vercel/README.md) | Vercel relay hosting and local execution of Vercel CI-tagged Turbo checks |
| [`@hobo/ci-dagger`](../ci-dagger/README.md) | Native Dagger CI checks on local/self-hosted engines and portable SDK adapter |
| [`@hobo/ci-cf`](../ci-cf/README.md) | Implemented native Cloudflare CI adapter |
| [`@hobo/ci-ado`](../ci-ado/README.md) | Local command checks and self-hosted Azure Pipelines configuration |

A Sandbox offer requires a trusted current rate card for CPU, provisioned
memory, creation, network, proxy, bootstrap and any host charges. The quote reserves
resource usage for the maximum runtime using integer microdollars; optional
`SandboxAllowance` values represent verified remaining free CPU vCPU-ms,
memory MB-ms, egress bytes, creation count, proxy bytes and proxy sessions.
When an isolated proxy VM is required, the quote includes both VMs' CPU,
provisioned memory and network, two creations, a bounded number of metered
control-plane calls, and explicit bootstrap estimates. Both VMs must use the
same Vercel project, region and published rate card to share an allowance. The
plan's vCPU and session-duration limits are checked before reserving. The proxy's
public ingress, DNS, TLS and other platform overhead are not bounded by the
application quota. Each dimension is reserved across concurrent jobs and settled
against observed usage. An omitted allowance means zero, not an inferred provider free tier.
`observedAt` must describe the inclusive provider snapshot; a rate or allowance
change needs a newer timestamp. Network headroom and proxy rates are configured
estimates: Vercel's billed TLS, DNS, Function CPU, memory, request and transfer
charges are not completely measured by the payload proxy. The trusted publisher
must set nonzero per-resource rates and a separate nonzero `bootstrapFixedMicros`
estimate for fetching and uploading the 228 MB runner archive on every launch. Actual spend may exceed
the reservation. HoBo records overruns and blocks subsequent unaffordable work;
this estimate is not a hard billing cap or proof of the globally cheapest price.
A publisher must obtain and refresh provider-specific rates and free balances;
no live Vercel inventory or price verification is built into this package.

## PostgreSQL hosting adapter

`PostgresCiStore` (`@hobo/ci/postgres`) stores journal events, leases, queued
jobs, terminal tombstones, policy records, and verified webhook deliveries in
PostgreSQL tables. Mutations lock a partition row, check policy revisions and
commit all affected records together. GitHub and provider calls run outside the
transaction. A scoped index lets recovery read active leases and their latest
launch intents without reading historical jobs or the entire event journal.

A partition's first open atomically imports an existing SQLite snapshot and
retains that original snapshot in `hobo_ci_snapshot_backups`. The migration
preserves event and inbox ordering, claim state, deduplication fingerprints and
control records. A database constraint prevents an older snapshot-based relay
from overwriting the migrated partition. **Rollback to old relay code is not
supported:** the backup predates subsequent native writes. Drain old relay
instances before migration, back up PostgreSQL, and restore only after reconciling
all active runners and post-migration journal changes.

The previous 28/32 MiB serialized-snapshot thresholds no longer apply. The
partition lock still serializes all mutations for all accounts in that partition;
account lease history is read for routing, and journal events, terminal tombstones
and delivery fingerprints are not automatically archived. Monitor transaction
latency and database growth and implement retention before operating at sustained
scale. Removing completed webhook bytes from the current row does not erase
PostgreSQL MVCC, WAL, replicas or backups; apply appropriate retention policies.

The signed webhook body is hashed independently of GitHub's unsigned delivery
ID and event headers. Exact byte-identical bodies for one installation received
within 24 hours are acknowledged as duplicates without creating another inbox
row, even if their delivery IDs differ. Such bodies represent the same signed
payload; different payload bytes remain distinct. At ingress, the event header
must agree with the authenticated body shape before this check. The first
accepted delivery retains its ID and fingerprint, including for an authenticated
but unconnected installation; a duplicate alias is not stored as a new ID.
Completed legacy snapshots whose raw payload was already erased cannot acquire
a body hash retroactively.

Admission is limited to 600 distinct bodies per installation per rolling minute
10,000 outstanding deliveries and 64 MiB of outstanding payloads per installation. A limit refusal does not
acknowledge an unrecorded delivery; GitHub delivery repair and monitoring must be
operational, and operators should review these ceilings against expected load.
These controls do not replace signature validation or GitHub-side access control.

A verified in-progress assignment records the exact repository, job and attempt
against its runner lease. It suppresses stale queued demand and cancels only an
unlaunched duplicate reservation. Launched or ambiguous hosts retain their
budget until reconciled. A job may be released for requeue only after a fresh
GitHub job read proves it is queued and the assignment owner still matches.

A sandbox byte quota can be bound to a verified account, lease, session and
configuration revision. Each successful reservation commits before forwarding;
ambiguous writes are not refunded. This primitive requires an authenticated
proxy and a trusted policy-derived ceiling before it can enforce an egress cap.
Verified sandbox charges can exceed reservations and are recorded as actual cost
with a `ci.BudgetOverrun` event; such a reservation is not a hard spending cap.

Sandbox offers do not use runner-minute free balances. A trusted, current provider
observation may instead supply remaining CPU, memory, network, creation and proxy
resource allowances. Admission subtracts held reservations and usage settled
since that observation. Each lease freezes its reserved quantities; settlement
records measured consumption no greater than those quantities, so a later job
cannot reuse the same credits. Missing allowance evidence counts as zero free
units. An observation is only as reliable as its publisher; this accounting
alone does not verify vendor entitlements or billed usage.

Run the real PostgreSQL integration contract against a disposable local database
by setting `HOBO_CI_TEST_POSTGRES` and executing
`node --import tsx packages/ci/scripts/postgres-contract.ts`. It checks concurrent
reservations, revision and settlement fencing, quota races, webhook deduplication,
quarantine/replay, snapshot migration, old-writer refusal, admission beyond 32 MiB,
and adapter reopen. It does not verify deployed provider billing.

The GitHub Actions target keeps the original workflow and its logs, artifacts,
permissions, environments, dependencies and status checks. After one-time repository
connection, user workflows select `runs-on: hobo`.

Routing considers only enabled, acknowledged provider offers owned by this account.
It reserves the complete host timeout, including startup, under a durable transaction.
HoBo first selects eligible offers that consume usable measured free allocation,
then chooses the lowest projected paid cost among them. When no eligible offer can
consume free allocation, it chooses the lowest projected paid cost among all offers.
`@hobo/dispatcher` applies deterministic tie-breaking. A partial free allowance
can leave a paid remainder that costs more than a fully paid alternative.
A job stays on its selected machine until it finishes.
Provider budgets and concurrency limits can cause another eligible provider to win.
If none qualifies, the job remains durably queued. Allocation must remain valid for
the entire reserved host duration, as must pricing evidence, for an offer to qualify.
Sandbox evidence also covers any extra reserved proxy VM duration.

Unknown balances are zero. Offers require an observation time, expiry/freshness
limit and evidence URL. Prices are account-supplied integer USD microdollars per
minute, including applicable platform fees; this package ships no vendor price
catalog or assumed marketing allowances. One microdollar is $0.000001. Each provider
account entitlement has one account/offer owner; there is no cross-tenant pooling.

`Offer.freeMinutes` is measured in **minutes on the selected runner SKU**, not
in the provider's shared base-unit minutes. Blacksmith's x64 free balance and
Depot's included balance are measured in 2-vCPU Linux equivalents, so a 4-vCPU
runner consumes two base minutes for each runner minute. Convert a freshly
measured balance before publishing the offer:

```ts
import { providerFreeRunnerMinutes } from '@hobo/ci';

const freeMinutes = providerFreeRunnerMinutes({
  provider: 'blacksmith',
  runsOn: 'blacksmith-4vcpu-ubuntu-2404',
  remainingBaseMinutes: 100,
}); // 50 runner minutes
```

The helper recognizes the documented x64 Linux Blacksmith and Depot labels only,
rejects unknown SKUs, and rounds fractional conversions down so it cannot grant
more allocation than observed. Its conversion rules are based on the [Blacksmith
runner documentation](https://docs.blacksmith.sh/blacksmith-runners/overview)
and [Depot runner types](https://depot.dev/docs/github-actions/runner-types).
It does not fetch, authenticate or independently verify vendor balances or prices;
the trusted observation publisher must do that and supply an evidence timestamp
and expiry. Pricing and entitlements may change. The single-offer-per-provider-
account rule prevents double-spending the shared entitlement, but means switching
SKUs requires replacing that offer after its active leases have settled.
Depot measures usage by the second; the host's whole-minute settlement is a
conservative estimate, not a replacement for a vendor invoice.

Usage snapshots are inclusive. `Account.spentMicros` must include all completed
usage through `Account.usageObservedAt`; each `Offer.spentMicros` and remaining
`freeMinutes` must include consumption through that offer's `observedAt`.
Publish the amount/balance and its watermark together. Routing adds only local
usage completed after the corresponding watermark and always holds outstanding
reservations. A late settlement uses its actual completion time. If the account
watermark is omitted, its spend is an external-only baseline and every local
settlement is added; do not combine that mode with an inclusive account total.

There is no automatic invoice ingestion or monthly budget rollover. Start a new
budget-period partition only after reconciling all active leases; retain the old
journal for audit.

Contracts are generated from `data-models/ci.proto`; CUE constraints and valid/invalid
fixtures are exercised by schema-tools. `parseConfiguration` is the configuration
boundary. Routing is pure over the account, persisted leases and injected time.
The relay owns the `ci.*` command/event lifecycle and SQLite projection (see its ADR).

Validation: `pnpm --filter @hobo/ci build`, `pnpm --filter @hobo/ci test`,
`pnpm codegen --filter packages/ci`, and
`pnpm codegen:check --filter packages/ci`.


## Local development machines

An account can offer its own development machine with `provider: "local"`,
`backend: "gh-actions"`, `runsOn: "hobo-local-host"`, and `concurrency: 1`.
The workstation has zero provider runner-minute price and zero free-minute
credits; its explicit `observedAt`, `validUntil`, HTTPS `sourceUrl`, and
`bridgeAcknowledged` evidence remain mandatory. Do not invent an allocation
balance to make an offline workstation eligible. Disable the offer when the
machine is unavailable and refresh its observation before expiry.

This uses the existing trusted-private-repository workflow bridge on Linux x64.
The persistent dev runner hosts the bridge on `hobo-local-host`; the bridge
claims a single-use ephemeral `hobo` runner for the reserved original job.
Giving the persistent runner the `hobo` label would bypass lease admission and
is unsupported. Public repositories, fork jobs and untrusted pull requests
retain the bridge's existing refusal. The developer machine is shared execution
with access to its files and Docker; it is not an isolated runner offer.

A local-only account can run with a zero monetary budget. Cloud offers still
follow the documented free-allocation-first ordering; enable only the local
offer in a dev policy when execution must stay on the workstation. One active
or uncertain lease occupies the workstation slot; additional jobs stay queued
until verified host completion and runner cleanup release it.

The existing protobuf Offer/Policy strings carry this provider without a wire
format change. CUE local-offer fixtures, `test/local-provider.test.ts`, and the
relay's local-provider bridge contract cover dependent constraints, budget-free
admission, queuing, OIDC/JIT attribution and cleanup. The connected `act` corpus
also executes the original workflow for a local-provider reservation; live
GitHub assignment remains separate evidence.

## Swap execution backends

`parsePipeline` constructs a deeply frozen command plan. `executePipeline` accepts
that exact plan and any `PipelineBackend`: `createActionsBackend({workspace})`,
`createDaggerBackend({sourceDirectory,image,connect?})`, or
`createCloudflareBackend({context,terminate,verifyShutdown?})`. Source workspaces
are bound by the host integration, rather than embedded host paths in pipeline
authoring. The shared subset includes sequential argv commands, relative cwd,
per-step environments, exact exit/stdout/stderr, tracked-file changes, bounded
binary file artifacts and acknowledged cancellation. The same fixture corpus
executes real local commands through every shipped adapter.

```ts
import { parsePipeline, executePipeline } from '@hobo/ci';
import { createActionsBackend } from '@hobo/ci-gh-actions';

const boundBackend = createActionsBackend({workspace: process.cwd()});
const pipeline = parsePipeline(JSON.stringify({
  id: crypto.randomUUID(), accountId: 'my-account', timeoutSeconds: 300,
  steps: [{id: 'test', argv: ['npm', 'test'], cwd: '.', env: {}}],
  artifactPaths: [],
}));
const result = await executePipeline(boundBackend, pipeline);
```

`HOBO_CI_EXECUTION_ID` is reserved metadata set to the logical execution ID on
all three backends. In Dagger it also prevents a new logical execution from using
a prior command's cached side effects. A pipeline ID is an idempotency key for
one logical run and source revision: use a run/attempt/revision-derived ID or a
UUID for a new execution, and reuse it only to replay that execution. Rebinding
a different source directory/revision while reusing an old ID does not request
a new run. Relative workspace paths are portable; host absolute paths and
provider-specific toolchain/environment defaults are not part of this contract.

## Apply routing and budgets

The Node coordinator `PipelineScheduler` from `@hobo/ci/scheduler` uses
`LeaseStore` from `@hobo/ci/store`. The original Actions relay uses the same
ledger, so its reservations and native pipelines cannot spend the same balance.
Bind eligible account offer IDs to real, account-scoped backend contexts;
construct `new PipelineScheduler(store, account.id, bindings)` for that account.
The scheduler rejects another account even if its offer IDs are identical.
`Offer.backend` is `gh-actions` (the legacy empty default), `dagger`, or `cf`.
The scheduler filters missing/incompatible backend bindings before free-first
ranking. Native reservations cover the pipeline's bounded runtime rounded to a
minute plus account startup allowance, within the account maximum.

Admission, reservation, execution intent, completed results and replay commit
through the actor journal. A completed identical request returns the stored
result without another charge. A changed command plan with the same ID is
rejected. Only a definitive `BackendUnavailableError` before allocation permits
automatic fallback; unknown launch, interrupted execution or unconfirmed stop
retains an `uncertain` reservation. Ordinary command failure never retries
side effects on another provider. On process startup call `store.recover()`
with current ISO time before accepting commands.
Recovery cancels native reservations that never recorded launch intent so they
can be admitted against current policy; interrupted running leases remain uncertain.

The root entrypoint and scheduler target Node. Cloudflare Workers import the
portable `@hobo/ci/execution` entrypoint, which has no Node ledger or Dispatcher
imports. Budget admission belongs to the authenticated control plane before
the Worker pipeline starts. Native adapters execute inside their explicitly
bound engine/workspace; the Node relay does not become a vendor runner.

Run `pnpm --filter @hobo/ci-gh-actions act:install --directory /tmp/hobo-ci-tools`
and `pnpm --filter @hobo/ci-gh-actions test:act --act /tmp/hobo-ci-tools/act`
for actual local workflow execution. See its `act/README.md` for evidence and
boundary details. The ordinary test lane includes the cross-backend command
corpus, budget policy regressions and the SDK protocol contracts.

## Persistent platform policy

`LeaseStore.configure(configuration, expectedRevision, at)` commits generated
`ConfigurationState` and its audit event with compare-and-swap semantics. Active
leases prevent destructive provider or repository identity changes. Configuration
and generated control-operation records are replayed with the lease projections.
While leases are active, the same transaction rejects expanding a connection's
event or branch allowlists or enabling all pull requests. Narrowing these
allowlists remains available to revoke authority during in-flight checks.
The GitHub relay exposes account-scoped policy/repository APIs over this actor.

`Account.usageObservedAt` and `Offer.observedAt` are inclusive usage-snapshot
watermarks. Published spent amounts include all completed usage through the
watermark; free minutes are the remaining allocation then. Only later completed
local usage is added. `Lease.usageCompletedAt` separates actual completion from
late reconciliation, so refresh does not charge already-observed jobs twice.
Snapshots must be complete, fresh and from the account's trusted platform
publisher; this SDK does not invent vendor balances or invoice accuracy.

Connections permit public repositories only with explicit
`publicRepositoryAcknowledged` and the existing repository-wide trust contract.
No new demand may use a connection revoked while asynchronous validation awaited.
An `isolatedOnly` connection has no workflow bridge and reserves only isolated
runner offers, including for private pushes. It requires explicit
`acceptAllMatchingRepositoryJobs` and `publicRepositoryAcknowledged` consent,
and must have empty event and branch filters: every matching job may run.
Changing that isolation mode
requires draining active leases. The local workflow-bridge store leaves such
jobs queued rather than selecting a shared host.


Broker-to-CI routing contracts include `BudgetSignal` and `BudgetRoutingPolicy`.
The Station adapter changes offer eligibility through the account API and stores
per-threshold cycle/crossed maps on `Account`. The journal rejects discarded or
regressed watermarks and same-cycle state changes; replay preserves ordering.
Inclusive monetary snapshots remain independent of routing signal state.


## Author CI policy

`defineCiPolicy` constructs a frozen, generated desired-policy record without
performing network requests or embedding provider credentials. Connection refs
name Station-owned bindings; they are resolved and authorized by the host at
apply time. The policy cannot contain spent amounts, free balances, signal
watermarks or lease records. The parser accepts only the existing trusted Linux
x64 `hobo` pool, explicit runner labels, USD microdollar account caps and a
manual budget period; it rejects automatic rollover until that is implemented.
Empty threshold `allow` arrays mean pause when the threshold is active.

```ts
import { defineCiPolicy } from '@hobo/ci';

const policy = defineCiPolicy({
  accountId: 'acme', tenantId: 'acme',
  pool: { label: 'hobo', os: 'linux', architecture: 'x64' },
  providers: [
    { id: 'github', kind: 'github', connectionRef: 'github-ci', runsOn: 'ubuntu-24.04', enabled: true },
    { id: 'blacksmith', kind: 'blacksmith', connectionRef: 'blacksmith-ci', runsOn: 'blacksmith-2vcpu-ubuntu-2404', enabled: true },
    { id: 'isolated', kind: 'vercel', connectionRef: 'vercel-ci', runsOn: 'sandbox', enabled: true },
  ],
  budget: { scope: 'ci-account', currency: 'USD', limitMicros: 100_000_000, period: 'manual', timeZone: 'UTC' },
  routing: { strategy: 'lowest-total-incremental-cost', noEligibleProvider: 'queue', unknownAllocation: 'zero' },
  thresholds: [{ fraction: 1, allow: [] }],
});
```

Authoring does not itself create provider Connections or publish policy. A
managed host must authorize each Connection, store operator intent separately
from dynamic budget/health eligibility, and expose a server-side desired-policy
write boundary; `putPolicy(Account)` is a legacy full-state API and must not be
treated as a safe desired-only write. Policy contracts, CUE fixtures, the
`desired-policy` Pact and `test/policy.test.ts` cover authoring.
The `vercel` declaration must match a separately provisioned Sandbox offer; its
`runsOn` value identifies that offer and is not a GitHub runner label. Public
repository and pull request jobs currently require an isolated Sandbox offer.

## Azure Pipelines and shared workspace execution

[`@hobo/ci-ado`](../ci-ado/README.md) provides local command preflight and generates
Azure DevOps Services YAML for an explicitly named self-hosted Linux agent pool,
with native Pipeline Artifact publication and downstream download/hash verification.
It uses the same portable Pipeline
contract. Full Azure YAML execution remains with Microsoft's official agent.
Scheduler hosts can bind `createAdoBackend({ workspace })` as backend `ado` with
an authorized `provider: "azure-devops"` offer. Provider/backend pairing is checked
at the configuration boundary; desired policies accept `kind: "azure-devops"`.
The binding executes its host workspace directly and retains the scheduler's
durable lease/result replay. It does not install agents or queue remote pipelines.
Account prices and entitlements require authorized observations.

The Node-only `@hobo/ci/workspace-backend` entrypoint owns shared POSIX process,
path, cancellation and bounded-file artifact handling for Actions and ADO. It
inherits only host plumbing and explicit step environments. The Worker-safe
`@hobo/ci/execution` entrypoint remains free of Node process/filesystem imports.

## GitHub Actions fabric (Hobo-Labs/HoBo)

Production workflows live under [`.github/workflows/hobo-ci.yml`](../../.github/workflows/hobo-ci.yml)
and [`.github/workflows/examples-e2e.yml`](../../.github/workflows/examples-e2e.yml).
They run on self-hosted **`hobo`** JIT runners and declare `merge_group` for
GitHub's native merge queue on `main`. Optional local signoff (`gh-signoff`,
Basecamp) does not replace the authoritative CI gate. Third-party actions pin
full commit SHAs (catalog: [`.github/action-pins.env`](../../.github/action-pins.env);
enforced by `pnpm run actions:lint`).

One-time org transfer steps:

1. Re-register self-hosted **`hobo`** runners against **Hobo-Labs/HoBo** (runners tied to the old personal repo do not follow a transfer).
2. Enable the merge queue on `main` branch protection and require the HoBo CI check names (including **Main full gate** for queued merges).
3. Set repository variables/secrets: `TURBO_TEAM` and `TURBO_TOKEN` (Vercel remote cache; fork PRs write read-only remotely).

If CI runs stay **`queued`** with no runner name, see **[RUNNER-QUEUE.md](./RUNNER-QUEUE.md)** (relay webhook, isolated onboarding, Sandbox host, JIT label contract).

Probe the production relay (default `https://hobo-ci.vercel.app`):

```sh
node --import tsx scripts/ci/verify-relay-dispatch.mts
```

Native Dagger checks use [`.hobo/dagger.json`](../../.hobo/dagger.json); see [`@hobo/ci-dagger`](../ci-dagger/README.md). Manual runner acceptance: [`.github/workflows/hobo-ci-acceptance.yml`](../../.github/workflows/hobo-ci-acceptance.yml) (optional `dagger_acceptance` input).
