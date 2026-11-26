Feature: S5 stage gate — Forge and extensibility
  The Stage-5 gate drill composes generation, registry, eval-promotion, and
  live-fix contracts: hobo forge certifies a generated provider into a signed
  Registry listing, the forged provider deploys a Bindle, a stub semantic
  implementation promotes through the eval gate, and a gated live-fix
  auto-rolls back while retaining the failing trace.

  Scenario: hobo forge yields a signed Registry listing
    Given the S5 forge drill against the no-egress reference backend
    When hobo forge certifies the generated provider
    Then the forged provider passes per-interface conformance and trace replay
    And the Registry records gen.PluginCertified and lists the forged provider without auto-selection
    And tampered or unsigned forged artifacts fail install verification

  Scenario: Forged provider deploys a Bindle resource end-to-end
    Given a certified forged provider installed from the Registry
    When the engineer deploys a Bindle claiming the forged provider capability
    Then the forged-provider Bindle resource reaches ready with the provider digest pinned

  Scenario: Stub port implementation promotes through the eval gate
    Given recorded stub traces and a conformance-green forge candidate
    When the S5 eval promotion gate evaluates the stub challenger
    Then the stub challenger promotes through conformance, eval, and policy lenses

  Scenario: Gated live-fix auto-rolls back and retains the failing trace
    Given a staging SLO incident and a low-risk generated fix candidate
    When the S5 canary observes an SLO regression
    Then the live-fix deployment rolls back and retains the failing trace as a regression test
    And a high-risk production live-fix candidate is held for human approval
