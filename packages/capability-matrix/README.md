# @hobo/capability-matrix

The Bindle primitive × runtime coverage view, **derived** rather than curated
([ADR-0151](../../docs/design/adr/07-portability-extensibility.md) decision 14).

There is no coverage table in this package. The grid is the cross product of the
ten Bindle primitives and the five runtime models exported by
[`@hobo/capability-profiles`](../capability-profiles/README.md), and every cell
is filled from registered Resource Definitions plus the trust evidence they point
at. A cell improves when a definition and its evidence land; it regresses when
that evidence expires. Hand the generator an empty catalog and you get fifty
honestly uncovered cells, not an aspirational roadmap.

## The five buckets, never conflated

A cell reports what covers it in five separate lists, because summing them is the
specific overstatement this package exists to prevent:

| Bucket | What it means |
| --- | --- |
| `native` | a public provider implements the primitive itself |
| `pack` | HoBo deploys a portable implementation onto generic compute |
| `bridge` | the primitive is reached through an adapting shim |
| `substrate` | the resource runs on infrastructure HoBo itself operates |
| `sponsor` | the bootstrap path spends HoBo sponsor budget |

Classification is a total function with deliberate precedence: sponsor exposure
first, HoBo-operated substrate next, and only then the definition's declared
realization. A pack running on HoBo's own hardware is not market coverage, and a
path HoBo pays for is not a provider's free tier.

Each bucket splits its definition ids into `available` (selectable at the
evaluation instant) and `unavailable` (registered but held back). The cell's
`verdict` is derived from those lists, so `covered` always means *public
provider-native coverage that could be selected right now* — bridge-only,
substrate-only and sponsor-only cells say so in their own words.

## What is in here

- `grid.ts` — the coordinate space: fifty coordinates in canonical order,
  computed from the primitive and runtime vocabularies rather than transcribed.
- `candidate.ts` — one definition's claim on one cell, its bucket, and every
  reason it is not selectable.
- `matrix.ts` — cells, buckets, verdict vocabulary, and `deriveCoverageVerdict`.
- `generate.ts` — `generateCapabilityMatrix`, the pure derivation.
- `digest.ts` — the content digest, over `@hobo/trust`'s canonicalization.
- `parse.ts` — the read boundary for a stored or transmitted matrix.
- `validate.ts` — structured findings; nothing throws.
- `render.ts` — a byte-stable Markdown rendering suitable for committing.

## Parse, don't validate

`parseCapabilityMatrix` is the one boundary an untrusted matrix document crosses,
and it returns a parsed domain type rather than a boolean. Past it, an incomplete
grid, a verdict that does not follow from its buckets, a candidate filed under
the wrong coordinate, an unsorted bucket, or a digest that does not describe the
body is unrepresentable — so no consumer re-checks any of them. The generator
produces the same derived types directly, which is why a generated matrix and a
round-tripped one are interchangeable. The protobuf records in `data-models/` are
the wire form; the types exported here are narrowings of them, with the closed
vocabularies and cross-field invariants pinned in
`data-models/capability_matrix.cue`.

The evaluation instant is an argument, never a clock read, and the module tree
touches no filesystem, network, or randomness. Two runs over equal inputs produce
an identical digest and identical Markdown bytes.

## Reuse, not reimplementation

Evidence freshness is not re-derived here. `generateCapabilityMatrix` evaluates
the whole catalog through `@hobo/trust`'s `evaluateTrustBundle`, which applies
`evaluateEvidenceFreshness` and the trust gates at one instant and returns a
bundle digest that is folded into the matrix digest. A candidate whose evidence is
absent, expired, aged, future-dated, or whose adapter failed a gate is reported as
unavailable **with the reason attached** — never silently dropped, because a cell
that just lost coverage must stay distinguishable from a cell nobody ever
registered.

## Event architecture

The matrix is a **projection**, and this package is the pure fold at its centre —
it owns no aggregate and performs no effects. Placing it in the surrounding
event-driven control plane honestly:

- **Command** — `RegisterResourceDefinition` / `RecordTrustEvidence`, handled by
  the catalog and trust surfaces in `@hobo/cloud` and `@hobo/trust`. This package
  handles no command of its own; there is no `GenerateCapabilityMatrix` command,
  because deriving a view is not a state transition.
- **Events** — `provider.Registered`, `provider.Approved`, and the resource
  definition and trust-evidence facts appended by those handlers. Nothing here
  emits an event.
- **Actors** — the registry and provider actors in `@hobo/cloud` own that state
  and are the only writers; the matrix is downstream of them and never mutates
  what it reads.
- **Event store** — the durable journal those actors append to
  ([ADR-0135](../../docs/design/adr/03-data-plane-sqlite-default.md), SQLite
  behind HoBo-owned ports). This package neither reads nor writes it directly: it
  is handed the already-folded catalog and evidence.
- **Materialized view / projection** — the registry projection produces the
  Resource Definitions, and `generateCapabilityMatrix` is the second-order
  projection over them. Because it is a pure function of `(definitions, registry,
  evidence, nowMs)`, it can be re-run over any historical position and will
  reproduce that instant's coverage exactly.
- **Snapshot** — `matrix.digest` is the snapshot identity. A rendered matrix
  committed to the docs tree is a materialized snapshot of one instant, and its
  digest is what makes a coverage change attributable to a catalog change rather
  than to nondeterminism.
- **Read store** — the rendered Markdown and the parsed matrix are what the read
  side serves: docs, the coverage page, and any gate consuming
  `validateCapabilityMatrix`. `parseCapabilityMatrix` is the boundary those
  readers come back through.

Time enters this system exactly once, as `nowMs`, which is why a projection over
expiring evidence stays replayable.

## Contracts

- `data-models/capability_matrix.proto` — the durable records.
- `data-models/capability_matrix.cue` — closed vocabularies, the digest form, the
  availability/unavailability disjointness rule, and grid completeness: a matrix
  carries exactly one cell per primitive/runtime pair, in canonical order.
- `contracts/pacts/capability-matrix-report.pact.json` — the boundary consumers
  read, including the three refusals that matter: an empty catalog still returns a
  complete grid, bridge-only coverage is never reported as covered, and expired
  evidence moves a definition from `available` to `unavailable` instead of
  deleting it.
