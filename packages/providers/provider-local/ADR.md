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
derived types over the seed: the composition-side catalog test
(`packages/hobo/test/first-party-catalog.test.ts`) parses the real
`seedLocalhostYard` output and requires every claimed profile set to equal
its seed rows, so a hand-edited claim cannot drift from the derived source.
That assertion lives there, not in this package's tests, because an adapter
package may not depend on `@hobo/yards` (package-boundary rule
`adapter-imports-non-core`).

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

## Evidence-override trust boundary

`LocalDefinitionOverrides` lets a composition inject `evidenceSignatureValid`,
`evidenceExpiresAtMs` and `conformance`. Every claimable provider
(`provider-upstash`, `provider-netlify` `definition.ts`) exposes the same seam;
here the defaults are stricter (`false` / `unknown`, where those default
`true`). The caller is the station operator, who is trusted: it owns the
machine these products run on. The override flag is **not** itself
cryptographic: `selectCapabilityImplementation` only reads
`candidate.evidenceSignatureValid`. The enforcement point is the recipe
plane: `compileRecipe` (`packages/recipes/src/compile.ts`, gate 3) takes the
published `TrustEvidence` records and the station's `EvidenceVerifier`
(`stationEvidenceVerifier` in `packages/hobo/src/recipe-plane.ts`) and refuses
a product with no signed, fresh, non-failed evidence. That path verifies
published evidence artifacts; it does not cross-check the candidate-level
override flag. That is a repo-wide gap shared with every other provider, and
it is not closed here.

## Catalog records, no integration boundary

The definitions are in-process catalog records, as in the L01 taxonomy layer.
There is no persistence or integration boundary. `data-models/` carries the
`.proto` + `.cue` contract the repo's package-layout and architecture guards
require, and since the council fix round on #1778 the package opts into
codegen (`data-models/buf.yaml`): `LocalEngineGap` is the generated
`LocalEngineGapRecord` message type, built with
`create(LocalEngineGapRecordSchema)` — never a hand-declared parallel.
Revocation is claimed `false` for every product until a `down` loop
exists, and `runtimeModels` lists only what `@hobo/runtime-local` serves:
`wasm` for the component host, none for the in-process host (it runs
supplied fetch handlers, not wasm components), queue, or sqlite
(which have no workload runtime of their own, and `BindleRuntime` has no
station-local member).
