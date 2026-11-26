# @hobo/capability-profiles

The semantic layer between a Bindle primitive and a hosted product.

`data` is a Bindle primitive. `data.postgres/v1` is a **capability implementation
profile**: a provider-neutral statement of what PostgreSQL compatibility means.
Neon Claimable Postgres and a pinned PostgreSQL OCI image are **products** that
implement that profile. This package owns the middle term, so an application can
ask for real PostgreSQL semantics without naming a vendor, and so a catalog can
refuse a product that only looks similar.

## What is in here

- `ids.ts` — canonical profile ids (`<primitive>.<name>/v<major>`), the Bindle
  primitive and runtime vocabularies, and realization kinds.
- `descriptor.ts` — `CapabilityProfileDescriptor` and its parser.
- `registry.ts` — the versioned refinement graph. Refinements add guarantees and
  may never erase a parent's; cycles and unknown refinement targets are rejected
  at load, not at selection time.
- `requirement.ts` — `CapabilityRequirement`: what an application asks for. No
  provider or product identifier is representable here by construction.
- `standard-profiles.ts` — the first-party profiles for web, api, service, data,
  kv, bucket, queue, topic, secretRef, and webhook/realtime.
- `selection.ts` — hard compatibility gates followed by a deterministic
  lexicographic ranking.

## Parse, don't validate

Every entry point is a parse boundary that produces a derived domain type.
`parseProfileId` returns a branded `ProfileId`; `parseCapabilityProfile` returns
a `ParsedCapabilityProfile`; `parseCapabilityRequirement` returns a canonically
ordered `CapabilityRequirement`. Downstream code accepts these parsed types, so
an unnormalized id or an unbounded version range is unrepresentable past the
boundary rather than re-checked at each use. The protobuf records in
`data-models/` are the wire form; the derived types here are narrowings of them.

## Selection is pure

`selectCapabilityImplementation` reads no clock, network, randomness,
environment, or filesystem. The evaluation instant, evidence snapshot, and trust
policy are explicit inputs. Hard gates run first — profile compatibility,
runtime model, realization policy, bootstrap and claim policy, binding
availability, evidence freshness and signature, secret custody, registered
driver — and only survivors are ranked. Ranking is lexicographic:

1. required profile conformance
2. evidence freshness and signature validity
3. creator authority after claim
4. claim atomicity and human action count
5. endpoint and data continuity
6. credential rotation/revocation quality
7. protocol and export portability
8. sponsor exposure
9. provider maturity class
10. stable definition id

A cheaper or faster candidate never compensates for a failed gate. There is no
weighted scalar score in the production path.

## Event architecture

This package is deliberately effect-free, so it owns no aggregate. It supplies
the decision inputs consumed by the surrounding event-driven control plane: the
Planner turns a resolution into commands, the resource actors in `@hobo/cloud`
emit events into the durable event store, projections build the materialized
views the CLI and site read, and periodic snapshots back the read store that
serves current status. The catalog digest exported here is folded into the
signed resolution receipt, which is what makes a change of winner attributable
to a specific catalog change rather than to nondeterminism.

## Contracts

- `data-models/capability_profiles.proto` — durable records.
- `data-models/capability_profiles.cue` — id syntax, closed vocabularies, and
  the cross-field invariants protobuf cannot express.
- `contracts/pacts/catalog-selection.pact.json` — the Planner/catalog boundary,
  including the two refusals that matter: a SQLite-class product never satisfies
  a PostgreSQL requirement, and stale evidence fails closed instead of ranking
  lower.
