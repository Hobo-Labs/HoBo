Feature: User notices nothing when the backend swaps under budget pressure
  End users of a deployed service keep getting responses while the platform,
  reacting to a budget threshold crossing, dispatches a cheaper backend and
  executes a progressive health-gated cutover. The swap is transparent: zero
  failed requests, and a rollback on mid-ramp regression is equally invisible.

  Scenario: Budget-pressured swap completes with zero failed requests
    Given two live backends behind a routing proxy with the incumbent serving all traffic
    And a continuous request stream against the proxy
    When a budget threshold crossing reaches the routing control loop
    Then the control loop reapplies routing onto the cheaper backend
    And no request observed a failure during the swap
    And the fact trace follows the domain cutover saga ladder
    And every request after the cutover is served by the new backend

  Scenario: Mid-ramp health regression rolls back invisibly
    Given two live backends behind a routing proxy with the incumbent serving all traffic
    And a continuous request stream against the proxy
    And the target backend will fail its health gate at fifty percent
    When a budget threshold crossing reaches the routing control loop
    Then the control loop rolls back to the incumbent backend
    And no request observed a failure during the swap
    And every request after the rollback is served by the incumbent backend
