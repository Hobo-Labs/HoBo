# @hobo/iac-alchemy

This optional IaC adapter uses the external `alchemy` 2.0 beta.87 library. The
host supplies an Alchemy stack, runtime layer, runtime directory, target scope
and injected state, financial and execution authorities to
`createAlchemyIacProvider`. It implements the `IacProvider` preview, apply,
destroy and refresh port; no core package imports this adapter or the Alchemy
library. Install the package's pinned Alchemy peer and its declared Effect peers
in the host application.
The Rivet integration is tested against `@alchemy.run/rivet` beta.87 and its
RivetKit 3 runtime dependency.
The root integration test builds its HoBo host dependencies before running, so
it can exercise the adapter from a clean checkout.
Run `pnpm --filter @hobo/iac-alchemy lint` to check the adapter's formatting and
imports before committing changes.

`mapBindleToAlchemy` accepts a HoBo bindle structurally and a provider-owned
mapping for each declared primitive. The caller must also assess bindle-wide
requirements, including required and preferred capabilities, runtimes, and
labels; an unsupported, invalid, or failed assessment prevents mapping.
Mappings declare their Alchemy resource
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
Only explicit registry entries count as mappings. Connector declarations are
rejected until their authorization and runtime bindings can be mapped.
`describeAlchemyPrimitiveSupport` reports supported, partial and
unsupported entries for a supplied primitive catalog, including the declared
entrypoint and annotation support.

These mappings are supplied by the provider or developer: the adapter does not
claim that every HoBo primitive has an equivalent in every Alchemy provider.
The mapper is responsible for actually implementing the declared operations,
application logic and bindings. The provider's requirement assessment and
mapping declarations are not a conformance proof.
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

Alchemy beta.87 encodes `/` as `__` in local and bucket state keys, so the
adapter accepts only portable alphanumeric, dot, hyphen and underscore FQN
segments whose complete FQN round-trips through that encoding. Stack and stage
must be single portable path segments, and the program must name that physical
stack exactly. Generated logical names containing `/` are refused before
admission or provider effects until a host-authenticated mapping is available.
Case-insensitive resource-key collisions in one target are rejected. State
reads, writes and deletes are checked in each plan, destroy and drift scope; a
stored row whose own FQN differs from its key, an unsafe rename, or an
unavailable/inconsistent scan stops execution. FQNs and scope segments are
limited to 200 ASCII characters; a scan accepts at most 1,024 stored rows, each
stored row may reference at most 1,024 downstream FQNs, and replacement history
is limited to 64 rows. Exceeding a bound fails closed. A post-admission failure
retains the reservation for reconciliation. Existing unsafe state requires a
host-controlled, independently verified migration; state already overwritten by
an earlier collision cannot be reconstructed by this check.

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

`assessPricing` returns the plan-bound inventory, pricing state and quote for
`@hobo/dispatcher`'s `rankIacTargets`. Ranking reports that it has not checked
a budget. `executeRankedIacTargets` can invoke each adapter's
`applyWithAdmission(program, requestId, expected, permit)` in ranked order,
sharing one durable admission request across the route. It advances only after a
definitive denial without a reservation. Alternatively, call `apply` on a chosen
target directly. The adapter replans, refuses changes, obtains host-issued
liability evidence, and requests admission before applying the exact plan under
Alchemy's state lease. Financial services include a durable budget authority, a
trusted clock, `issueLiability`, `verifyLiability` and policy `authorize`
callbacks. The adapter only knows the injected port; the broker supplies its
implementation. Evidence must be independently verified and bound to every
target account, the operation (`deploy` or `destroy`) and the quote horizon.
Liability callbacks receive the operation in the inventory. A model or its
author cannot supply its own trusted bound merely by declaring a price.

For example, after constructing the stack, target, scenario and trusted host
callbacks:

```ts
const financial = createIacFinancialServices({
  authority, now, issueLiability, verifyLiability, authorize,
  pricing: {
    modelId: "contract-2026", revision: "1", scenario,
    bindings: [{ resourceId: "service", candidateIndex: 0 }],
  },
});
const provider = createAlchemyIacProvider({
  stack, target, stateOwnership, composite, route, resolveRoute,
  runtimeLayer, runtimeDirectory, financial,
});
const assessment = await provider.assessPricing(program);
const ranking = rankIacTargets({
  tenantId, workloadRef, action: scenario.action, at: scenario.at,
  horizon: scenario.horizon,
  candidates: [{ workloadRef, inventory: assessment.inventory, pricing: assessment.pricing }],
});
const result = await executeRankedIacTargets({
  requestId: "deployment-attempt-1", ranking, authority: routeAuthority,
  tenantId, operation,
  candidates: [{
    targetId: target.targetId,
    run: (id, expected, permit) => provider.applyWithAdmission(program, id, expected, permit),
  }],
});
```

Omit `pricing` from the financial services to obtain an explicit unavailable
assessment. `describePricingSupport` in `@hobo/provider-manifest` separately
reports which manifest plans the pricing kernel supports.

`applyWithAdmission(program, requestId?)` returns bounded string-valued stack
outputs and the broker admission receipt, including its reservation identifier
and budget disclosure. A resource-property output is supported when it refers
to a resource in the reviewed plan. If a completed apply produces outputs that
cannot fit HoBo's output contract, `APPLY_OUTPUT_UNREPRESENTABLE` reports the
held reservation and requires reconciliation. The standard `apply` method
returns only IaC outputs. Admission errors expose their decision; an unknown
apply outcome exposes the reservation identifier. `destroyWithAdmission`
returns the corresponding receipt for a destroy.

Budget reservations remain held after successful apply until the host
reconciles final usage and source retirement with the authority. Lost
acknowledgements and failed applies retain exposure and report an uncertain
outcome. Replay cannot authorize another provider call. Destroy follows the
same preview and admission sequence. Refresh reports an error if Alchemy skips a
resource instead of calling the target in sync.

One adapter instance refuses concurrent execution of the same program. Across
instances or process restarts, the host must use the same stable request ID for
the same logical attempt so the durable admission authority can recognize a
replay. A malformed or unreadable admission receipt requires reconciliation:
the authority may already have reserved funds even if the receipt is unusable.
An instance also blocks subsequent attempts after any outcome requiring
reconciliation; the host must resolve the previous attempt before replacing it.

Plan fingerprints are bounded and include inspectable resource inputs, bindings,
state and source identity. Plans with stack actions, partial selection, unscoped
or executable output expressions, exotic values, missing scopes, or more than
256 resources are refused. These restrictions can exclude valid Alchemy
programs; there is no automatic fallback to an unbudgeted apply. The caller owns
final usage reconciliation and can use the budget authority's settlement APIs.

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
