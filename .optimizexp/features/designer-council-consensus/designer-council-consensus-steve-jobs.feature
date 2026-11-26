@optimizexp @ux @dx @ax @persona:steve-jobs @interface:cli
Feature: Designer council consensus (Steve Jobs)
  As the product-editor review lens
  I want approval to bind the integrated proposal actually being shipped
  So that compromise or stale evidence cannot masquerade as consensus

  Background:
    Given persona "steve-jobs" is active
    And feature "designer-council-consensus" is under optimizexp review

  Scenario: One nay returns work for improvement
    Given five designers vote yay
    And one designer has an unresolved evidence-backed blocker and votes nay
    When the coordinator decides the council
    Then the result is nay
    And a rework packet is appended to the agent bus
    And the PR is not merge eligible

  Scenario: Unanimous current-head yay permits closeout
    Given all six canonical designers vote yay
    And no hard blocker remains
    And every vote matches the current head and proposal digest
    When the coordinator asserts consensus
    Then assert-yay exits zero
    And SDLC closeout may proceed
