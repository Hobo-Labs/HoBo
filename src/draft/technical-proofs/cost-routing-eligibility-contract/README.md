# Cost-Routing Eligibility Contract

Independent proof for HOBO-155. It models the `hobo:dns` can-deploy check
that decides which domain routes may use `cost` routing.

## Contract Surface

- `evaluateCostRoutingPlan()` walks each route's reachable resource graph.
- Cost-routed routes are refused when any reachable resource is
  `single-writer`.
- Explicit home routes remain valid for single-writer paths in mixed domains.
- Eligible routes select the cheapest healthy validation-cleared Camp.
- `assertNoSingleWriterCostRoutes()` is the can-deploy invariant check.
- Cost flips respect a minimum savings hysteresis threshold.

## Proof Boundaries

This proof consumes resource topology, route declarations, Camp health, and
effective marginal cost facts. It does not implement the Dispatcher cost model,
the other routing policies from HOBO-151, DNS adapters, or replica topology
selection.

## Executable Checks

```powershell
npm.cmd --prefix src\draft\technical-proofs\cost-routing-eligibility-contract test
```

The checks cover single-writer refusal, all-eligible route approval, mixed
domain home/cost routing, topology-change re-evaluation, hysteresis-bounded
price oscillation, and the final can-deploy assertion.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Cost Routing Eligibility Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
