Feature: Portability, Registry and Distribution reference slice
  The registry reference architecture moves certified listings from descriptor
  and discovery into install verification, deterministic resolution, yank
  response, mirror selection, and air-gap import — all without live registry
  services. Steps drive services/portability-registry-reference.ts.

  Scenario: Install a certified provider listing without selecting it automatically
    Given a certified provider Resource Pack listing in a curated registry catalog
    When the platform engineer installs it through the registry reference flow
    Then the registry artifact passes signature, catalog, and trust verification
    And the installed listing is available to Matching without automatic selection

  Scenario: Discover, resolve, and fetch only digest-identical artifacts
    Given a capability-indexed registry with registered artifact mirrors
    When the planning agent resolves a floating registry version range
    Then the registry resolver freezes a digest pin for the discovered listing
    And registry mirror cost selection runs only after digest identity verification

  Scenario: Yank a compromised listing while preserving running-set evidence
    Given a certified registry listing pinned by a running Deployment Set
    When SecOps yanks the registry listing as critical
    Then new deploy selection of the yanked registry listing is blocked
    And the running Set is flagged with a registry remediation obligation instead of a rewrite

  Scenario: Import a signed offline bundle without live registry egress
    Given a signed offline registry bundle with revocation and anti-rollback material
    When the sovereign operator imports the bundle into an in-boundary mirror
    Then accepted artifacts are recorded in a registry.BundleImported event without egress
    And revoked or rolled-back registry artifacts fail the import closed
