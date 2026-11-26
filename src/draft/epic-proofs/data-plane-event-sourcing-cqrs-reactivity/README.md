# Data Plane: Event Sourcing, CQRS & Reactivity

This epic reference implementation rolls the Data Plane child POCs into one runnable architecture slice. It is not production code: service boundaries are mocked, external providers are absent, and the implementation demonstrates the intended architecture with deterministic fixtures.

Reference service: `services/data-plane-reference-architecture.ts`

Simulation command:

```bash
npm.cmd --prefix src\draft\epic-proofs\data-plane-event-sourcing-cqrs-reactivity run simulate
```

Test command:

```bash
npm.cmd --prefix src\draft\epic-proofs\data-plane-event-sourcing-cqrs-reactivity test
```

## Persona And BDD

```gherkin
Feature: Event-sourced Snapshop orders

  Persona: App developer building a reactive commerce workflow

  Scenario: Place an order and read it through a reactive projection
    Given a typed domain event body, a CQRS aggregate, and a tenant-scoped order materialization
    When the app places an order
    Then the event appends once, replay/live projection agrees, GraphQL reads the snapshot, and the Reactor pushes the updated view
```

```gherkin
Feature: Portable projection sinks and search

  Persona: Platform data engineer mapping read models to Camp-specific infrastructure

  Scenario: Keep reads portable while exposing explicit escape hatches
    Given relational, document, native-log, full-text, vector, and graph projection surfaces
    When the reference projection updates and search runs
    Then every sink boundary emits a contract-visible decision and raw driver access stays read-only and portability-flagged
```

```gherkin
Feature: Fail-closed data-plane adversarial behavior

  Persona: Security and privacy reviewer protecting audit and tenant boundaries

  Scenario: Handle stale, poisoned, revoked, and erased data without rewriting history
    Given projection lag, snapshot divergence, a poison event, a revoked session, and an erasure request
    When the data plane rebuilds from the log
    Then stale reads are labeled, poison events are quarantined, revoked subscriptions deny, and erased fields tombstone without log rewrite
```

## Vertical Slices

| Slice | Implemented behavior | Main POCs |
|---|---|---|
| CQRS write to reactive read | WIT/protobuf domain body, aggregate command, append-only event, replay/live equivalence, Reactor push, GraphQL snapshot | HOBO-42, HOBO-46, HOBO-51, HOBO-53, HOBO-57, HOBO-60, HOBO-65, HOBO-69, HOBO-74, HOBO-76, HOBO-80, HOBO-85, HOBO-92, HOBO-96, HOBO-107 |
| Projection sinks and search | Relational/document/native sink decisions, change-feed, full-text search, vector extension, embed capability, raw escape hatch | HOBO-232, HOBO-234, HOBO-237, HOBO-245, HOBO-248, HOBO-252, HOBO-265 |
| Adversarial data integrity | Snapshot cache boundary, bounded-staleness, projection lag, poison-event quarantine, crypto-shred erasure, auth/flag read-set repush, coalesced fan-out, rebuild-from-zero | HOBO-240, HOBO-256, HOBO-261, HOBO-269, HOBO-273, HOBO-278, HOBO-283, HOBO-288, HOBO-291, HOBO-295 |

## What Is Real

- Existing POC contract modules are imported and executed for CQRS, replay/live, GraphQL, search, raw access, auth/flag read-sets, and crypto-shred behavior.
- Focused package tests exercise the reference service, negative/adversarial cases, and Pact inventory.
- Pact files declare every service boundary used by the simulation.
- Domain-event-body and event-body-upcaster changes are absorbed without changing replay/live or projection behavior.
- GraphQL facade runtime changes are absorbed without changing materialization or read consistency behavior.

## What Is Mocked

- EventStore provider.
- Projection sink providers.
- Subscription gateway/Streamer provider.
- GraphQL facade transport.
- Search/embed providers.
- Governance/erasure provider.

No live external service, network call, credential, customer data, or production token is required.


Projection-consistency, change-feed, reactor, and reads-your-writes changes are absorbed without changing replay, materialization, or read-consistency behavior.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Data Plane Event Sourcing Cqrs Reactivity.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The `search-extension-packages-contract` and `snapshot-replay-divergence-contract` refreshes are absorbed without changing event-sourcing or replay evidence.
