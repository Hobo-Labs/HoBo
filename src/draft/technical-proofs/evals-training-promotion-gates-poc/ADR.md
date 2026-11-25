# Evals + Training Promotion Gates POC — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

This package applies **parse, don't validate**: untrusted promotion-gate config,
eval events, OTLP batches, and lint reports cross one parser boundary and become
**parsed domain types** (`validatePromotionGate`, `validateEvalEvent`,
`lintUseTrainingSource`, tenant OTLP batch validation). Downstream orchestration
receives those parsed types instead of re-checking raw DTOs.

## Event Architecture

Promotion orchestration names this event flow:

- **Command** — `PromoteTrainingCandidate` (challenger + gate inputs).
- **Event** — `training.Promoted`, `impl.Promoted`, `eval.GatePassed`,
  `eval.GateFailed`, `training.TrajectoryRewarded`.
- **Actor** — champion/challenger promotion aggregate owns candidate lifecycle.
- **Event store** — append-only promotion log + eval stream (`eval:*` stream ids).
- **Materialized view / projection** — live-eval runtime folds label batches into
  gate decisions and reward writes.
- **Snapshot** — current champion source + candidate state map.
- **Read store** — tenant OTLP backend receives exported span/reward snapshots
  for observability queries.

No runtime engine is implemented here; this POC names the boundaries so production
`packages/evals` and `packages/training` inherit consistent vocabulary.
