# Promoted from the README's prose gherkin blocks; every step drives
# services/generation-reference-architecture.ts (the epic's real simulation).
Feature: Generation pipeline, training, and AI safety
  Generated providers certify only after sandbox validation and safety gates,
  trained semantic functions promote only from trusted evidence, and live
  fixes to generated stacks stay human-gated with adversarial candidates
  denied or quarantined.

  Scenario: Generate and certify a database provider
    Given a target WIT port, capability manifest, sanitized material, and recorded traces
    When the generation loop scaffolds, fills, repairs, and certifies the candidate
    Then the artifact certifies only after sandbox validation and safety gates pass with zero sandbox egress

  Scenario: Promote a challenger from trusted training evidence
    Given OpenInference trajectories with privacy filtering and poisoning checks
    When the built-in OPTO training engine proposes a region-scoped candidate
    Then the challenger promotes only after live-eval, poisoning, and privacy gates pass

  Scenario: Retain gates for risky generated changes and adversarial candidates
    Given a drifted generated stack with a candidate live fix and adversarial training inputs
    When the live-fix flow and negative-path screens evaluate the candidates
    Then risky live fixes require human approval, malicious candidates are denied, and poisoned training quarantines
