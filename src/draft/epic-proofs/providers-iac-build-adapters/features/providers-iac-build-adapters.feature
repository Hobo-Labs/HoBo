Feature: Providers, IaC and Build Adapters reference slice
  The providers reference architecture registers provider-owned defaults with
  conformance evidence, realizes resources through mocked IaC and build
  adapters, contains malicious provider behavior, and proves multi-cloud
  portability of one unchanged shop Bindle. Steps drive
  services/providers-reference-architecture.ts over its committed fixture.

  Scenario: Register provider-owned defaults with conformance evidence
    Given the eight cloud provider adapter manifests in the providers fixture
    When the Yard registers the provider adapters into the capability catalog
    Then every registered provider adapter carries passing conformance evidence
    And provider adapter Matching rejects the unsupported require clause

  Scenario: Realize a Bindle resource without live providers
    Given a resolved ResourcePlan with mocked IaC, build, and driver adapter boundaries
    When the provider adapter emits IacProgram and BuildSpec fixtures
    Then the adapter pipeline previews, applies, refreshes, and returns outputs as bindings
    And the adapter realization records zero live provider calls

  Scenario: Reject malicious and drifting provider behavior
    Given a forged conformance report, undeclared egress, partial apply, and drift signal
    When the provider adapter conformance, sandbox, and refresh gates evaluate the evidence
    Then the malicious provider adapter is denied and contained without egress
    And provider adapter drift is recorded and rollback requires an orphan sweep

  Scenario: Run the same shop Bindle on AWS and Azure
    Given one unchanged shop Bindle source with provider-specific adapter mappings
    When the multi-cloud provider adapter gate compares topology, bindings, and portability
    Then the shop Bindle keeps identical topology and bindings across aws and azure
    And provider adapter option leaks and unsatisfied requires fail the portability gate
