# Progressive Delivery Harness Scope Review

## Selected Slice

The reference implementation rolls up one epic: Progressive Delivery - The Harness. The slice is the safety loop for a deployed change:

```gherkin
Feature: Progressive delivery through the Harness

  Persona: Platform operator

  Scenario: safely release checkout-v2 through flags, canary traffic, SLO gates, and experiment analysis
    Given a deployed-but-dark checkout-v2 build and a fresh flag ruleset
    When the operator starts a canary rollout
    Then the Harness policy-gates the flag flip, advances traffic through mocked gateway splits, checks mocked SLO snapshots, records experiment exposure, and promotes or rolls back through one replayable event stream
```

## Accepted POC Mappings

| Accepted POC cluster | Requirement proved | Kept | Discarded or bounded |
|---|---|---|---|
| Feature flag port, flag events, built-in flag store, ruleset sync, partition consistency | Flags are deterministic, replayable, stale-labeled, and policy-gated before risky production changes | `ruleset@seq` evaluation, freshness labels, `flag.Changed`/`flag.Evaluated`, fail-safe defaulting | SDK ergonomics, vendor SDK setup, real network sync, governance UI |
| Delivery port, delivery orchestrator, canary journey, SLO gate, rollback analysis | Delivery can advance 10/50/100 and rollback on SLO/Golden-suite evidence without stranding split traffic | Event-sourced rollout state, metric-gate decisions, auto-revert obligation lifecycle | Real gateway provider, real SLO computation, blue/green implementation depth |
| Experiment port, runtime data, statistical analysis, p-hacking guardrails | Assignment/exposure/conclusion are replayable and cannot self-certify from underpowered or unscheduled looks | Sticky assignment, idempotent exposure, guarded conclusion result | Vendor adapters, ML/training loop integration |
| Stuck rollout convergence and rollback failure compensation | Negative paths reach terminal safe states instead of indefinite "in progress" | Observed traffic is authoritative, rollback retries are bounded, escalation is explicit | Human-resolution workflow and paging integration |
| Adapter conformance suite | Built-in and external adapters must satisfy the same consumer behavior | Shared contract verification expectation | Real adapter credentials, vendor SDKs |

## Adversarial Decisions

- Stale ruleset behavior is in scope because copying happy-path flag code would make the simulation misleading during Streamer partitions.
- SLO telemetry is mocked and pinned by sequence. The reference does not compute SLO burn rates; that remains Reliability-owned.
- Gateway traffic split is mocked. The reference asserts the Harness calls the boundary and validates observed split state before promotion.
- Experiment conclusion is allowed to be `do-not-conclude` while delivery promotes. This avoids turning experiment analysis into an unsafe release gate.
- Rollback failure is not treated as success. Exhausted compensation emits `rollout.NeedsHuman` and leaves an escalated obligation.
- Cross-Camp flag replication, preview environments, flag-debt cleanup, SDK ergonomics, and real vendor adapters are deferred or split because integrating them would expand beyond the epic-local Harness reference architecture.

## Contract Strategy

Every internal or external service boundary is represented by a Pact-style consumer contract under `contracts/pacts/`. Provider verification in this reference runs against deterministic mocked providers only. External vendors are documented as mocked-provider-unavailable, not omitted.

## Requirement Change Review

No requirement change request was required. The POCs agree with ADR-0044, ADR-0045, ADR-0046, ADR-0082, and ADR-0083 when the reference separates Harness orchestration from Reliability SLO computation, real gateway providers, and vendor adapters.
