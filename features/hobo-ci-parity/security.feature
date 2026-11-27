Feature: Security parity with RelayRunner
  What the relay may see and do. One scenario per gauntlet case; the case
  catalog is cases.json beside this file. A scenario tagged @pending waits
  for the work package that builds it.

  @parity @X01 @t2
  Scenario: X01 The answerer requests no log, secret or repository content
    Given relay mode is on for "octo/app"
    When the relay answers a relay job
    Then the simulator saw no request for a log, a secret or repository content

  @parity @X02 @t1
  Scenario: X02 Webhooks are signature-checked
    Given a webhook body signed with the relay's secret
    Then the signature check accepts it
    And it refuses another secret's signature, a changed body and a missing signature

  @parity @X03 @t2
  Scenario: X03 The relay never runs code from the job
    Given relay mode is on for "octo/app"
    And a relay job with a step that would run a script
    When the relay answers it
    Then the relay started no process

  @parity @X04 @t2
  Scenario: X04 The new MCP tools need only the read scope
    Given a token with only the read scope
    Then every new MCP tool answers it
    And no MCP tool changes anything
