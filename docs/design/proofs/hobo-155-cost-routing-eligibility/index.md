# HOBO-155 Cost-Routing Eligibility Proof

This branch proves the per-route `cost` routing eligibility contract from
ADR-0035, ADR-0040, and ADR-0071.

## Acceptance Mapping

| Issue acceptance | Executable proof |
|---|---|
| Can-deploy refuses cost-routing for a route whose reachable set includes single-writer and allows all-eligible routes. | `src/draft/technical-proofs/cost-routing-eligibility-contract/test/cost-routing-eligibility.test.ts` asserts refusal for `single-writer` reachability and approval for `active-active-eventual`/`pinned` reachability. |
| Mixed domain routes single-writer paths home and cost-routes eligible paths. | The mixed-domain test keeps a checkout path on its home Camp while routing a catalog path to the cheapest healthy Camp. |
| Cost flips are hysteresis-bounded. | The hysteresis test holds the previous Camp through rapid sub-threshold cost oscillation and flips only after savings exceed the configured bound. |
| `can-deploy` asserts no single-writer route is cost-routed. | `assertNoSingleWriterCostRoutes()` throws when a planned `cost` route reaches single-writer state and passes for home-routed single-writer paths. |

## Adversarial Coverage

| Adversarial case | Guard |
|---|---|
| Route becoming single-writer-reachable after topology change loses eligibility next plan. | The topology-change test replans the same route after an `active-active-eventual` dependency becomes `single-writer`; the next plan is refused for cost routing and sent home. |
| Rapid price oscillation must not thrash routing. | The hysteresis test evaluates multiple near-threshold price changes and confirms no routing events are emitted until the bound is crossed. |

## Scope Boundary

The POC intentionally consumes, rather than rebuilds, these adjacent seams:

- Cost facts from the Dispatcher and metering/cost plane.
- Non-cost routing policies already proven by HOBO-151.
- Replica topology selection from ADR-0040.
- Concrete DNS provider adapters.
