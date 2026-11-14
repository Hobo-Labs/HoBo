@hobo-cd
Feature: HoBo.CD conformance, matrices and chaos
  As an adapter author or platform operator
  I want every CD port, matrix and fault proven by a named, offline suite
  So that any implementation that passes is safe to bind, and any that breaks a property is caught

  Scenario Outline: the <suite> suite passes its reference adapter
    When the "<suite>" conformance suite runs against its reference adapter
    Then every assertion passes

    Examples:
      | suite                |
      | Realizer             |
      | TrafficShifter       |
      | HealthSource         |
      | PublisherPort        |
      | ReconcilerTransport  |
      | ArtifactStore        |
      | ArtifactVerifier     |
      | ProvenanceVerifier   |
      | SubscriptionDriver   |
      | PlacementEngine      |
      | FanoutController     |
      | PostureEvaluator     |
      | CampInventory        |

  Scenario Outline: the <suite> suite catches a broken adapter
    When the "<suite>" conformance suite runs against the "<mutant>" mutant
    Then assertion "<assertion>" fails

    Examples:
      | suite               | mutant                 | assertion                                  |
      | Realizer            | trusts-provider        | providerSuccessWithoutEffectIsNotConverged |
      | ReconcilerTransport | no-fencing             | staleFenceIsRefused                        |
      | HealthSource        | fabricates-on-empty    | noDataIsNeverFabricated                    |
      | PlacementEngine     | order-sensitive        | permutationDeterminism                     |
      | PlacementEngine     | claims-grant           | claimsNeverGrantResidency                  |
      | FanoutController    | defer-as-failure       | deferredAreNotFailures                     |
      | CampInventory       | agent-no-run           | agentSelfReportNeverAddsNoRun              |

  Scenario: same Freight via seven ingress paths
    When one build arrives through OCI polling, Git polling, GitHub OIDC push, GitLab OIDC push, an in-toto attestation, a CDEvent nudge and HoBo CI
    Then every path yields the same Freight id
    And a CDEvent payload alone creates no Freight

  Scenario: platform matrix
    When one Freight is delivered across every traffic rung and none, every artifact kind, a built-in and a WASM-component resolver
    Then every cell converges with the Freight's digests or refuses as "progressive-unsupported"

  Scenario: air-gapped Yard, egress disabled
    When an air-gapped Yard promotes through a local source and an agent
    Then the Camp converges with no egress beyond the Yard
    And the Station never dials the agent

  Scenario: journal replay of a full pipeline run
    When a full pipeline run is replayed from its journal
    Then the replayed state is identical to the live state

  Scenario Outline: chaos fault <fault> never ends wedged
    When chaos fault "<fault>" is injected, held and healed
    Then its invariants hold throughout and the system converges

    Examples:
      | fault                          |
      | reconciler-killed-mid-converge |
      | agent-partitioned              |
      | store-failover                 |
      | source-registry-outage         |
      | agent-flapping-conditions      |
      | mass-lease-loss                |
