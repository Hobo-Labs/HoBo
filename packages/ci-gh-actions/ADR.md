# Original-job relay

One relay core serves every host. `HostedRelay` holds admission, reservation,
dispatch, runner claim and reconciliation; `createHostedRelayRuntime` puts the
durable webhook inbox and the worker tick around it; `createHostedControlPlane`
is the account API; `createRelayHandler` is the HTTP surface. A host supplies a
store (`SqliteCiStore` or `PostgresCiStore`, one port), whatever calls the tick,
and its runner backends. The earlier synchronous relay, its own HTTP handler
and control plane, and its own poller are gone: there is nothing left to keep
in step. See [the README](README.md#one-relay-thin-hosts) for the host table.

The implementation is an application-layer consumer of `@hobo/ci`. It does not
replace HoBo's Dispatcher or reuse `workflow_dispatch` adapters as if they could
rewrite a queued GitHub job. An outer companion workflow hosts an ephemeral JIT
runner that can execute an original job with `runs-on: hobo`.

Commands: queue an observed GitHub job, reserve an eligible host, dispatch a host,
claim one runner registration, observe actual assignment, reconcile a stopped host.
Events: `ci.JobQueued`, `ci.JobCompleted`, `ci.LeaseReserved`, `ci.DispatchRequested`,
`ci.HostDispatched`, `ci.RunnerClaimed`, `ci.RunnerRegistered`, `ci.JobObserved`,
`ci.LeaseUncertain`, `ci.LeaseCancelled`, `ci.HostSettled`.

`LeaseStore` is a single-writer SQLite actor partition; `SqliteCiStore` wraps it
and adds the webhook inbox, so the Node service's partition is the same file
format the earlier relay wrote. It appends generated
`CiEvent` records and updates the lease/pending-job query projections in the same
transaction; no network operation runs in the transaction. Durable reserved leases
form the outbox. Intent is persisted before dispatch/JIT creation. An ambiguous
result remains held and is never automatically retried. Replay reconstructs leases,
pending jobs and terminal tombstones. SQLite is the adapter, not the SDK contract.
The authenticated account API is a platform composition boundary over the shared
CI actor. A platform can inject its own authentication authority; the deployable
file adapter binds token hashes and GitHub installations to an account.

All persisted contracts are generated from `../ci/data-models/ci.proto`. Zod parses
external GitHub REST/webhook subsets and OIDC claims once at the I/O boundary. CUE
constraints live with shared protobufs; schema-tools exercises valid/invalid
entitlement fixtures. PACT inventory identifies simulated consumer/provider edges.
App credentials and JIT tokens never enter the journal or dispatch inputs.

Actor identity and exact host labels defend against manual workflow dispatch using
another lease's title. Protected ref dispatch plus SHA verification establishes
reviewed workflow content. Repository-wide trusted execution is still mandatory:
GitHub cannot bind a JIT runner to one job ID, and nested processes share a machine.
No live provider, production isolation, invoice accuracy or multi-region durability
claim follows from these tests. See README trust limits and deployment acceptance.

Parse, don't validate: Zod and protobuf constructors establish parsed domain types
at external boundaries. The local JIT response type is generated from this package's
`data-models/jit_bootstrap_response.proto`; shared durable records remain owned by
`@hobo/ci`. The event store, materialized projection, snapshot and read store all
reside in one transactional partition, and query views can be replayed from events.

GitHub label matching creates pool demand, not a permanent job-to-host identity.
Multiple historical leases for one job are valid. At most one active planned lease
is deduplicated in the writer transaction; a verified queued original job is
requeued atomically with host settlement. This prevents reordered webhook delivery
or runner assignment from stranding work. Replay preserves this re-admission.


The production service owns HTTP admission/readiness, isolated reconciliation
ticks, bounded drain and a process-lifetime kernel partition lock. Account policy
and server-created onboarding operations survive restart/rebuild. CAS prevents
lost updates; active leases fence provider/bridge identity changes. Setup uses a
normal repository PR and verifies merged bytes before locking and rechecking its
bridge branch. The client never supplies replacement server plan files. Public
repositories require explicit trust acknowledgment in addition to existing checks.

Deployable Node24 artifacts include actual secret-file handling, UID1000,
read-only root, durable volume, health probes, online backup and locked offline
restore. The connected acceptance lane exercises signed HTTP, real RS256/JWKS,
JIT authorization, the shipped process launcher and real act jobs in one lease
chain. Live GitHub assignment is separately evidenced by a manual literal
`runs-on: hobo` recipe. Authentication/HTTP/provider/deployment Pacts, generated
protobuf/CUE, real POSIX process tests and an actual container lifecycle prevent
a skipped job or simulated dispatch from masquerading as a live runner proof.


HoBo platform budget facts reach CI through the Station budget-routing bridge.
Generated Broker-signal and routing-profile contracts live in `@hobo/ci`, while
Station owns the subscription adapter over the authenticated account client.
Each threshold persists its cycle and crossed flag with policy, and eligibility
uses the highest active configured threshold. CAS protects concurrent updates;
old/replayed facts cannot regress watermarks. Empty profiles pause admission,
recovery restores the applicable profile, and existing leases retain identity.
This composes the existing Broker budget plane with CI without importing Station
or Broker runtime dependencies into the relay deployment.


## Amended by ADR-0179 (2026-11-11): the hosted relay keeps no durable state

[ADR-0179](../../docs/design/adr/hosted-relay-stateless.md#adr-0179) changes
the hosted (Vercel) host of this relay. The text above is kept as the record of
what was decided; for that host it is now read with these changes
([design](../../docs/design/hosted-relay-stateless.md)):

- "A host supplies a store (`SqliteCiStore` or `PostgresCiStore`, one port)":
  the hosted relay's store becomes a cache store over
  `kv.redis-compatible/v1`. `PostgresCiStore` and the pg-bound helper stores
  (App registration, OAuth sessions, platform-App bootstrap, webhook and
  queued-job repair state) are removed in phase 7, and so is the box worker's
  `HOBO_CI_STORE=postgres` option.
- "The durable webhook inbox": on the hosted relay, intake is a Vercel Queue
  keyed by the GitHub delivery id, acknowledged to GitHub after enqueue.
- "Intent is persisted before dispatch/JIT creation. An ambiguous result
  remains held and is never automatically retried": kept. Intent becomes a
  timestamp on the lease record instead of a journal event; an uncertain lease
  is resolved by looking up its deterministic names (lease ids are UUIDv5 of
  `repositoryId:jobId:runAttempt`), never by a blind retry.
- "Replay reconstructs leases, pending jobs and terminal tombstones": on the
  hosted relay, GitHub's REST view and the deterministic names reconstruct
  in-flight leases; there is no journal to replay.
- "Account policy and server-created onboarding operations survive
  restart/rebuild. CAS prevents lost updates": on the hosted relay
  configuration is read-only at runtime, held in a config service, and written
  by `hobo ci`; repository prepare and isolated-connect move to the CLI.
- "HoBo platform budget facts reach CI through the Station budget-routing
  bridge": the hosted relay no longer accepts budget signals; it pulls provider
  usage instead.

Unchanged: the single relay core, the Node service and its `SqliteCiStore`,
the box worker's SQLite journal and pull admission, the mesh and the compute
fleet, and the trust limits above.
