@optimizexp @ux @dx @persona:jony-ive @interface:cli
Feature: Designer council consensus (Jony Ive)
  As the coherence-engineer review lens
  I want disagreements to remain evidence-bound and finite
  So that resolved preferences yield without concealing objective blockers

  Background:
    Given persona "jony-ive" is active
    And feature "designer-council-consensus" is under optimizexp review

  Scenario: A relevant designer argues before yielding
    Given a proposal is central to Jony Ive's coherence doctrine
    And current-head evidence supports the concern
    When the council advances through speaking turns
    Then Jony Ive may reply while investment is above zero
    And investment decays monotonically
    And subjective preferences yield at zero

  Scenario: A new commit invalidates prior consensus
    Given the council unanimously approved one head SHA
    When the PR head changes
    Then assert-yay fails
    And the council must reconvene
