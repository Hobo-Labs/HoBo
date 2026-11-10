# @hobo/trails — Architecture Evidence

HoBo Trails: versioned, app-owned, composable continuous migration runbooks.
Continuous identity remains hands-off (zero Bindle config) and is composed as
the platform recipe `identity.continuous`.

## Schema and constraints

- Protobuf records live in [`data-models/trails.proto`](./data-models/trails.proto).
- CUE constraints in [`data-models/trails.cue`](./data-models/trails.cue) bound
  every protobuf message.
- PACT consumer evidence (observe boundary) under [`contracts/`](./contracts).

## Parse, don't validate

`defineTrail` is the single parse, don't validate boundary for Trail definitions:
untrusted authoring input becomes frozen `TrailDefinition` / `TrailStep` **derived
types** with ordered dependency validation and secret-free checks before the
runner accepts a plan. Callers receive derived domain types — never re-check raw
JSON maps.

## Event architecture

- **Command** — plan / run / abort / compensate / baseline / repair.
- **Events** — `trail.Started|Planned|DualActive|Progressed|Validated|Cutover|Compensated|Aborted|Failed|HistoryRecorded`.
- **Actor** — TrailRunService is the single-writer aggregate for a trail run.
- **Event store** — append-only run events (identity-linked use never-compact retention).
- **Materialized view / projection** — TrailHistoryStore folds HistoryRecorded.
- **Snapshot** — TrailRunRecord for observe surfaces.
- **Read store** — history list + can-trail dry-run evidence.

## Hands-off continuous identity

Architecture guarantee: pure continuous identity Trails expand from
`identity.continuous` with `bindleConfigRequired: false`. Matching/policy
activation via `activateIdentityContinuousFromMatching` requires no Trail
authoring. Guards and Golden oracles assert this property.

## Public surface encapsulation

`@hobo/identity` (control plane, dual fixtures, FeatureFlagStore / Harness) is an
**internal** dependency only. Package entry and all published `.d.ts` files must
not import or re-export foreign packages. Consumers receive Trails-owned DTOs
(`IdentityTrailHandle`, `TrailIdentityProgress`, `TrailCanMigrateEvidence`,
`ProgressiveFlagPort` internals). Encapsulation is gated by
`test/public-surface.test.ts`.

## Engine neutrality (ADR-0177)

Trails is the runbook engine and holds no storage-engine code. The live
schema-apply and dual-run bindings that once imported `node:sqlite` from this
package now live in `@hobo/data-sqlite`; this package keeps only the port
shapes (`SchemaApplyPort`, `DataDualPort`, `LiveDataDualPort`), declared
locally so the sealed public surface re-exports no foreign type. The
package-boundary gate holds that line: nothing under `src/` may import a
`@hobo/data-<engine>` package, a database driver, or `@hobo/storage-sqlite`,
by any import form; only tests may.

`executeDataMigration` delegates to the `in-place-evolve` pattern executor in
`@hobo/data-core`, so there is one implementation of expand → backfill →
contract. The **command** is still "run this migration"; the **events** are
still the `migration.*` family, now including `migration.Held`,
`migration.Resumed`, and `migration.Completed`; the migration aggregate is the
single-writer **actor**; its facts are appended to the **event store**; status
is a **projection** over them; and each phase's checkpoint is the **snapshot**
a resumed run continues from.

The dual oracle prefers digest evidence over a row view, and `can-trail`
accepts a policy verdict computed over the migration's custody path alongside
the caller-supplied `policyAllows` and `residencyConflict` booleans. The three
are combined, not ranked: any one of them denying denies the trail, so a
passing verdict cannot erase an explicit denial, and a verdict that does not
parse as its record is itself a denial rather than an exception. Both the
evidence and the verdict are structural mirrors of `@hobo/data-core` records,
pinned in `data-models/migration.proto`.
