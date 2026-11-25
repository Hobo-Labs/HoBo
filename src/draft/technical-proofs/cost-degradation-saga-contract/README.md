# Cost Degradation Saga Contract POC

Independent POC for HOBO-311. It pins the M2 cost-driven graceful degradation
saga between budget/quota policy, cost-signal facts, SLO floors, and the
runaway-spend breaker without implementing runtime enforcement levers.

## Contract Surface

- `evaluateCostDegradationSaga({ requirement, profile, resources, runtime, priorEvents, now })`
  consumes a durable `spend.DegradationRequired` fact and a
  `costAvailabilityProfile`.
- Ordered tiers select safe degradation steps such as request-priority shedding,
  feature-flag shed, cache-TTL brownout, canary hold, or scale-to-zero for
  non-critical load.
- Request-priority shedding returns explicit `503` responses with
  `Retry-After`; silent hangs are not a valid degradation strategy.
- Recovery uses hysteresis before emitting `spend.DegradationRolledBack`.
- The handoff to the runaway-spend breaker carries
  `degradationExhausted`, so the breaker only trips after graceful tiers are no
  longer safe.

## Scope Boundaries

Included:

- Spend crossing a profile tier emits replayable `spend.DegradationApplied`
  facts for selected degradation steps.
- Recovery below the tier threshold rolls back only after configured
  hysteresis.
- Critical-path resources are protected from destructive shedding.
- `degrade-all` can use non-destructive cache-TTL brownouts on critical
  resources while keeping destructive shedding off critical paths.
- Retry-After shedding fails closed when caller retry budgets would create a
  retry storm.
- Availability SLO floors are treated as a hard safety constraint.
- Fail-closed exhaustion produces a breaker handoff instead of pretending that a
  silent shed occurred.

Excluded:

- Budget/quota policy evaluation and `spend.DegradationRequired` production.
- Runtime feature-flag, rollout, scale, or request routing implementation.
- Runaway-spend breaker mechanics after the exhaustion handoff.
- SLO computation, showback, billing, or cost projection engines.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\cost-degradation-saga-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Cost Degradation Saga Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
