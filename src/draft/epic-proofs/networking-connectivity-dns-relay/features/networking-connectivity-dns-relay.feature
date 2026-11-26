Feature: Networking, Connectivity, DNS and Relay reference slice
  The networking reference architecture proves secure cross-cloud binds,
  shadow-gated custom-domain promotion, outbound-only Relay execution, and
  tenant-aware ingress without live providers. Steps drive
  services/networking-reference-architecture.ts over its committed fixture.

  Scenario: Cross-provider bind stays private and policy-bounded
    Given an app API in an AWS Yard binding to a database in an Azure Yard
    When HoBo folds the Yard manifests and plans Junction connectivity
    Then the connectivity plan selects the tier 3 private interconnect under an allow policy gate
    And mirrored per-Yard Junction halves validate with mTLS intact

  Scenario: Custom-domain promotion is validation-first
    Given a custom domain fronting multiple Camps behind shadow DNS
    When HoBo stages DNS, validates evidence, issues certificates, and routes domain traffic
    Then only shadow DNS changes before the domain validation gate passes
    And rebinding and split-horizon evidence block unsafe domain promotion

# Narrowing note: the reference wrapper labels a third denied attempt
  # "relay.credential-egress.denied", but its fixture work carries only a
  # credentialRef (a reference, which the relay contract rightly allows), so
  # the underlying dispatch actually succeeds. This scenario therefore asserts
  # the two denials the code really produces (metadata target, forward proxy)
  # plus the contract's reference-only credential discipline on the dispatched
  # frames, instead of repeating the wrapper's mislabeled claim.
  Scenario: Relay cannot become an SSRF pivot
    Given a private target reachable only through the HoBo Relay
    When HoBo dispatches scoped work through the Relay session
    Then the Relay transport stays outbound-only and completes the scoped work
    And Relay metadata and forward-proxy attempts are denied with scoped reasons
    And Relay work frames carry credential references, never credential material

  Scenario: Tenant context resolves before ingress handlers
    Given subdomain, custom-domain, path, and JWT tenant routing signals
    When tenant-aware ingress routes an incoming request
    Then ctx.tenant is resolved from the routing table before the handler runs
    And mismatched tenant claims fail the ingress closed
