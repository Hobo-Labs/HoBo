# S2-03 cloud Yard shell contract (HOBO-618)

Independent draft POC for `@hobo/cloud` Yard shell: Gateway ingress (RPC +
REST), authn/z, commands→events, event store wiring against a mocked
`@hobo/runtime-postgres`, and a deployment timeline projection host.

Promotes the Yard-shell portions of
`src/draft/epic-proofs/control-plane-planner-matching-orchestrator/` without
importing unmerged production packages from HOBO-616/HOBO-617.

## BDD scenarios

```gherkin
Feature: Yard shell bootstrap

  Scenario: hobo yard up boots local Yard
    Given a mocked postgres event store
    When hobo yard up runs
    Then the Yard exposes Gateway, event store, and projection host
```

```gherkin
Feature: Gateway command ingress

  Scenario: Deploy command appends deployment.DeployRequested
    Given an authenticated principal with deploy scope
    When a Deploy command arrives via REST or RPC
    Then exactly one append-only event is recorded
```

```gherkin
Feature: Deployment timeline projection (NFR-008)

  Scenario: Timeline rebuild matches live projection
    Given deployment events in the append-only log
    When the projection host rebuilds from the log
    Then replay state equals live state
```

## Run

```bash
npm --prefix src/draft/technical-proofs/s2-03-cloud-yard-shell-hobo-618 test
```

## Deferred to production promotion

- Real `@hobo/runtime-postgres` durability (HOBO-617)
- Stage-2 acceptance record merge (HOBO-616)
- Production `packages/cloud/` layout and `hobo yard up` CLI wiring

## Architecture evidence

- `architecture/cloud_yard_shell.proto` + `.cue` — protobuf/CUE contract shapes
- `architecture/pacts/gateway_boundary.pact.json` — Gateway boundary PACT
- `ADR.md` — parse-don't-validate derived types and event-architecture evidence
