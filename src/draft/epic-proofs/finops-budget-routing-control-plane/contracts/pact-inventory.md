# Pact Inventory

| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used in simulation | Status |
|---|---|---|---|---|---|---|---|
| Metric contract registry | FinopsRoutingControlPlaneEpic | MetricContractRegistry | HTTP-style request/response | `contracts/pacts/metric-contract-registry.pact.json`; `contracts/consumer/finops-routing-boundaries.test.ts` | Provider unavailable; simulation uses in-memory parser | Protobuf/CUE-shaped metric contract parser | consumer_tested |
| Constraint engine | FinopsRoutingControlPlaneEpic | ConstraintEngine | HTTP-style request/response | `contracts/pacts/constraint-engine.pact.json`; `contracts/consumer/finops-routing-boundaries.test.ts` | Provider unavailable; simulation uses deterministic filter | Capability, budget, jurisdiction, security, eligibility fixtures | consumer_tested |
| Pareto evaluator | FinopsRoutingControlPlaneEpic | ParetoEvaluator | HTTP-style request/response | `contracts/pacts/pareto-evaluator.pact.json`; `contracts/consumer/finops-routing-boundaries.test.ts` | Provider unavailable; simulation uses pure evaluator | Non-dominated frontier and preference selector | consumer_tested |
| Stability controller | FinopsRoutingControlPlaneEpic | StabilityController | HTTP-style request/response | `contracts/pacts/stability-controller.pact.json`; `contracts/consumer/finops-routing-boundaries.test.ts` | Provider unavailable; simulation uses fixed-clock history | Hysteresis, cooldown, migration penalty, flip limit fixtures | consumer_tested |
| Decision graph publisher | FinopsRoutingControlPlaneEpic | DecisionGraphPublisher | HTTP-style request/response | `contracts/pacts/decision-graph-publisher.pact.json`; `contracts/consumer/finops-routing-boundaries.test.ts` | Provider unavailable; simulation uses in-memory graph projection | Candidate, constraint, policy, metric, Pareto, stability, audit facts | consumer_tested |
| Feedback proposal gate | FinopsRoutingControlPlaneEpic | FeedbackProposalGate | HTTP-style request/response | `contracts/pacts/feedback-proposal-gate.pact.json`; `contracts/consumer/finops-routing-boundaries.test.ts` | Provider unavailable; simulation uses proposal-only governance | Actual-cost and operator-override proposal fixtures | consumer_tested |
| Simulation runner | FinopsRoutingControlPlaneEpic | SimulationRunner | HTTP-style request/response | `contracts/pacts/simulation-runner.pact.json`; `contracts/consumer/finops-routing-boundaries.test.ts` | Provider unavailable; simulation uses local scenario fixtures | DX/OpsX/FinX views over one DecisionGraph | consumer_tested |

All providers are mocked because this is an epic proof package, not the
production control plane. Missing provider availability is documented as mocked
boundary behavior rather than omitted from the contract map.
