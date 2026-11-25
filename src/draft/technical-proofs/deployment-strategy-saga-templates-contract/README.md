# Deployment strategy saga templates contract POC

This draft pins the Harness-side strategy templates that turn a service rollout into replayable
`rollout.*` saga events over the `hobo:delivery` gateway seam.

## Contract

- `canaryStrategy(...)` and `progressiveStrategy(...)` compile staged traffic-shift steps that call
  the gateway with idempotent `gateway.shiftTraffic` commands and consume health, SLO-burn, and
  Golden-suite gate signals. Staged templates must end at 100% traffic before promotion.
- `blueGreenStrategy(...)` compiles a green-slot prepare, pre-flip health gate, router flip, and
  retain-blue soak step for fast rollback. When `reapAfterSoak` is enabled, it adds a post-soak
  `deployment.reapBlue` step that is rejected unless the green health gate passed and blue is still
  retained.
- `recreateStrategy(...)` compiles stop-old, start-new, and route-new steps behind a health gate.
- `createDeploymentStrategySaga(...).run(...)` emits CloudEvents-shaped `rollout.Started`,
  `rollout.Stepped`, `rollout.GateEvaluated`, `rollout.Failed`, `rollout.RolledBack`, and
  `rollout.Promoted` events compatible with the delivery-orchestrator skeleton replay contract.
- `replayGatewayState(events)` rebuilds the gateway-facing state from the emitted rollout events.
- Held gateway traffic-split acquisition emits a non-advancing gate event, so replay resumes the
  same progressive stage instead of skipping ahead.
- Half-applied router flips retry idempotently and roll back if the gateway never converges.

## Scope boundary

This POC does not compute SLO burn rates, run Golden suites, implement provider deploy adapters,
enforce deploy freezes, or apply AI live fixes. It only consumes injected gate signals and executes
provider-agnostic gateway/deployment commands.

## Verify

```powershell
npm.cmd --prefix src\draft\technical-proofs\deployment-strategy-saga-templates-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Deployment Strategy Saga Templates Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
