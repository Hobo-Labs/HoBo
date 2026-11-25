# S5-02 WIT Interface Conformance Coverage — Architecture Evidence

## Parse, Don't Validate

Untrusted catalog JSON, provider claims, and conformance reports cross one parser
boundary each (`parseWitCapabilityCatalog`, `buildCoverageReport`,
`evaluatePublishGate`). Downstream code receives **parsed derived types** with
invalid combinations unrepresentable beyond the seam.

## Event Architecture

| Role | Name |
| --- | --- |
| **Command** | `RecordCoverageReport`, `RecertifyProvider`, `EvaluatePublishGate` |
| **Event** | `conformance.CoverageReportGenerated`, `conformance.ProviderRecertified`, `registry.PublishGateEvaluated` |
| **Actor** | `ConformanceCoverageActor` owns catalog/registry state transitions |
| **Event store** | append-only conformance event log |
| **Materialized view / projection** | `WitCoverageReport` and `RegistryPublishGateDecision` read models |
| **Snapshot** | latest coverage report + publish-gate disposition per provider |
| **Read store** | Registry listing query surface reads snapshots, never raw adapter output |

No runtime engine here — design-time contract naming CQRS boundaries for
production `packages/conformance/` promotion.

## Schema And Constraints

- Protobuf: [`architecture/wit_interface_conformance_coverage.proto`](./architecture/wit_interface_conformance_coverage.proto)
- CUE: [`architecture/wit_interface_conformance_coverage.cue`](./architecture/wit_interface_conformance_coverage.cue)
- PACT: [`architecture/pacts/wit_interface_conformance_coverage.pact.json`](./architecture/pacts/wit_interface_conformance_coverage.pact.json)
