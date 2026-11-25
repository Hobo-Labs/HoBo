Feature: Surface parity with RelayRunner
  The CLI, MCP tools, read API, dashboard and setup aids people and agents
  use. One scenario per gauntlet case; the case catalog is cases.json beside
  this file. A scenario tagged @pending waits for the work package that
  builds it.

  @parity @S01 @t2
  Scenario: S01 A read-only dashboard with Runners, Router, History, Performance and Signals
    Given a relay with stored routes, machines and runs
    When the dashboard is opened
    Then it shows the Runners, Router, History, Performance and Signals views
    And none of them changes anything

  @parity @S02 @t1
  Scenario: S02 The CLI reads well for people, has --json for agents and is safe to retry
    When "hobo ci route --github ubuntu-24.04" runs twice in a checkout with no runner order
    Then both runs give the same answer
    And the answer is a sentence for people and data for --json

  @parity @S03 @t1 @pending
  Scenario: S03 init plans and applies workflow changes, never commits, and only sets runs-on
    Given a repository with one workflow
    When "hobo ci init --apply all" runs
    Then each moved job's runs-on is a HoBo label and no job is added
    And it makes no commit

  @parity @S04 @t2 @pending
  Scenario: S04 The MCP server has tools for the order, a route explanation, activity, signals, job times and failures
    When the relay's MCP tools are listed
    Then they include get_runner_order, explain_route, list_route_decisions, get_signals, get_job_times and get_run_failures

  @parity @S05 @t1 @pending
  Scenario: S05 Three agent skills and a one-prompt setup guide
    Then the repository ships three hobo ci skills
    And one setup guide an agent can follow from a single prompt

  @parity @S06 @t2 @pending
  Scenario: S06 A read API with an OpenAPI description
    When each read API path is called with a read token
    Then every response matches the OpenAPI description

  @parity @S07 @t1 @pending
  Scenario: S07 One generated page lists every error code
    Then every HOBO_CI error code appears once on the generated error page

  @parity @S08 @met-differently
  Scenario: S08 Workspaces and roles are met by accounts and scoped tokens
    Given HoBo has no human roles
    Then access is GitHub membership plus scoped tokens

  @parity @S09 @t1 @pending
  Scenario: S09 A clean way to remove it
    Given a repository set up by "hobo ci init --apply all"
    When each moved job's label is restored from its "# was" comment
    Then the repository's workflows are as they were before

  @parity @S10 @t2
  Scenario: S10 A routing change is a reviewed commit, and the dashboard's edit opens a pull request
    Given the dashboard's Router view
    When an edit to the runner order is saved
    Then a pull request changing ".hobo/ci.json" is opened and nothing changes until it merges
