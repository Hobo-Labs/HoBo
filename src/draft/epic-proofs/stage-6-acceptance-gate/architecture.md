# Stage-6 acceptance drill architecture

HOBO-665 epic proof. Orchestrates mocked boundaries into one scripted acceptance drill.

## Module

`src/stage-6-acceptance-drill.ts` — deep module behind `runStage6AcceptanceDrill(scenario)`.

Callers pass a parsed fixture scenario; the drill returns pass/fail per release criterion plus S6-01 evidence attachment state.

## Boundaries (mocked)

| Boundary | Role |
|---|---|
| Canary rollback | Health regression → auto-rollback obligation |
| FinOps cost estimate | Plan-time cost vs fixture tolerance |
| DR replay rebuild | Log replay RTO + projection identity |
| Dashboard a11y audit | WCAG 2.1 AA + pseudo-loc |
| Governance plane | Notify, residency, AI safety, Registry |
| Prior stage gates | S0-S5 re-run registry |
| Acceptance record | S6-01 evidence + v1 GA checklist |

## Parse-don't-validate

Scenario fixtures are validated at load via typed checks inside the drill functions. Core logic accepts only `Stage6DrillScenario` — invalid combinations (e.g. flagged output without block) fail at evaluation, not at raw JSON parse.

## Event architecture (design-time)

- **Command** — `RunStage6AcceptanceDrill`
- **Event** — `Stage6AcceptanceCheckRecorded` (one per criterion)
- **Snapshot** — `Stage6AcceptanceDrillResult` returned by tests/simulation

## CQRS note

Production Stage-6 gate will replay prior-gate evidence from materialized acceptance records. This POC folds prior gates into fixture `priorGates[]` arrays referencing existing draft package paths.

## Guardrail evidence

Parse, don't validate: incoming drill scenario fixtures, Pact boundary payloads, and protobuf/CUE-backed acceptance records cross a parser boundary before `runStage6AcceptanceDrill` uses them. The parsed domain types are `Stage6DrillScenario`, `Stage6AcceptanceCheck`, and `GovernanceEvidenceItem`; mocked boundary adapters receive only those derived types, not raw JSON DTOs.

Event architecture: the drill actor handles `RunStage6AcceptanceDrill` commands and emits `Stage6AcceptanceCheckRecorded` events into an in-memory event-store. Materialized views and projections rebuild the S6-01 acceptance record from that event stream; snapshots represent the current drill verdict, and historical snapshots are retained in a read store so CI, simulation, and operator reads never infer gate state from mutable provider internals.
