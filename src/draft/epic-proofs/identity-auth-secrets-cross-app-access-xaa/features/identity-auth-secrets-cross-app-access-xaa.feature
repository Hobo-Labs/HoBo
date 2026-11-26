Feature: Identity, Auth, Secrets and Cross-App Access (XAA) reference slice
  The identity reference architecture issues keyless workload credentials,
  verifies end-user auth with secretless configuration, delegates Cross-App
  Access through governed ID-JAG exchange, and keeps the identity control
  planes recoverable and observable. Steps drive
  services/identity-reference-architecture.ts against the committed
  identity-xaa-scenarios fixture.

  Scenario: Exchange an attested workload SVID for a provider token
    Given a host-signed workload attestation with least-privilege XAA scope
    When Identity issues a JWT-SVID and the XAA broker exchanges it through OIDC federation
    Then the brokered provider token is short-lived and narrowed to the requested action
    And SVID renewal outside the signed grace window is denied

  Scenario: Verify ctx.user and resolve secretless configuration
    Given a hobo:auth consumer contract with trusted JWKS and Camp config references
    When an identity request verifies a token and resolves config through the secretless ladder
    Then ctx.user resolves the delegated principal without plaintext persistence
    And wrong-issuer tokens and revoked identity sessions fail closed

  Scenario: Mint outbound and verify inbound XAA credentials
    Given a verified delegated user and an inferred XAA connector scope
    When the XAA broker mints an audience-bound ID-JAG and the target redeems it
    Then the ID-JAG carries only the delegated user-to-agent-to-app chain
    And XAA replay and confused-deputy attempts are rejected

  Scenario: Keep identity control planes available without widening trust
    Given a genesis issuer with an offline break-glass key and OCSF exporter
    When identity recovery paths rotate, fail over, or override
    Then every identity override is audited and bounded by signed trust
    And SIEM receives redacted OCSF identity evidence
