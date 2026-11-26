Feature: WIT component-model runtime membrane
  WIT pins, component-host selection, wRPC links, runtime ports, capability
  grants, websocket fan-out, and host upgrades compose into one membrane
  that records durable effects locally and fails closed at every crossing.

  Scenario: Runtime-local checkout records durable effects
    Given a Bindle importing pinned WIT runtime and capability ports
    When the runtime-local Camp executes the checkout membrane scenario
    Then EventStore, ActorHost, Queue, and Streamer membrane effects are recorded durably
    And the membrane scenario makes no Yard data-path call

  Scenario: Cross-host membrane refuses unsafe links before provider calls
    Given caller and provider components negotiating WIT and wRPC versions
    When the cross-host membrane scenario exercises the link floor, deadline, and backpressure
    Then the membrane returns typed link failures before the provider is trusted
    And the cross-host link recovers only through the lattice's linked-only route

  Scenario: SDK parity and websocket fan-out stay deny-by-default
    Given a generated SDK idiom layer and a websocket extension over Streamer
    When the SDK conformance membrane scenario runs with drifted grants
    Then the membrane denies the missing capability grant and fails the semantics annex vector

  Scenario: Host upgrades require conformance and upcaster evidence
    Given a component-host manifest pin and a candidate host adapter
    When the membrane host-upgrade gate evaluates the candidate
    Then the upgrade is blocked until upcaster evidence passes and the manifest is repinned
    And every membrane pact boundary stays consumer-tested
