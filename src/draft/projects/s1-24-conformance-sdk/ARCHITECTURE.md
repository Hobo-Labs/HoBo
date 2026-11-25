# @hobo-draft/s1-24-conformance-sdk — Architecture Evidence

Draft POC for HOBO-614 (`@hobo/conformance/sdk` idiom-layer parity gate).

## Schema and constraints

- Protobuf records live in [`data-models/sdk_conformance.proto`](./data-models/sdk_conformance.proto).
- CUE constraints in [`data-models/sdk_conformance.cue`](./data-models/sdk_conformance.cue) bound
  `SemanticsAnnexVector`, `LoweringFixture`, `VectorCaseResult`, `LaneReport`, and
  `SdkConformanceReport`.
- PACT consumer/provider evidence: [`contracts/pacts/sdk_conformance_report.pact.json`](./contracts/pacts/sdk_conformance_report.pact.json).

## Parse, don't validate

`parseSemanticsAnnexVectors`, `parseLoweringCorpus`, and `parseSdkConformanceReport` are the sole
parse boundaries. Untrusted JSON becomes derived parsed types (`SemanticsAnnexVector`,
`LoweringFixture`, `SdkConformanceReport`) before lane runners execute. CUE constraint failures
surface as `TypeError` at parse time.

## Event architecture

Report assembly follows append-only CQRS discipline for conformance runs:

- **Command** — `runSdkIdiomConformance` accepts a gate request (corpus, annex vectors, adapter).
- **Event** — each lane runner appends immutable `VectorCaseResult` events into `LaneReport` lanes;
  nothing mutates a previously recorded case.
- **Actor** — the gate actor coordinates lane runners without rewriting prior lane output.
- **Event store** — case results append to the in-memory report envelope (promotion wires durable
  event-store persistence for CI artifacts).
- **Materialized view / projection** — `SdkConformanceReport` is the materialized projection over
  appended lane/case events.
- **Snapshot** — the final `status: passed|failed` field is the snapshot read model for CI gating.
- **Read store** — gated packages (`@hobo/bindles`, `@hobo/runtime`) consume the report snapshot
  from parity tests without re-running lanes.

Promotion target: `packages/conformance/src/sdk/`.
