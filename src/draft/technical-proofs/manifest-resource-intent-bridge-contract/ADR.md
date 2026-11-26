# Manifest → ResourceIntent Bridge — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted manifest IR
crosses one lowering boundary and becomes derived domain types (`ResourceIntent` records).
Downstream FinOps routing consumes only parsed derived types; provider-specific
`.with(...)` annotations never enter the intent surface. CUE constraints reject malformed manifest schemas,
empty resource maps, and provider-leaking intent payloads at parse time.

## Event Architecture

The accepted bridge record is the read model behind this event flow:

- **Command** — `BridgeManifestResourceIntents` requests provider-neutral intents for a
  manifest snapshot at plan time.
- **Event** — `manifest.ResourceIntentBridged` records the manifest hash, deploy context,
  and derived intent set for one `hobo plan` preview.
- **Actor** — the Planner aggregate owns the bridge command and applies events in order for
  one manifest snapshot.
- **Event store** — accepted bridge events append to the platform event store as the durable
  source of truth for plan-time FinOps decisions.
- **Materialized view / projection** — the plan-preview projection folds bridge events into
  `DeploymentPlan` cost and `DecisionGraph` surfaces.
- **Snapshot** — the derived `ResourceIntent` set is the snapshot consumed by the FinOps
  routing pipeline before Matching resolves providers.
- **Read store** — `hobo plan`, DX dry-run, and FinX surfaces query the read store rather
  than re-parsing raw manifest annotations.

No runtime Planner, FinOps router, or event store is implemented here; this is a design-time
contract naming the command, event, actor, projection, snapshot, and read-store boundaries.
