# Resource Definitions + Matching + Packs — Architecture Evidence (HOBO-641)

Architecture-guard evidence for `scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- PACT contract under [`architecture/pacts/`](./architecture/pacts).

## Parse, Don't Validate

This package applies **parse, don't validate**: untrusted pack artifacts and catalog
snapshots cross one boundary into derived domain types (`MatchingDecision`,
`DeploymentSet`, `MultiCloudPlan`). Downstream planners consume parsed derived
types; CUE constraints reject malformed protobuf-shaped records at parse time.

## Event Architecture

Set/Delta promotion and matching evidence map to the platform event flow:

- **Command** — `hobo add <pack>`, `delta.Open`, `planMultiCloudShop`.
- **Event** — `resourcePack.Installed`, `match.Decided`, `delta.Applied`, `set.Created`.
- **Actor** — Yard catalog actor owns pack install; Matching actor emits decisions;
  Set store actor folds Delta promotion.
- **Event store** — deployment projection events append to the durable event log.
- **Materialized view / projection** — `foldDeploymentProjections` folds
  `set.Created` + `delta.*` into current Set and Delta read models.
- **Snapshot** — content-addressed `DeploymentSet` is the immutable snapshot at apply time.
- **Read store** — `planMultiCloudShop` queries the Yard catalog snapshot and
  per-Camp matching decisions from the read store rather than re-parsing raw packs.

No runtime engine is implemented here; this names command/event/actor/projection
boundaries for S4-05 production promotion.
