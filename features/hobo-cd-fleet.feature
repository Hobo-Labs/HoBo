@hobo-cd
Feature: HoBo.CD fleet and policy journeys
  As a platform team running many Camps under Rails
  I want placement, fan-out, failover and Rail rollout to be bounded and governed
  So that a release or a policy change never hits the whole fleet at once and never violates residency

  Scenario: retail edge fleet of 400 Camps
    Given a retail edge fleet of 400 Camps across 4 regions
    And 3 stores are offline
    When Freight "pos@2.0.0" fans out with a mandatory pilot group of 8 and concurrency 40
    Then the fan-out completes
    And no more than 40 Camps were ever in flight
    And the pilot group finished before any other store started
    And the 3 offline stores are deferred, not failed
    When the offline stores recover
    Then they catch up to "pos@2.0.0"

  Scenario: regional failover across providers
    Given Camps "eu-aws-1" on aws eu-west, "eu-gcp-1" on gcp eu-west and "us-aws-1" on aws us-east
    And the workload runs on "eu-aws-1" under EU residency
    And the Rail permits automatic failover with max_concurrent 1
    When the reconciler alone reports "eu-aws-1" unreachable
    Then no failover is proposed
    When the Station and a health source both observe "eu-aws-1" down
    Then one failover from "eu-aws-1" to "eu-gcp-1" runs
    And the source is kept until the replacement qualifies
    When the replacement qualifies
    Then traffic shifts and the source is purged
    When "eu-aws-1" recovers
    Then nothing fails back automatically

  Scenario: failover refused when the data lives in the failing Camp
    Given Camps "eu-aws-1" on aws eu-west, "eu-gcp-1" on gcp eu-west and "us-aws-1" on aws us-east
    And the workload and its database run on "eu-aws-1" under EU residency
    And the Rail permits automatic failover with max_concurrent 1
    When an operator taints "eu-aws-1" NO_RUN
    Then the failover is refused as "failover-unsafe" naming a Trails handover

  Scenario: Rail inform → enforce
    Given Camps enforce Rail "rail-v1" which allows public buckets
    And Rail "rail-v2" which denies public buckets is bound INFORM
    When a Delta creating a public bucket reaches the gate
    Then "rail-v1" decides and the Delta is allowed
    And a shadow divergence is recorded for "rail-v2"
    When "rail-v2" is promoted to ENFORCE before its INFORM node qualifies
    Then the promotion is refused with "rail-inform-unqualified"
    When the INFORM node verifies with 1 percent noncompliant and 1 declared divergence
    And "rail-v2" is promoted to ENFORCE
    Then "rail-v2" is the enforced Rail
    And a Delta creating a public bucket is denied

  Scenario: brownfield ClusterProfile import to managed
    Given 3 Camps imported from ClusterProfiles
    Then they are OBSERVE_ONLY and placement excludes them
    And reconciling them only observes and never applies
    When an operator promotes "cp-2" to MANAGED
    Then placement includes "cp-2" only
