# Progressive Delivery Harness Reference Implementation

Epic: Progressive Delivery - The Harness (`122f5e0a-30d6-4949-9285-9441d18c36d9`)

This reference implementation rolls up the Harness POCs into one runnable, epic-scoped architecture slice. It is not production code. It demonstrates how HoBo's progressive delivery core composes feature flags, delivery orchestration, SLO gates, experiment analysis, policy obligations, and rollback hardening through mocked service boundaries.

## Included Lower-Layer Proofs

- [`hobo-experiment-port`](../../technical-proofs/hobo-experiment-port) — typed experiment assignment, exposure, and conclusion events used by the experiment leg.
- The validated experiment-statistical-analysis proof remains included; its guardrail simulation is unchanged.
- Experiment-port changes are absorbed without changing assignment, exposure, or conclusion semantics.

## Vertical Slice

```gherkin
Feature: Progressive delivery through the Harness

  Persona: Platform operator

  Scenario: release checkout-v2 safely
    Given checkout-v2 is deployed dark behind a fresh feature-flag ruleset
    When the operator starts a canary rollout
    Then the Harness policy-gates the flag flip, shifts mocked gateway traffic, evaluates mocked SLO snapshots, records experiment exposure, and either promotes or rolls back through one audit stream
```

## What Is Implemented

- Deterministic feature-flag evaluation against a mocked `ruleset@seq`.
- Policy-gated flag flip and rollout decisions.
- Canary delivery over 10/50/100 mocked traffic splits.
- SLO snapshot decisions that promote, hold, or roll back.
- Experiment assignment, exposure, and guarded conclusion.
- Negative cases for stale rulesets, underpowered experiments, stuck traffic splits, and failed rollback compensation.
- Pact-style consumer contracts for every mocked boundary.

## What Is Mocked

- Policy plane decisions.
- Gateway/domain traffic split provider.
- Reliability SLO snapshot provider.
- Feature-flag provider or OpenFeature adapter.
- Streamer/event-log ruleset sync.
- Experiment analytics provider.
- Event stream append boundary.
- Rollback compensator.

## What Is Deferred

- SDK flag ergonomics (`ctx.flags`, `useFlag`).
- Preview environments.
- Real OpenFeature, delivery, and experiment vendor adapters.
- Cross-Camp flag replication.
- Flag-debt cleanup.
- Real SLO computation, real gateway drivers, real policy engine, and live telemetry.

## Running

```powershell
npm.cmd --prefix src\draft\epic-proofs\progressive-delivery-harness test
npm.cmd --prefix src\draft\epic-proofs\progressive-delivery-harness run simulate
```

See:

- [architecture.md](./architecture.md)
- [scope-review.md](./scope-review.md)
- [poc-rollup-ledger.md](./poc-rollup-ledger.md)
- [contracts/pact-inventory.md](./contracts/pact-inventory.md)
- [simulation/README.md](./simulation/README.md)


The openexperiment runtime-data and policy-gated flag changes are absorbed without changing assignment, exposure, rollout, or fail-closed gating semantics.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Progressive Delivery Harness.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The SDK-flag, SLO-gated rollback, SLO-promotion, and stuck-rollout technical proof refreshes are absorbed without changing progressive-delivery evidence.
