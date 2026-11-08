# ADR — @hobo/provider-local

## Decision

Localhost products get a definitions-only provider package. The single
local engine owner stays `@hobo/runtime-local`; this package declares the
`hobo.resource-definition/vNext` semantics describing those engines'
realizations of the seeded `yard:local` products, and nothing else. Only
seed products with a traced engine are claimed — the rest are exported as
`LOCAL_ENGINE_GAPS` so the denominator stays auditable.

## Parse, don't validate

Boundary values cross once and become parsed types the rest of the code can
trust: `deterministicLocalResourceName` parses its `(seedProductId,
logicalId)` input into a derived type — the physical name string, branded
by construction as `hobo-local--<product>--<logical>` — and refuses
anything outside the slug grammar with a `TypeError` instead of returning a
string downstream code would validate again. The definitions themselves are
derived types over the seed: `test/definition.test.ts` parses the real
`seedLocalhostYard` output and requires every claimed profile set to equal
its seed rows, so a hand-edited claim cannot drift from the derived source.

## Event architecture

This package contributes **no new command or event of its own** — an honest
statement rather than an omission. It is a pure projection from traced
engine facts to catalog records, and it participates in existing flows
rather than opening a boundary beside them:

- **Command** — none. Composing a Yard or selecting a candidate are the
  consuming packages' commands; calling this package persists nothing.
- **Event** — none emitted here. Selection outcomes are recorded by the
  composition that ran selection (the recipe plane's signed resolution
  receipt pins the catalog digest these definitions feed).
- **Actor** — none. There is no per-resource actor in a definitions-only
  package; when a later layer wires local apply, the resource actor that
  owns reconcile lives with that loop, not here.
- **Event store** — the local data product this package *describes* is the
  runtime-local SQLite event store; this package writes to no event store
  itself.
- **Materialized view / projection** — `LOCAL_DEFINITIONS` and
  `LOCAL_CANDIDATES` are projections in the small: pure functions of the
  declared product table plus injected evidence overrides.
- **Snapshot** — none. Definitions are constants rebuilt from source at
  load; there is no state to snapshot.
- **Read store** — the first-party catalog in `@hobo/hobo` is the read
  store these records land in; this package keeps no store of its own.

## Honest scope

No apply/up/down loop is reachable from these definitions today: the chain
stops at selection. `createLocalDefinitions` produces records the catalog
can register and selection can gate on, but no executor dispatches on the
local `executorRef` values yet (see `packages/hobo/src/first-party-catalog.ts`
and `packages/hobo/src/recipe-plane.ts`, which only project and select).
Wiring the camp machinery to realize a selected local definition — and its
zero-orphan `down` — is later engine work in `@hobo/runtime-local` and the
composition root, not a declaration edit.
