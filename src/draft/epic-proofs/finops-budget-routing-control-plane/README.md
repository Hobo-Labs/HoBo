# FinOps Budget Routing Control Plane

Design: [`docs/design/finops-budget-routing-control-plane.md`](../../../../docs/design/finops-budget-routing-control-plane.md)

This epic proof composes existing HoBo FinOps, policy, control-plane, and
adapter evidence into a standards-first budget routing control plane. It is not
production code. It proves the public router contract with mocked service
boundaries, Protobuf/CUE architecture evidence, Pact-style fixtures, and a
deterministic simulation harness.

## Cascade reconciliation

The referenced `cost-degradation-saga-contract` technical proof was refreshed in the latest technical-proof commit; this rollup retains the existing budget-routing simulation and scope.

## Vertical Slices

```gherkin
Feature: Standards-first resource intent routing

  Persona: application developer

  Scenario: Dry-run explains why a provider-neutral resource lands on one abstract placement
    Given a ResourceIntent with budget, capability, and latency requirements
    When the router evaluates abstract candidates
    Then it emits a DecisionGraph and backend-neutral ActionPlan without provider, SKU, region, account, or backend API leakage
```

```gherkin
Feature: Governed metric routing

  Persona: platform engineer

  Scenario: User metrics cannot destabilize placement
    Given system, derived, and user metric contracts
    When a user metric references raw telemetry or an unapproved transform
    Then the parser rejects it before routing can evaluate candidates
```

```gherkin
Feature: Constraint-first multi-objective selection

  Persona: FinOps lead

  Scenario: Hard constraints dominate preferences
    Given valid and invalid routing candidates
    When constraint filtering, policy evaluation, Pareto construction, and preference selection run
    Then invalid candidates never receive metric vectors and weights apply only inside the Pareto frontier
```

```gherkin
Feature: Stability-controlled feedback loop

  Persona: SRE operator

  Scenario: Noisy actuals cannot churn deployments
    Given recent routing history and an attractive but small improvement
    When the stability controller evaluates cooldown and migration penalty
    Then it keeps the current placement and records a feedback proposal instead of mutating policy or metrics
```

## Service Boundaries

| Boundary | Mock strategy | Contract |
|---|---|---|
| MetricContractRegistry | In-memory Protobuf/CUE-shaped metric contract parser | `contracts/pacts/metric-contract-registry.pact.json` |
| ConstraintEngine | Deterministic capability, budget, jurisdiction, security, and eligibility filter | `contracts/pacts/constraint-engine.pact.json` |
| ParetoEvaluator | Pure non-dominated frontier builder and preference selector | `contracts/pacts/pareto-evaluator.pact.json` |
| StabilityController | Fixed-clock routing-history, hysteresis, cooldown, migration-penalty mock | `contracts/pacts/stability-controller.pact.json` |
| DecisionGraphPublisher | In-memory graph and audit-event projection | `contracts/pacts/decision-graph-publisher.pact.json` |
| FeedbackProposalGate | Proposal-only feedback governance with versioned metric change handoff | `contracts/pacts/feedback-proposal-gate.pact.json` |
| SimulationRunner | Offline DX/OpsX/FinX simulation surface over the same DecisionGraph | `contracts/pacts/simulation-runner.pact.json` |

## Running the Epic Simulation

```bash
npm.cmd --prefix src/draft/epic-proofs/finops-budget-routing-control-plane run simulate
```

## Verification

```bash
npm.cmd --prefix src/draft/epic-proofs/finops-budget-routing-control-plane test
```

## What Is Real

- Parser functions reject provider-specific leakage and unsafe metric contracts.
- Candidate filtering runs before metric vector construction.
- Pareto frontier construction runs before preference weighting.
- Stability decisions are deterministic against pinned routing history.
- Pact-style fixtures name every mocked boundary.
- DX, OpsX, and FinX views share one DecisionGraph id.
- `proof.json` pins the validated cost-degradation saga proof in this rollup; its deterministic simulation contract is unchanged.

## Budget-routing safety revision

The pure evaluator now parses canonical generated Protobuf inputs from
`data-models/` before it evaluates anything. The historical `architecture/`
files are exact mirrors, checked by a test. CUE fixtures include a complete
valid scenario and invalid negative-budget/missing-exposure scenarios.

- Numeric availability and latency are hard requirements. Candidate IDs,
  accounting periods, monetary precision, finite measurements, and snapshot
  content hashes are checked before scoring.
- A proposed hosting commitment includes operation and transition cost. Its
  conservative bound is checked against settled spend, existing commitments,
  unresolved exposure, and a protected recovery allowance. A zero budget is a
  real ceiling. All monetary arithmetic uses integer microdollars internally.
- The metric registry must include all immutable system metrics. Derived
  `weighted_sum`/`ratio` compositions and approved user compositions are
  dependency-checked and actually evaluated. Unsupported transforms fail at
  the parser instead of being advertised as executed. Versioned fixed
  reference normalization prevents catalog additions from rescaling existing
  preferences.
- Stability evaluates the incumbent's current feasibility independently of
  Pareto membership. Net improvement includes migration penalty; cooldown,
  sustained challenger evidence, and windowed flip limits are separate gates.
  An infeasible incumbent cannot be retained by an optimization hold.
- Every decision records the actual ledger sequence, budget/period/policy
  identity, catalog/metric content hashes, and complete input digest. Replay
  uses those inputs and never invokes an execution adapter.

Effects and resilience reuse `@hobo/contracts` (ADR-0136). Planning declares
`pure`; the proposed external mutation declares `noRollback`, a timeout and
bulkhead, and no mutation retry/hedge. Observations have a bounded deterministic
retry profile. The action remains **unauthorized** until a production supervisor
obtains a financial reservation and satisfies movement/health prerequisites.
An unknown provider outcome requires reconciliation and observed readback.
This proof does not implement provider execution, durable financial admission,
or a production rollback/retirement supervisor.

The loopback cutover behavior explicitly supplies mocked budget, persistence,
and admission ports; it exercises the promoted routing implementation while
making no claim about a cloud provider's billing or durability.
Each applied ramp and restoration remains active until five actual proxy requests
complete. The acceptance assertion requires at least twenty requests with zero
failures; request counts, rather than assumed throughput during a sleep, bound
the observation interval under concurrent validation load.

## What Is Mocked

- FOCUS actuals, cost estimates, MeteringView usage, OpenTelemetry signals, and
  CloudEvents/CDEvents are deterministic fixture inputs.
- Terraform plan JSON, Pulumi Automation API, Crossplane composition, and
  Kubernetes/runtime-controller execution are adapter labels only.
- No live billing API, provider API, cloud credential, production IaC, policy
  service, dashboard, or external telemetry backend is called.

## Architecture Evidence

This package ships the architecture-guard evidence required by HoBo draft
packages:

- `architecture/` contains Protobuf data shapes and CUE constraints for the
  router contracts.
- `contracts/pacts/` contains Pact-style consumer fixtures for each boundary.
- `architecture.md` records parse-don't-validate and event-architecture evidence.
- `features/finops-budget-routing-control-plane.feature` records the behavior
  suite in Gherkin form.
