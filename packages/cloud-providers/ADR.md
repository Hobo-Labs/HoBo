# @hobo/cloud-providers — Architecture Evidence

The composition layer that turns a provider's published catalog into a parsed
`Yard`. It exists because of a layering fact: a provider package is a layer-2
adapter and may import `@hobo/core` and nothing else HoBo, while `yard()` lives
in `@hobo/yards` at layer 3. A provider can therefore only publish its catalog
as *data*. Something above both has to parse it, and this package is that
something.

## Schema and constraints

- Protobuf records live in [`data-models/provider_catalog.proto`](./data-models/provider_catalog.proto).
- CUE constraints bound every protobuf type in [`data-models/provider_catalog.cue`](./data-models/provider_catalog.cue).
- PACT evidence for the provider→composition hand-off lives under [`contracts/pacts/`](./contracts/pacts/).

## Parse, don't validate

A published catalog crosses exactly one parser boundary. `composeYard()` hands
the raw `ProviderYardSpecRecord` rows to `yard()`, which returns the deep-frozen
derived type `Yard` — canonically ordered, duplicate-free, and screened for
credential-shaped properties. Callers receive parsed domain types, never the raw
spec objects, and the refusals stay `@hobo/yards`' refusals with
`@hobo/yards`' error codes (`YARD_BINDING_EMPTY_CONSTRAINT`,
`YARD_BINDING_DUPLICATE`, `SLOT_BINDING_CREDENTIAL_PROPERTY`).

The rule this package holds itself to is that it **decides nothing**. It does
not filter rows, reorder them, or repair a malformed one. If it did, it would
become a second, unversioned selection point — precisely the decision ADR-0157
reserves for resolution time under ADR-0151's hard gates and lexicographic
ranking.

## Event architecture

This package contributes **no new command or event of its own** — an honest
statement rather than an omission. It is a pure function from a provider's
published catalog to a parsed `Yard`, and it participates in the existing
topology-authoring flow rather than opening a boundary beside it:

- **Command** — `ComposeProviderYard` parses one provider's published catalog
  into a Yard. It is a local construction, not a dispatched control-plane
  command; nothing is persisted by calling it.
- **Event** — the resulting Yard is carried on the existing
  `topology.YardComposed` event appended by the topology-authoring path when a
  Station registers it. This package emits no event itself.
- **Actor** — `YardCompositionActor` in `@hobo/yards` remains the single owner
  of provider-homogeneity and row-set invariants. Composition adds no actor.
- **Event store** — accepted topology events append to the platform event store
  through the ordinary control-plane path; a composed Yard reaches it only once
  a Station registers it.
- **Materialized view / projection** — `YardRegistryProjection` folds composed
  Yards into the yard read model, unchanged by this package.
- **Snapshot** — the deep-frozen `Yard` value is itself the snapshot carried on
  `topology.YardComposed`; composition is deterministic, so re-running it
  reproduces the same snapshot byte for byte.
- **Read store** — planners and policy surfaces query the yard read store; they
  never call into this package, which is authoring-time only.

## Determinism

No clock, no randomness, no environment reads. Two calls with equal options
produce deep-equal Yards, and slot authoring order does not affect the result
because rows canonicalize to a sorted set.

## Honest scope

Every namespace's provider package ships deployment resolvers for some or all
of its catalog, proven in tests against an injected fake transport; **no live
deploy is proven anywhere in this repo**, which additionally needs real
credentials and network egress. No namespace registers Resource Definitions
for its product ids, so a deploy against any of these Yards fails closed at
resolution rather than half-applying. Per-provider coverage is not restated
here: `providerParity()` derives `resolved/catalog` from the provider
constants and emits at most `L1` (simulated), because a constants-only read
model cannot see executed evidence. It is a projection, not a decision — it
selects, filters, and reorders nothing. The AWS catalog further
**under-declares** what AWS can allocate — a gap in the slot-factory set, not a
selection the Yard made. See [`README.md`](./README.md) for the parity levels
and the code-pinned per-provider claims.
