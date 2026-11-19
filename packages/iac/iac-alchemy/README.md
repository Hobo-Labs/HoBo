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

The isolation test scans selected shared runtime, Bindle, financial and policy
packages for literal Alchemy references, including escaped spellings. It does
not prove the absence of computed references or transitive dependencies.
The financial integration test builds broker, dispatcher and pricing as test
prerequisites; they are not dependencies of the adapter package.
The bounded `model/IacGrant.tla` checks grant and fencing decisions under stated
host assumptions; it does not prove the implementation or external provider.
