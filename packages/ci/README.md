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
| [`@hobo/ci-gh-actions`](../ci-gh-actions/README.md) | The relay (one core, with its Node service host for `hobo ci serve` and the container image), tenant API, repository installer and JIT-runner host |
| [`@hobo/ci-vercel`](../ci-vercel/README.md) | The Vercel host of that same relay, and local execution of Vercel CI-tagged Turbo checks |
| [`@hobo/ci-dagger`](../ci-dagger/README.md) | Native Dagger CI checks on local/self-hosted engines and portable SDK adapter |
| [`@hobo/ci-cf`](../ci-cf/README.md) | Implemented native Cloudflare CI adapter |
| [`@hobo/ci-ado`](../ci-ado/README.md) | Local command checks and self-hosted Azure Pipelines configuration |

The legacy allocation and sandbox quote implementations live behind
`@hobo/pricing/legacy`. The original `src/accounting.ts` and
`src/sandbox-pricing.ts` imports remain as thin re-exports, preserving the CI
public API and existing reservation/settlement behavior.

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

## Event cursor

Every lease and job change is appended to the partition's event journal inside
the transaction that makes it, so the journal is already the record of what
changed. `eventsSince({accountId, after, limit})` on `LeaseStore`,
`SqliteCiStore` and `PostgresCiStore` reads it as a change feed: an account's
events after a journal position, oldest first, with the position to read after
next (`CiEventPage`, each event a `SequencedCiEvent`). Without `after` it
returns the account's newest events. `leaseEvents({accountId, leaseId, limit})`
reads one lease's newest events by the lease's id, through the lease index.
Both are projections over the journal, not a second bus: nothing is written
to serve them, and no schema changed.

- **Order.** The position is the journal's own key (`seq`). A partition has one
  writer at a time (SQLite) or serializes its transactions at the partition
  lock row (Postgres), so `seq` order is commit order and a cursor never skips
  an event. The Postgres read fixes the journal's head first and scans up to
  it, so a row committed while it runs is left whole for the next read.
- **Scope.** An event belongs to the account it names, and the query selects
  by that name. A job event recorded before or apart from a lease
  (`ci.JobQueued`, `ci.JobExpired`, `ci.JobCompleted`,
  `ci.JobAssignmentCleared`) is written with the account whose connection
  holds the job's repository and installation at that moment (`jobAccountId`
  in `src/event-log.ts`), so it stays that account's however the connection
  moves later. Job events journalled before this was recorded name no account
  and are in nobody's feed. Partition events such as `ci.ConfigurationChanged`
  name no account and are never returned.
- **Bounds.** A page holds at most 500 events. One read looks along at most
  10,000 of the partition's journal rows (`EVENT_SCAN_SPAN`), by the journal's
  own index, so its cost does not depend on how much other accounts, or other
  partitions sharing the table's sequence, have written. The page
  says when that cut it short: `more` when a cursor read stopped before the
  end of the journal (an empty page is then not "caught up"; read again from
  `cursor`), `truncated` when a read of the newest events did not fill the
  page and did not look back to the journal's start. Reading an account's
  events by an index on the account would lift the bound; the events table has
  none, and the generator refuses an expression index on an existing table, so
  that is a hand-written migration and has not been done.

**Observers.** `PostgresCiStore.observer()` is the store as something that
only watches reads it (`CiObserver`): configuration, a lease, an account's
leases, pending jobs, quarantined deliveries, the journal's head and the two
event reads, each
returning the last committed state without the partition lock every other
method takes. An agent or a dashboard reading through it is never queued in
front of webhook admission or the worker, nor behind a long mutation.
`SqliteCiStore` satisfies the same port directly.

