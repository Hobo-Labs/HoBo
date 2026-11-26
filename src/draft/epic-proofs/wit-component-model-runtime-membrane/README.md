# WIT & Component-Model Runtime Membrane Reference Implementation

This reference implementation rolls the WIT & Component-Model Runtime epic into one runnable, mocked architecture slice. It is not production runtime code. It shows how WIT pins, component-host selection, wRPC links, runtime ports, capability grants, websocket fan-out, conformance reports, and host upgrades compose without live external services.

## BDD Scenarios

```gherkin
Feature: WIT runtime membrane

  Persona: App developer
  Scenario: Runtime-local checkout flow records durable effects
    Given a Bindle imports pinned WIT runtime and capability ports
    When the runtime-local Camp executes the checkout workflow
    Then EventStore, ActorHost, Queue/Clock, and Streamer effects are recorded durably with no Yard data-path call

  Persona: Platform operator
  Scenario: Cross-host membrane refuses unsafe links before provider calls
    Given caller and provider components negotiate WIT and wRPC versions
    When the link floor, deadline, or backpressure contract is violated
    Then the membrane returns typed failures before the provider is trusted

  Persona: SDK maintainer
  Scenario: SDK parity and websocket fan-out stay deny-by-default
    Given a generated idiom layer and a websocket extension over Streamer
    When parity, grants, or tenant membership drift
    Then the conformance suite and capability gate refuse ambient access

  Persona: Runtime operator
  Scenario: Host upgrades require conformance and upcaster evidence
    Given a component-host manifest pin and a candidate host adapter
    When the operator upgrades the Camp host
    Then the upgrade is blocked until conformance and upcaster evidence pass
```

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src\draft\epic-proofs\wit-component-model-runtime-membrane run simulate
```

What this proves:

- runtime-local durable workflow effects stay inside mocked Camp runtime boundaries;
- cross-host wRPC links negotiate and fail closed before calls;
- SDK parity and websocket fan-out remain deny-by-default;
- host upgrades require conformance and upcaster evidence.
- The validated capability-enforcement proof is included in this rollup; its simulation contract is unchanged.
- The wRPC + WIT API proof's boundary-type hardening is included in this rollup; its simulation contract is unchanged.

Mocked boundaries and contracts are listed in [contracts/pact-inventory.md](contracts/pact-inventory.md).


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Wit Component Model Runtime Membrane.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The runtime-port, component-host, streamer, websocket, wire-version, and WRPC transport/membrane technical proof refreshes are absorbed without changing the component-model boundary evidence.
