# Vibe Launch Asset Refresh Plan - Architecture Evidence

This experience proof records the asset-refresh decision for HOBO-556 without building launch
assets or publishing claims.

## Decision

Use a deterministic refresh-plan contract with explicit owner, proof mode, freshness rule, refresh
trigger, validation route, and stale-downgrade fields on every launch-demo asset. Downstream launch,
docs, support, and accessibility surfaces consume this contract instead of reinterpreting ad hoc
asset notes.

## Alternatives Rejected

- **Final asset production in this proof** - rejected because HOBO-556 only defines the plan and
  scope-out explicitly excludes final marketing assets and recording production.
- **One generic stale flag** - rejected because owners need routeable refresh triggers and
  downgrade behavior per asset kind.
- **Implicit proof modes** - rejected because public launch wording must not infer live evidence
  from simulated or reference fixtures.

## Parse, Don't Validate

`parseLaunchAssetRefreshPlan` is the trust boundary. Raw refresh input is parsed once into the
`ParsedVibeLaunchAssetRefreshPlan` parsed domain type. Consumers receive that derived type or a
fail-closed error list, not broad DTO values that every launch, docs, support, or accessibility
caller must revalidate.

## Event Architecture

- **Command** - `launchAssetRefreshPlan.RecordRequested` asks the launch asset owner actor to
  record or amend the refresh plan.
- **Event** - `launchAssetRefreshPlan.RecordAccepted` appends the parsed asset inventory,
  proof-mode fixtures, stale downgrade, and support handoff evidence.
- **Actor** - the V1 Launch Site, Messaging & Demo Assets owner actor accepts refresh-plan changes.
- **Event store** - accepted refresh-plan events are appended to the platform event store.
- **Materialized view / projection** - a projection folds accepted events into the current asset
  refresh-readiness view.
- **Snapshot** - the latest accepted refresh plan is the snapshot used by launch, docs, support, and
  accessibility consumers.
- **Read store** - downstream consumers query the read store instead of raw Linear comments,
  recordings, or local files.

No runtime engine, projector, final demo asset, live provider call, or launch publication workflow
is implemented here.
