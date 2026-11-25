# Gated Live-Fix Loop Reference Implementation

Epic proof for **HOBO-654** (S5-09). Implements the gated live-fix loop from
[Plan 23](../../../docs/design/generated-stack.md#plan-23) and
[Plan 05](../../../docs/design/reliability-observability-cost.md#plan-05):
risk classification, auto-canary with auto-rollback, trace-to-test retention,
and event-sourced generation/validation/gate/apply steps.

Promotes live-fix scenarios from:

- `src/draft/epic-proofs/generation-pipeline-training-ai-safety/`
- `src/draft/epic-proofs/progressive-delivery-harness/`

## Vertical Slice

```gherkin
Feature: Gated live-fix loop

  Persona: SRE repairing a drifted generated stack

  Scenario: SLO regression drives low-risk fix through canary with auto-rollback
    Given a staging SLO regression and a captured failing trace
    When the policy engine classifies the fix as low-risk and starts a canary
    Then canary SLO regression triggers auto-rollback and the failing trace persists as a permanent regression test

  Scenario: Production fix blocks until approved
    Given a production incident and a generated fix candidate
    When the policy engine classifies the fix as high-risk
    Then human approval is required before any canary starts and the failing trace is retained
```

## What Is Implemented

- SLO regression detection as loop trigger (`slo.RegressionDetected`).
- Failing trace capture and permanent regression test retention.
- Candidate generation/validation event stream (`gen.*`).
- Policy risk classification (low-risk canary vs prod/destructive/blast-radius approval).
- Canary apply with SLO-gated rollback analysis from progressive delivery machinery.
- Full event replay via `replayGatedLiveFixLoop`.

## Child POCs Composed

| POC | Path | Role |
|---|---|---|
| Live-fix gated candidate | `src/draft/technical-proofs/live-fix-gated-candidate-contract` | Policy gate, canary, rollback, trace retention |
| SLO-gated rollback analysis | `src/draft/technical-proofs/slo-gated-rollback-analysis-contract` | Canary SLO observation and rollback verdict |

## Running

```bash
pnpm --prefix src/draft/epic-proofs/gated-live-fix-loop test
pnpm --prefix src/draft/epic-proofs/gated-live-fix-loop run simulate
```

## Architecture Evidence

- `architecture/` — protobuf + CUE constraints.
- `architecture/pacts/` — PACT boundary fixture.
- `ADR.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The `slo-gated-rollback-analysis-contract` technical proof refresh is absorbed without changing live-fix gating or rollback evidence.
