# V1 Vibe Example Gap Closure Architecture

## Boundary Map

| Boundary | Purpose | Mock strategy |
|---|---|---|
| VibeChildBacklogBoundary | Reads the child issue matrix for HOBO-539 | Checked-in fixture derived from Linear issue titles, phases, projects, paths, and coverage rules |
| VibeDxBackboneBoundary | Reads the corrected DX-first graph from HOBO-566 through HOBO-577 | Checked-in fixture derived from Linear parent/child, label, path, blocker, and quickstart-consumer relations |
| VibeScopeGuardBoundary | Rejects production/provider/customer-data/credential/claim creep | Deterministic forbidden-pattern guard |
| VibeUnblockLedgerBoundary | Records the parent blocker outcome for downstream work | In-memory evaluation summary; Linear state remains authoritative |

## Parse Boundary

The child backlog is represented as `VibeChildIssue` objects, and the corrected DX-first graph is
represented as `VibeDxSliceIssue` objects under `VibeDxBackboneGraph`. Evaluation functions consume
those derived shapes only after path, label, blocker, lifecycle, proof-mode, source-doc, phase, and
scope-out fields are explicit. The simulation never parses raw Linear markdown during tests.

## Event And Projection Model

Command: `EvaluateVibeGapClosure`.

Event: `vibeGapClosure.AcceptanceRecorded`, emitted when all child issue rows satisfy parent
acceptance.

Projection: `VibeGapClosureReadModel`, containing child count, child phase distribution, DX
backbone phase distribution, DX label coverage, quickstart consumer count, missing contract list,
and downstream unblock message.

Read store: tests and the simulation read only the projection summary. Future child automation reads
Linear after HOBO-539 is Done.

## Guardrail Evidence

Parse, don't validate: incoming command payloads, Pact fixtures, and protobuf/CUE-backed child
backlog records cross a parser boundary before the epic simulation uses them. The parsed domain
types are the `VibeChildIssue`, `VibeDxSliceIssue`, `VibeDxBackboneGraph`,
`VibeGapClosureBacklog`, and `VibeGapClosureEvaluation` records; mocked providers receive only
those derived types, not raw Linear markdown or unconstrained DTOs.

Event architecture: command handlers in the epic actors emit events into an in-memory event-store.
Materialized views and projections are rebuilt from that event stream, snapshots represent the
current read model, and historical snapshots are retained in a read store so automation, reviewer,
and simulation reads never infer state from mutable provider internals.
