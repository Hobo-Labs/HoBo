# Provider Azure Full — Architecture Evidence

This draft package carries architecture-guard evidence for the S4-03 full Azure
provider capability manifest POC (HOBO-639).

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

Untrusted manifest and plan input is parsed once at the boundary into derived
domain types (`CapabilityDefinition`, option blocks, manifest bundle). Downstream
functions accept parsed derived types — not raw DTOs with repeated boolean checks.

## Event Architecture

Planning emits `deployment.Planned` or `deployment.PlanRejected` events; registry
ingest appends `registry.CapabilityManifestIndexed` to the event store. The
provider actor applies plan-evaluation commands and never mutates read models in
place. A materialized view projection folds the event log into the capability
manifest snapshot that Matching queries from the read store.

- **Command** — `EvaluateDeploymentPlan`, `IngestCapabilityManifest`
- **Event** — `deployment.Planned`, `deployment.PlanRejected`,
  `registry.CapabilityManifestIndexed`
- **Actor** — `AzureProviderAdapter` owns plan evaluation and manifest publish
- **Event store** — durable append-only log for planning and registry facts
- **Materialized view / projection** — capability manifest and planner rationale
- **Snapshot** — current manifest bundle served from the read store
- **Read store** — Registry index queried by Matching and the Planner

No runtime engine is implemented here; this is design-time evidence naming the
boundaries for production promotion.

## Auth Decision

Azure auth uses `workload-identity-federation` as the preferred keyless flow per
[Plan 06](../../../../docs/design/ai-native-agent-auth.md#plan-06). Static
secrets are rejected at ingest time.
