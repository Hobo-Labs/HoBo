# @hobo/iac-alchemy

This optional package adapts an Alchemy stack to HoBo's infrastructure provider
port. Alchemy remains an external dependency; shared HoBo packages do not import
it. Install the package's pinned Alchemy peer and its declared Effect peers in
the host application.

`alchemyTarget` declares the complete resource inventory and its provider,
account and product scope. `createAlchemyIacProvider` accepts that target, an
Alchemy stack, and host-supplied state, financial and execution authorities.
Planning verifies the declared inventory against the Alchemy plan. The host
must independently verify source ownership, the physical provider scope and
liability; names and developer-supplied estimates are not proofs of those facts.

The adapter follows parse, don't validate: plan inspection produces the derived
domain type `InspectedAlchemyPlan` only after checking resource scope and
fingerprintable inputs. Uninspectable plans fail before admission or execution.
The host's resource actor issues preview, apply, destroy and refresh commands;
its executor records outcome events in the event store. Materialized projections
and the read store expose those outcomes. Alchemy owns its provider-state
snapshots, while budget reservations stay in the host authority.

`assessPricing` describes the plan and financial assessment. An unavailable
model is not a zero price. Assessment and ranking do not evaluate a budget or
create a reservation. Applying or destroying requires the host's financial
admission and route authority. A host may explicitly authorize an unpriced
operation only through the broker's unpriced policy and durable exposure hold.
An invalid or incomplete model cannot use that path.

`mapBindleToAlchemy` accepts provider-owned primitive mappers and assesses the
Bindle's requirements, operations, annotations, dependencies and entrypoints.
It refuses missing mappings and unbound dependencies.
`describeAlchemyPrimitiveSupport` reports the supplied mappers' operational
coverage; it does not authenticate them, price their resources, or authorize
routing. Hosts must attest the mapping and its execution environment.

The optional `@hobo/iac-alchemy/rivet` entry point maps one attested API, web,
or service entrypoint to an Alchemy Rivet `DurableObject`. The accompanying
`rivet/runtime` entry point binds the application handler to a Rivet actor. The
host must verify and fence the source, artifact and exclusive pool. This mapping
does not bind resource dependencies or enabled session replay. Other primitive
kinds remain unsupported; `describeRivetPrimitiveSupport` reports their gaps.
The package tests exercise an isolated local Rivet engine and Alchemy providers
with test doubles; a live cloud deployment has not been verified.

`@hobo/iac-alchemy/rivet/queue` additionally provides an opt-in asynchronous
JSON queue backed by a Rivet actor and an Alchemy `DurableObject`. Its runtime
uses durable transactions, idempotent enqueue keys and fenced delivery leases.
The host supplies authorization, a trusted clock, source fencing and exclusive
pool verification. The actor retains at most 10,000 messages and rejects new
ones at capacity. A timeout or lost response leaves the outcome unknown;
consumers must reconcile leases and fence their own effects. This queue is not a
mapping for HoBo's synchronous byte-and-attribute WIT queue or message bus, so
those Bindle capabilities remain unsupported.
The finite `model/RivetQueue.tla` checks queue retry, lease and completion
decisions for one key, two payloads, at most two leases and three clock values.
It assumes atomic transactions and a trusted clock; it does not prove the
TypeScript implementation, host callbacks or provider behavior.

`@hobo/iac-alchemy/rivet/kv` provides an opt-in asynchronous byte-preserving
key-value actor mapped to Alchemy's Rivet `DurableObject`. It supports get, set,
delete and exists, with bounded keys, values and storage. Its exported
`RIVET_ASYNC_KV_CAPABILITIES` reports missing operations, including listing,
compare-and-set, TTL and watches. It has no durable idempotency or automatic
retries; an uncertain write requires reconciliation. The host supplies the
source, pool and ingress authorities and enforces single dispatch. This is not
yet the synchronous HoBo WASI store or a Bindle storage dependency.
The finite `model/RivetKv.tla` checks one set or delete, a lost reply, late
commit and fenced retirement. It assumes an independently effective host fence
and does not prove the implementation, host callbacks or provider behavior.

`@hobo/iac-alchemy/rivet/http-kv` binds an HTTP application and its asynchronous
key-value actor in one Rivet program. The host must attest the exact registry,
source, transport, pool and isolation domain. HTTP authorization, storage
authorization and response disclosure remain distinct decisions, and an
uncertain write must be reconciled before retrying. This binding does not
implement the synchronous HoBo WASI store or Bindle storage dependencies.
The bounded `model/RivetHttpKv.tla` checks one HTTP request and one write under
the host authority, fencing and draining assumptions described in the model;
it does not prove those assumptions or the implementation.

The isolation test scans selected shared runtime, Bindle, financial and policy
packages for literal Alchemy references, including escaped spellings. It does
not prove the absence of computed references or transitive dependencies.
The financial integration test builds broker, dispatcher and pricing as test
prerequisites; they are not dependencies of the adapter package.
The bounded `model/IacGrant.tla` checks grant and fencing decisions under stated
host assumptions; it does not prove the implementation or external provider.
