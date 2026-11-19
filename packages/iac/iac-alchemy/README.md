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
An invalid or incomplete model cannot use that path. Financial receipt parsing
accepts the broker's explicit entitlement kinds and settlement payload version,
and compares claims by kind, bucket and unit so separate units in one bucket do
not collide. Legacy kindless claims normalize to `allowance` for duplicate
detection and receipt comparison. Priced apply receipts must carry a SHA-256
`executionDigest` on the held reservation, which the adapter preserves through
revalidation; a reservation-only receipt cannot authorize execution.

`mapBindleToAlchemy` accepts provider-owned primitive mappers and assesses the
Bindle's requirements, operations, annotations, dependencies and entrypoints.
It refuses missing mappings and unbound dependencies. This foundational package
does not provide built-in mappings for any particular Alchemy provider.
`describeAlchemyPrimitiveSupport` reports the supplied mappers' operational
coverage; it does not authenticate them, price their resources, or authorize
routing. Hosts must attest the mapping and its execution environment.

The isolation test scans selected shared runtime, Bindle, financial and policy
packages for literal Alchemy references, including escaped spellings. It does
not prove the absence of computed references or transitive dependencies.
The financial integration test builds broker, dispatcher and pricing as test
prerequisites; they are not dependencies of the adapter package.
The bounded `model/IacGrant.tla` checks grant and fencing decisions under stated
host assumptions; it does not prove the implementation or external provider.
