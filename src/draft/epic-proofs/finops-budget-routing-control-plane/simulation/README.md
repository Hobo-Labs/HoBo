# FinOps Routing Simulation

Run:

```bash
npm.cmd --prefix src/draft/epic-proofs/finops-budget-routing-control-plane run simulate
```

The simulation proves:

- `standards-first-intent-routing`: provider-neutral intent parses, constraints
  run first, and the final ActionPlan is backend-neutral.
- `governed-metric-routing`: invalid user metrics and metric contract changes
  fail before routing.
- `constraint-first-selection`: invalid candidates receive no metric vectors,
  dominated candidates leave the Pareto frontier, and preference weights select
  only from the frontier.
- `stability-controlled-feedback`: cooldown and minimum-improvement rules block
  churn while feedback creates proposals instead of direct mutations.

Mocked boundaries:

- `MetricContractRegistry`: in-memory contract parser.
- `ConstraintEngine`: deterministic hard-filter function.
- `ParetoEvaluator`: pure frontier and preference selector.
- `StabilityController`: fixed-clock routing history.
- `DecisionGraphPublisher`: in-memory decision graph and audit facts.
- `FeedbackProposalGate`: proposal-only governance.
- `SimulationRunner`: DX/OpsX/FinX views over one graph.
