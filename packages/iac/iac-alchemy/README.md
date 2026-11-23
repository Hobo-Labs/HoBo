# @hobo/iac-alchemy

This optional package adapts an Alchemy stack to HoBo's infrastructure provider
port. Alchemy remains an external dependency; shared HoBo packages do not import
it. Install the package's pinned Alchemy peer and its declared Effect peers in
the host application.

`mapBindleToAlchemy` accepts a HoBo bindle structurally and a provider-owned
mapping for each declared primitive. Mappings declare their Alchemy resource
types, supported operations and annotations, and whether they bind application
entrypoints. The adapter processes dependencies first, supplies their Alchemy
resources and the original entrypoint to the mapper, and rejects missing
mappings, unbound dependencies, unsupported permissions or annotations, and
cycles. The dependency kinds recorded on each declaration must agree with the
graph, including dependencies omitted from the returned bindle.
Mapping runs inside an Alchemy stack and rejects resource or action FQNs owned
outside the current Bindle with `BINDLE_IDENTITY_COLLISION`. Existing names stay
unchanged. Distinct Alchemy namespaces can separate supported mappings, but
changing one changes durable resource identity and requires a migration.
The trusted host must prevent later raw Alchemy declarations from reusing a
mapped FQN: Alchemy can silently return the registered object outside the
mapping scope. Across stacks the host must independently verify state ownership
and actual physical provider-resource isolation; distinct stack names alone do
not establish that resources cannot be shared or adopted.
Only explicit registry entries count as mappings.
`describeAlchemyPrimitiveSupport` reports supported, partial and
unsupported entries for a supplied primitive catalog, including the declared
entrypoint and annotation support.

These mappings are supplied by the provider or developer: the adapter does not
claim that every HoBo primitive has an equivalent in every Alchemy provider.
The mapper is responsible for actually implementing the declared operations,
application logic and bindings; its declarations are not a conformance proof.
Alchemy components that generate stack actions or executable plan values remain
subject to the plan-inspection restrictions below.

Create a target with `alchemyTarget({ targetId, tenantId, stackName, stage,
programResourceId, sourceDigest, inventoryEvidenceRef, resources })`. Each
resource scope names its Alchemy FQN and resource type plus its underlying
provider, account and product. Every planned resource must be present exactly
once. Target construction rejects sparse or decorated resource arrays,
accessors, proxies, unknown fields and unknown protobuf wire fields before
protobuf conversion; at most 256 resource scopes are accepted. JavaScript
cannot bound the engine's own-key enumeration for an already oversized object,
so the host must bound serialized input before materializing it in-process.
The source digest and inventory evidence are host claims: the trusted
host must verify them and execute stack code with appropriately scoped
credentials in its sandbox. Planning runs the supplied stack program, so the
adapter cannot make untrusted program code safe by inspecting the resulting
plan.

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
detection and receipt comparison. Priced and explicitly bypassed apply receipts
must carry a SHA-256 `executionDigest` on the held reservation, which the
adapter preserves through revalidation; a reservation-only receipt cannot
authorize execution.

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
The repository-level `test/iac-alchemy-integration.test.ts` exercise adds
ranked dispatcher execution, durable route SQLite, Rivet Alchemy resources, and
the RivetKit 3 runtime package in one host-shaped fixture. It imports the
Alchemy, Effect, Rivet and protobuf pins directly under their root-manifest
declarations (the same peer-aligned instances the adapter resolves) and builds
its pricing scenarios from `test/iac-alchemy-pricing-fixture.ts` beside it.
The bounded `model/IacGrant.tla` checks grant and fencing decisions under stated
host assumptions; it does not prove the implementation or external provider.