The shared store contract (`packages/ci-gh-actions/test/ci-store-contract.test.ts`)
holds both engines to this behaviour, and on Postgres also proves an observer
reads while the partition lock is held and that a read says when a neighbour's
volume cut it short; `test/event-log.test.ts` covers the page arithmetic and
ownership at write time. The relay's MCP server is the consumer: see
[`@hobo/ci-gh-actions`](../ci-gh-actions/README.md#mcp-server).

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
alone does not verify vendor entitlements or billed usage. Exact decimal
allocation helpers (`allocationQuote`, `divideDecimalAtMost`) are implemented in
`@hobo/pricing/legacy` and re-exported from this package for compatibility.

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
The default `min-cost` objective chooses the lowest complete projected paid cost.
Explicit `maximize-credits` first prefers offers consuming usable measured free
allocation, then minimizes their paid remainder. `@hobo/dispatcher` applies
deterministic tie-breaking. A partial free allowance can leave a paid remainder
that costs more than a fully paid alternative.
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


## Postgres schema and migrations

The relay's PostgreSQL tables are declared in Drizzle and migrated from that
declaration. Three packages own tables, and each keeps its own `db/` directory:

| Package | Schema | Tables |
|---|---|---|
| `@hobo/ci` | [`db/schema.ts`](db/schema.ts) | the 13 `PostgresCiStore` tables: partitions, snapshot backups, events, leases, terminal/assigned/pending jobs, configuration, control records, sandbox egress, sandbox proxies and their requests, inbox |
| `@hobo/ci-gh-actions` | [`../ci-gh-actions/db/schema.ts`](../ci-gh-actions/db/schema.ts) | 13 tables: App states, credentials and installations; OAuth states and sessions; the platform-App fence, attempts and invitations; queued-scan cursors and API budget; webhook repairs, scan cursors and successes |
| `@hobo/ci-vercel` | [`../ci-vercel/db/schema.ts`](../ci-vercel/db/schema.ts) | 2 tables: database probes, worker health |

The shared tooling is in [`db/tooling/`](db/tooling/index.ts). It is development
and operations code: nothing under `src/` imports it, `drizzle-orm` and
`drizzle-kit` are dev dependencies, and every query the relay runs is still
hand-written SQL through `pg`.

### How a migration is produced

`pnpm --filter <package> run db:generate` follows
[ADR-0160](../../docs/design/adr/03-data-plane.md#adr-0160):

1. [`@hobo/adapter-drizzle`](../adapters/adapter-drizzle/README.md) ingests
   `db/schema.ts` into the canonical `SchemaIr` and lists, as impedance
   findings, every construct the IR cannot carry.
2. The adapter's engine diffs the previous IR against it with core's canonical
   differ. The result is a HoBo `MigrationPlan`: phased, forward-only, and
   stamped with the installed drizzle-kit version, so a toolchain upgrade
   changes the plan digest.
3. drizzle-kit renders the SQL. The tooling is the emitter the adapter asks its
   host for: it pairs each statement with the plan step it implements, and the
   adapter refuses if a step is left without SQL.

It writes three files into `db/migrations/`:

- `NNNN_<name>.sql`: what runs. Each statement carries a `-- step:` comment
  naming its plan step and an `IF NOT EXISTS` guard.
- `journal.json`: the migrations in order, each with its plan (steps, engine,
  digest), the SHA-256 of its SQL, its impedance findings, its fallback
  bindings and the violations query the runner checks before recording it.
- `snapshot.json`: the schema after the last migration, which the next diff
  starts from.

A migration is never edited after it is generated; the runner refuses SQL that
no longer hashes to what the journal recorded.

### What the canonical IR does not carry

The IR models tables, columns (type, nullability, single-column primary key and
unique, literal defaults) and indexes on plain columns. The relay's schema
needs more, and all of it is still in the SQL because drizzle-kit renders it
from the Drizzle definition. The journal names each case:

| Construct | Where | What happens |
|---|---|---|
| Composite primary key | 12 tables | Rendered inside `CREATE TABLE`; not diffed |
| Table-level `UNIQUE` | sandbox egress, sandbox proxies | Rendered inside `CREATE TABLE`; not diffed |
| `CHECK` | partitions snapshot guard, platform-App singleton | Rendered inside `CREATE TABLE`; not diffed |
| `DEFAULT now()` and `bigserial` sequence defaults | 5 columns | Rendered inside `CREATE TABLE`; not diffed |
| Partial index predicate | 3 inbox indexes | Index is planned on its columns; the `WHERE` is rendered but not diffed |
| Expression index | 4 indexes on `body::jsonb ->> '…'` | Not in the IR at all, so there is no plan step. Its `CREATE INDEX` is bound to the owning table's `create-table` step and recorded under `fallbacks` |

A later change to only one of these (a new predicate, a different check) is
invisible to the differ. The generator refuses such a change rather than emit
SQL with no plan behind it, and that migration has to be written by hand.

### Applying migrations

```sh
HOBO_CI_MIGRATE_URL=postgres://… pnpm --filter @hobo/ci run db:migrate
HOBO_CI_MIGRATE_URL=postgres://… pnpm --filter @hobo/ci-gh-actions run db:migrate
HOBO_CI_MIGRATE_URL=postgres://… pnpm --filter @hobo/ci-vercel run db:migrate
```

One run is one transaction. It takes an advisory lock, plus the locks the
package's stores take when they initialise, and records each applied migration
in `hobo_ci_schema_migrations` (`scope`, `id`, `sql_sha256`, `plan_digest`,
`engine`, `applied_at`), keyed by package and migration. A later run skips what
is recorded, after checking the recorded digest still matches. A migration is
recorded only if its violations query returns no rows: every column the IR
describes is present with the right type and nullability, and every index and
named constraint the SQL creates exists. Otherwise the run rolls back.

The ledger is the one relay table outside the declared schema. The runner
creates it, because it has to exist before the first migration can be recorded.

### Existing databases

The baseline is safe to apply to a database the relay has already been running
against. Every statement is guarded, so it creates only what is missing and
leaves existing tables and rows alone; that also covers a database where some
stores have not initialised yet. Applying it is how such a database is
baselined: nothing changes, and the ledger gains its first row.

It is not a repair tool. A table at an older layout is skipped by the guard, and
the run is then refused: an index on a column that is not there fails, or the
violations query reports the gap. Start the current release against that
database first, so the stores' own `ALTER TABLE` statements bring it forward,
then migrate.

A database with history can differ from a new one in ways the migration neither
causes nor removes. A column that `ALTER TABLE` added to an existing table sits
after the older columns and keeps the `DEFAULT` it was added with, where a new
database has it in `CREATE TABLE` position without one. Today that affects
`hobo_ci_platform_app_attempts.created_ms` only, and the test suite pins it.

### The stores still run their own DDL

`initialize` on each store still creates its tables with the DDL embedded in
`src/`. That is deliberate for now: the stores interleave DDL with data
migration (the SQLite snapshot import, the inbox hash backfill) under their own
locks, and replacing that path changes how every deployment starts. So
`db/schema.ts` is the declared source, the embedded DDL is the runtime path, and
two checks keep them identical:

- `db/migrations/embedded-ddl.lock.json` lists every DDL statement under
  `src/` that names a `hobo_ci_` object, whichever file it is in. The test suite
  re-reads the source on every run, without a database, and fails if a
  statement was added, removed or reworded.
- Only `db:verify` writes that lock, and only after it has built one database
  from the embedded DDL and one from the migrations on a real PostgreSQL and
  found their catalogs identical: tables, columns (position, type, nullability,
  default), primary-key, unique, foreign-key and check constraints, every index
  definition including expressions and predicates, and sequences. It also
  migrates a seeded copy of the embedded-DDL database and requires that neither
  its catalog nor any row changes, and that a second run applies nothing.

To change the schema: edit `db/schema.ts`, run `db:generate -- --name <words>`,
make the same change in the store's embedded DDL, then run
`HOBO_TEST_POSTGRES_URL=postgres://… pnpm --filter <package> run db:verify`
against a disposable PostgreSQL whose role may create databases. `db:check` runs
the database-free checks on their own.

The same proof runs in the test suite when `HOBO_TEST_POSTGRES_URL` is set
(`test/postgres-schema.test.ts`, `test/postgres-schema-lineage.test.ts`) and is
skipped otherwise.

### Not done yet

- The stores do not apply migrations; `db:migrate` is an operator step, and no
  deployment runs it automatically.
- Generation is a development step that checks its output in. ADR-0160's
  deploy-owned generation at the plan phase, and the gated
  expand → backfill → contract saga in `@hobo/trails` with its `migration.*`
  events, are not wired to the relay.
- The generator emits additive statements only: `CREATE TABLE`, `CREATE INDEX`
  and `ADD COLUMN`. A drop, a type change, a `NOT NULL` column that needs a
  backfill, or an expression index added to an existing table is refused.
- No CI lane provides a PostgreSQL, so the equivalence proof runs only where a
  developer or operator supplies one. The lock is what CI enforces.
- A drizzle-kit upgrade has not been exercised. A migration keeps the version it
  was generated with; `db:check` re-renders the baseline with the installed
  toolchain and fails if the SQL comes out different, which then needs a
  decision, not a regeneration, because applied migrations are never rewritten.
- SQLite stores (`store.ts`, `sqlite-store.ts`) are out of scope and unchanged.

## Local development machines

A local box is also a tier in runner routing: when the fleet is not taking
jobs, a run's jobs ask an enrolled local box (`hobo-local-host`) before they
ask GitHub-hosted runners. `selectFleetBackend` orders the fleet, ARC, the
local box, then GitHub-hosted; see "Runner routing" in
[RUNNER-QUEUE.md](RUNNER-QUEUE.md).

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
`LeaseStore` from `@hobo/ci/store`. The Actions relay uses the same ledger
(its SQLite store, `SqliteCiStore` from `@hobo/ci/sqlite`, wraps `LeaseStore`;
`PostgresCiStore` implements the same port), so its reservations and native
pipelines cannot spend the same balance.
Bind eligible account offer IDs to real, account-scoped backend contexts;
construct `new PipelineScheduler(store, account.id, bindings)` for that account.
The scheduler rejects another account even if its offer IDs are identical.
`Offer.backend` is `gh-actions` (the legacy empty default), `dagger`, or `cf`.
The scheduler excludes missing/incompatible backend bindings from selection while
retaining their payer measurements for all-of budget constraints. Ranking follows
the authored objective. Native reservations cover the bounded runtime rounded to a
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
The persisted queue deadline is exclusive: allocation is refused at or after that
instant, including after asynchronous provider preflight. A claimed financial hold
is retained until native final usage or valid unused-release evidence resolves it.

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
jobs queued rather than selecting a shared host. If isolation is required after a
PostgreSQL runner was reserved, the store cancels the unused lease and requeues
the demand. A shared financial hold remains in place until an independently
verified unused-evidence reference is supplied to `releaseUnusedSharedBudget`
after that cancellation is durable; an unknown or claimed effect cannot be
released merely because the local lease was cancelled.


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

Optional fleet overflow stays disabled in [`.hobo/ci.json`](../../.hobo/ci.json). Enable `github-hosted` (`ubuntu-24.04`) or `hostinger-arc` (kubernetes scale set, `runsOn: hobo-arc`) only when a full hobo fleet should spill. The default machine type is `ubuntu-24.04`. Policy and `#CiPolicyProvider` CUE both reject `ubuntu-latest` (invalid fixture `desired-policy-github-latest.json`). Bound overflow labels are not re-relayed to hobo, and ARC leases are not aborted as isolated hosts. See [RUNNER-QUEUE.md](./RUNNER-QUEUE.md).

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
2. Enable the merge queue on `main` branch protection and require the HoBo CI check names. **Main full gate** runs after merge (push to `main`), not on `merge_group`; to make it a required queue check, add `merge_group` back to its `if:` first, or the queue waits for a check that never reports.
3. Set repository variables/secrets: `TURBO_TEAM` and `TURBO_TOKEN` (Vercel remote cache; fork PRs write read-only remotely).

If CI runs stay **`queued`** with no runner name, see **[RUNNER-QUEUE.md](./RUNNER-QUEUE.md)** (relay webhook, isolated onboarding, Sandbox host, JIT label contract).

Probe the production relay (default `https://hobo-ci.vercel.app`):

```sh
node --import tsx scripts/ci/verify-relay-dispatch.mts
```

Native Dagger checks use [`.hobo/dagger.json`](../../.hobo/dagger.json); see [`@hobo/ci-dagger`](../ci-dagger/README.md). Manual runner acceptance: [`.github/workflows/hobo-ci-acceptance.yml`](../../.github/workflows/hobo-ci-acceptance.yml) (optional `dagger_acceptance` input).

`#Offer` guards every `backend` comparison behind `backend != _|_`: CUE 0.14 rejects references to an absent optional field, so unguarded `if backend == …` clauses broke `cue vet` for offers without a backend.
