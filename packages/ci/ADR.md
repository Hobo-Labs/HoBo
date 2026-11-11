# HoBo.CI allocation contract

The four sibling SDKs compose existing HoBo routing at application layer 3.
`@hobo/ci` calls the existing Dispatcher after removing offers that fail budget,
freshness, capability/readiness or concurrency eligibility. This preserves HoBo's
routing model without relying on a ranking score to authorize spend.

Protobuf is authoritative for configuration, job commands, leases, events and
snapshots. Generated TypeScript is consumed directly; no parallel DTO interfaces.
CUE exercises valid and invalid entitlement fixtures. The GitHub integration keeps
its external GitHub JSON subset parsers at the HTTP boundary. It converts queued
jobs to the generated Job command before routing.

Money uses finite nonnegative safe integer USD microdollars. Durations/free balances
are runner minutes, with provider settlement rounded up to a host minute. The first
execution class is homogeneous Linux x64, one account policy per repository. Runtime
reservations include startup and are upper bounds, not an invoice guarantee. Provider
rate changes, external usage, discounts and platform fees require entitlement feeds
and invoice reconciliation before production billing claims.

Routing has no network effects. The integration's durable actor commits a
`ci.LeaseReserved` event and its outbox projection in one SQLite transaction before
external launch. Tests cover free allocations first, then lowest projected cost, account
and provider budget rejection, expiry, pending reservations, isolation and replay.

The pure SDK boundary is pinned by generated protobuf JSON roundtrip tests and CUE
fixtures. The runtime/provider and webhook/bootstrap PACT boundaries belong to
`@hobo/ci-gh-actions/contracts`. No frozen draft proof was promoted or modified.

Parse, don't validate: configuration constructors establish parsed domain types from
protobuf JSON before the pure routing decision. In this first SDK the parsed type
is the generated record plus its constructor's dependent checks; callers should
not mutate it after parsing. Portable pipeline constructors additionally deep-freeze executable fields and
return a branded parsed type, so a reservation digest cannot diverge from the
commands later executed. Configuration updates remain operator-owned inputs.

The runtime actor owns the event store; a projection supplies a snapshot in the
read store. The pure SDK neither emits commands nor mutates a read store itself.


Portable execution adds `Pipeline`, steps/results and byte artifacts to the same
protobuf/CUE family. A Worker-safe execution module owns sequencing, fail-fast
behavior, UTF-8 output bounds, artifact integrity and cancellation normalization.
Backend session close must acknowledge work stopped; infrastructure idle lifetime
and invoices remain provider-specific metering inputs. Generic synchronous and
asynchronous allocation failures are equally uncertain. Promises that reject
while aborting are drained to prevent an unhandled rejection crashing the actor.

The Node pipeline scheduler filters capability/backend compatibility before
ranking and reserves through the shared SQLite actor. `ci.PipelineStarted` and
`ci.BackendRefused` complement existing lease events. The lease stores a canonical
input digest and final result; snapshots/read-store projections replay them.
A new logical execution identity prevents Dagger cache reuse across side-effect
runs. Replay retains its original identity and never invokes another provider.
Native pipeline IDs are distinct from repository-scoped GitHub job keys.


Production control-plane policy and setup operations use generated
`ConfigurationState`, `ControlRecord`, `AccountState`, `RepositorySetupRequest`,
`ReconcileRequest` and credential-binding messages. The same SQLite actor commits
configuration CAS and audit events; rebuild projects all three record families.
Active leases fence identity changes. Usage snapshots are inclusive and account
for physical completion rather than delayed reconciliation. Shared TypeScript,
protobuf/CUE fixtures, durable restart/race tests and HTTP Pacts protect these
boundaries. No live provider permission or invoice fact follows from local tests.


Budget routing uses shared generated Broker-fact/profile contracts. Account
signal-cycle and crossed-state maps are persisted in the same policy transaction;
configuration cannot discard/regress cycles or alter a flag without a newer
cycle. Station owns the Broker subscription and maps the highest active threshold
to eligible offers, leaving financial accounting and the durable reservation
ledger in CI. This keeps platform routing and CI admission consistent under
replay, restart, and concurrent policy changes.
