Feature: Hosted provider parity with RelayRunner
  Hosted runner providers are named in the runner order by their own labels.
  One scenario per gauntlet case; the case catalog is cases.json beside
  this file. A scenario tagged @pending waits for the work package that
  builds it.

  @parity @P01 @t1
  Scenario: P01 Seven hosted providers are routable by label, and a label must be the provider's own
    Then the hosted providers a runner order can name are:
      | provider  |
      | blacksmith |
      | depot     |
      | namespace |
      | warpbuild |
      | ubicloud  |
      | boat      |
      | runs-on   |
    Given the runner order of "octo/app" is "depot, github"
    And a relay job for "octo/app" names these runner types:
      | type   | labels       |
      | depot  | ubuntu-24.04 |
      | github | ubuntu-24.04 |
    When the relay answers the relay job
    Then the relay job succeeds on "ubuntu-24.04" from the "github" step
    And the journaled decision passed over "depot" because "not_provider_label"

  @parity @P02 @t2 @pending
  Scenario: P02 Real usage is synced from Depot, Namespace and WarpBuild with read-only tokens
    Given read-only usage tokens for depot, namespace and warpbuild
    When provider usage is synced from the simulated provider APIs
    Then this month's spend per provider is in the ledger

  @parity @P03 @t1
  Scenario Outline: P03 Reports recognise a provider from its labels
    Then the label "<label>" is recognised as "<provider>"

    Examples:
      | label                     | provider   |
      | depot-ubuntu-24.04        | depot      |
      | blacksmith-4vcpu-ubuntu-2404 | blacksmith |
      | ubuntu-24.04              | github     |
      | my-own-runner             | none       |

  @parity @P04 @t1 @pending
  Scenario: P04 Every routable provider has dated list prices per size
    Then every hosted provider in the runner order has a financial model
    And each price names its source page and the day it was read
