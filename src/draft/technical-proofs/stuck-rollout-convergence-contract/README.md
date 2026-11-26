# Stuck Rollout Convergence Contract

Independent POC for HOBO-372. It hardens the Harness delivery path when a rollout stops making progress after the normal `delivery-orchestrator` and deployment-strategy contracts have already started emitting `rollout.*` events.

## Contract

- `convergeStuckRollout(...)` consumes a replayable rollout event log, the declared rollout policy, and observed gateway/traffic-split state.
- A progress deadline converts unresolved gates and stale half-shifts into a terminal verdict instead of leaving a rollout running forever.
- Observed traffic state is authoritative over provider self-report: a provider that reports success while traffic remains split is treated as non-converged.
- Recovery is single-writer. A second recovery attempt for the same rollout yields no actions/events while the first owns the lease.
- Safe terminal outcomes are `rollout.RolledBack`, `rollout.Promoted` only when the target is proven healthy, or `rollout.Failed` with `state: "needs-human"` when convergence cannot complete.

## Scope Boundary

This package does not implement happy-path canary/blue-green/progressive strategies, SLO analysis, rollback-itself-fails compensation depth, real gateway providers, or traffic-split provisioning. It only proves stuck rollout detection and safe convergence against injected event logs and observed gateway state.

## Verify

```powershell
npm.cmd --prefix src\draft\technical-proofs\stuck-rollout-convergence-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Stuck Rollout Convergence Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
