Feature: S1-10 conformance trust boundary
  The frozen @hobo/conformance suites draw the S1 trust boundary: five
  runtime-port durability checks (including checkout replay == live) plus
  component-host cross-host assertions with manifest host version pins.
  Seeded violations (broken-fence backend, drifted host) must fail closed.

  Scenario: Reference runtime backend passes the frozen durability suite
    Given the S1 trust-boundary runtime-local durability backend
    When the frozen runtime-port durability suite runs against the trust-boundary backend
    Then the trust-boundary durability report passes all five frozen checks
    And the trust-boundary durability report pins contract "hobo.runtime-port-conformance/v1"

  Scenario: Broken-fence backend is caught by the stale-fence check
    Given the S1 trust-boundary broken-fence runtime backend
    When the frozen runtime-port durability suite runs against the trust-boundary backend
    Then the trust-boundary durability report fails closed
    And the trust-boundary failure names check "actorHost.local.stale-fence-rejected"

  Scenario: Certified component hosts pass cross-host conformance
    Given the pinned component-host manifest and both certified host fixtures
    When the trust-boundary component-host conformance suite compares the certified hosts
    Then the cross-host trust-boundary report passes every membrane assertion
    And the trust-boundary report declares its non-covered divergences

  Scenario: Drifted host version is rejected before planning completes
    Given a runtime-local component host that drifted to version "wasmtime/45.0.0"
    When trust-boundary component-host planning checks the drifted host against the manifest pin
    Then trust-boundary planning fails closed with code "component_host.host-version-incompatible"
