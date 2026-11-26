Feature: Stage-6 governance planes evidence rollup
  The Stage-6 governance reference architecture proves the four HOBO-663
  evidence items end to end: consent-gated notify, residency enforcement with
  crypto-shred erasure, guardrail-blocked model output, and certified-only
  Registry install via Matching. Steps drive
  services/governance-planes-reference-architecture.ts against its committed
  suite fixture.

  Scenario: Consent-gated notify send through hobo:notify
    Given a Stage-6 notify recipient with granted product-notification consent
    When the yard dispatches a Stage-6 notify send through hobo:notify
    Then Stage-6 notification.Requested is appended with the consent reference
    And Stage-6 notification.Delivered records the notify outcome

  Scenario: Residency obligation with crypto-shred erasure
    Given Stage-6 phi-classified data constrained to us-east-1
    When a Stage-6 deploy plan targets eu-central-1
    Then Stage-6 can-deploy denies with a residency violation
    And Stage-6 hobo erase crypto-shreds the subject key without rewriting history

  Scenario: Guardrail blocks flagged model output
    Given a Stage-6 agent output that fails the PII guardrail rail
    When the enforced Stage-6 guardrail step evaluates the buffered window
    Then the Stage-6 guardrail decision blocks the output with a deny policy decision

  Scenario: Certified-only Registry install via Matching
    Given a Stage-6 certified listing and a failed-certification listing
    When Stage-6 Matching discovers providers for a WIT port
    Then only the Stage-6 certified listing can install
    And the Stage-6 evidence rollup reports all four items green
