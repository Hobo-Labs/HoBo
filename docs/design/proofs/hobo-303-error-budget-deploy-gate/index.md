# HOBO-303 Error-Budget Deploy Gate Proof

This proof covers the M3 reliability slice that turns ADR-0045 error-budget
signals into a `can-deploy` policy dimension and composes ADR-0044 auto-revert
obligations with deployment strategies and feature flags.

## Scope

- `src/draft/technical-proofs/error-budget-deploy-gate-contract` defines a pure contract over a
  deploy request, an SLO budget snapshot, prior policy decisions, and
  auto-revert obligations.
- The gate emits replayable `policy.Decided` events with SLO evidence for
  frozen, healthy, recovered, hysteresis-held, and break-glass deploy states.
- The obligation handler consumes `slo.BudgetBurned` and emits either
  `rollout.RolledBack` through the deployment-strategy saga contract or
  `flag.Changed` through the flag-plane contract.
- Failed auto-revert produces compensation escalation instead of silently
  satisfying the obligation.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Burning budget freezes a deploy or forces approval. | `freezes a deploy on burning budget and records replayable policy.Decided evidence` |
| In-flight rollout breaching budget auto-reverts via strategy saga. | `auto-reverts an in-flight rollout through the strategy saga when SLO burn triggers the obligation` |
| Feature flag auto-revert uses the same obligation surface. | `auto-reverts feature flags through the flag plane using the same obligation surface` |
| Healthy budget allows deploy. | `lifts a previous freeze when a fresh healthy budget recovers` |
| Every decision is replayable. | `freezes a deploy on burning budget and records replayable policy.Decided evidence` |
| Freeze lifts when budget recovers. | `lifts a previous freeze when a fresh healthy budget recovers` |

## Adversarial Mapping

| Risk | Executable proof |
|---|---|
| Budget recovers between gate check and apply. | `rechecks at apply and lifts a stale freeze when the budget recovered` |
| Auto-revert itself fails. | `escalates and preserves compensation evidence when auto-revert fails` |
| Flapping budget thrashes deploy state. | `holds a recovered budget until hysteresis confirms it is not flapping` |
| Emergency deploy override bypasses audit. | `allows emergency deploys through an audited break-glass override` |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\error-budget-deploy-gate-contract test
```
