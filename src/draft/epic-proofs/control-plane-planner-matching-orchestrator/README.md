# Control Plane Reference Architecture

Epic: Control Plane: Planner, Matching & Orchestrator  
Linear: 0b863d00-e180-4ad1-a8d8-a58049252a71  
Run: sprawl-20260629T050542Z-9e30

This reference implementation rolls the Control Plane POCs into one deterministic, fixture-backed vertical slice. It demonstrates how the Yard turns a Bindle manifest into a DeploymentPlan, records auditable Matching decisions, applies Deltas to Sets, drives ResourceActors through mocked IaC/executor boundaries, handles drift and rollback, and bootstraps a self-host Yard without live services.

## BDD scenarios

```gherkin
Feature: Control Plane planning and orchestration

  Persona: Platform engineer

  Scenario: Plan a Bindle into replayable provider decisions
    Given a collected manifest and registered Resource Definitions
    When the Planner resolves resources for prod
    Then it emits a deterministic DeploymentPlan with match.Decided evidence
```

```gherkin
Feature: Control Plane reconciliation

  Persona: Release manager

  Scenario: Promote a Delta into a Set and converge resources
    Given an approved deployment Delta
    When the Orchestrator applies the Set
    Then ResourceActors reconcile only changed nodes through mocked executor and driver boundaries
```

```gherkin
Feature: Control Plane safety

  Persona: SRE operator

  Scenario: Recover from drift and partial realization
    Given provider drift and a created-but-not-in-state failure
    When the level-triggered reconcile loop runs
    Then the reference rolls back, records the orphan, and blocks double-spend dispatch
```

```gherkin
Feature: Control Plane self-host bootstrap

  Persona: DevOps platform owner

  Scenario: Seed a Yard and hand over identity
    Given a local seed Yard and one short-lived operator credential
    When the real Yard Identity becomes ready
    Then the seed event log is imported, the seed credential is retired, and duplicate bootstrap is blocked
```

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src\draft\epic-proofs\control-plane-planner-matching-orchestrator run simulate
```

What this proves:

- Planner, Matching, capability feedback, and region/objective decisions are replayable.
- Delta/Set, ResourceActor, executor, and driver dispatch boundaries are mocked and deterministic.
- Drift, partial-realize rollback, orphan sweep, and dispatcher reservation conflicts fail closed.
- DeploymentView reconstructs the saga graph from linked events with validated envelope fields.
- Delta/Set reconciliation and DeploymentView saga projection retain their validated boundaries after the latest leaf hardening.
- Self-host bootstrap uses single-use operator credential evidence and explicit Identity handover.

Mocked boundaries:

- Manifest collector, Resource Definition catalog, Capability registry, objective ledger, Gatekeeper, Set store, ActorHost/EventStore, Executor, Driver adapter, Drift refresh, Identity token broker, Bootstrap handover, and DeploymentView projection.

Contracts:

- See `contracts/pact-inventory.md` and `contracts/pacts/*.pact.json`.

## Scope

This is a reference architecture package, not product implementation. It does not call live clouds, live IaC tools, real Identity, real Gatekeeper, real Registry, real EventStore, or real provider APIs.


Region-objective ranking changes are absorbed without changing deterministic placement or budget-selection behavior.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Control Plane Planner Matching Orchestrator.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The `self-host-bootstrap-saga-contract` technical proof refresh is absorbed without changing deterministic planner or orchestration evidence.
