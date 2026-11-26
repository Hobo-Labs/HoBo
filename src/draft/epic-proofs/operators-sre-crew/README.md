# Operators & SRE - the Crew Reference Implementation

Epic: [036f25f3-94bf-4253-ac06-d128eaedbf49](https://linear.app/quickdeploy-ai/project/operators-and-sre-the-crew-b24795969c2d)

This reference implementation rolls the Operators/SRE Crew POCs into one runnable epic-level architecture slice. It is not production HoBo runtime code. It is a deterministic proof harness that shows how the SRE operator, endpoint monitor, policy gate, live-fix gateway, human approval, integration ports, chaos boundary, and DR replay boundary compose without live external services.

## Vertical slices

```gherkin
Feature: SRE operator self-healing

  Persona: SRE operator

  Scenario: Provider degradation is remediated through a gated canary
    Given the endpoint monitor reports high API SLO burn
    When the SRE operator diagnoses provider degradation
    Then one incident opens, policy allows a canary, live-fix completes, and replay evidence publishes
```

```gherkin
Feature: Human-in-the-loop production remediation

  Persona: SRE operator

  Scenario: Production contract skew waits for approval
    Given a compatibility gate fails between a producer and consumer
    When the SRE operator proposes a dual-publish shim
    Then the action waits for operator-console approval before the remediation gateway is called
```

```gherkin
Feature: Fail-closed remediation safety

  Persona: SRE operator

  Scenario: Ambiguous self-caused drift escalates
    Given a drift signal may have been caused by prior remediation
    When the taxonomy cannot classify it safely
    Then the runaway guard opens a circuit and the Crew requests human handoff without another write
```

```gherkin
Feature: Disaster recovery failover

  Persona: SRE operator

  Scenario: DR failover proves fencing and replay before traffic shift
    Given a production region is unavailable
    When the DR runbook evaluates failover
    Then fencing, RPO honesty, and replicated log replay are certified before traffic shift
```

## Running

```bash
npm.cmd --prefix src/draft/epic-proofs/operators-sre-crew test
npm.cmd --prefix src/draft/epic-proofs/operators-sre-crew run simulate
```

The simulation uses mocked boundaries only. It records zero live network calls and loads deterministic fixtures from [simulation/fixtures](simulation/fixtures).

## What is real

- The SRE decision flow is executable and covered by Node tests.
- The validated autonomous-drift-remediation proof is included in this rollup; its deterministic simulation contract is unchanged.
- Disaster-recovery failover, failover-integrity, and gated autonomous-remediation proofs retain their validated replay and approval boundaries.
- Every selected service boundary has a Pact-format consumer fixture under [contracts/pacts](contracts/pacts).
- The simulation drives incident, crew, policy, live-fix, A2H, integration-port, runaway guard, and DR replay events.
- The POC rollup ledger records accepted, implemented, deferred, and out-of-scope POCs.

## What is mocked

- SLO signal source.
- Projection read API.
- Policy engine.
- Live-fix/remediation gateway.
- A2H notify receiver.
- Issue tracker and knowledge ports.
- Replicated event log.
- Sandbox fault injector.

## Follow-up boundaries

Provider verification is documented as unavailable because no real providers exist in this design repo. The Pact files are consumer fixtures for the reference implementation and should be promoted into provider verification once the corresponding runtime, policy, live-fix, notify, issue-tracker, knowledge, event-log, and chaos providers exist.


Policy-gated flag changes are absorbed without changing operator safety, rollback, or fail-closed behavior.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Operators Sre Crew.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The runbook-execution, SRE-diagnose, SRE-postmortem, and SRE-operator technical proof refreshes are absorbed without changing operator or incident-response evidence.
