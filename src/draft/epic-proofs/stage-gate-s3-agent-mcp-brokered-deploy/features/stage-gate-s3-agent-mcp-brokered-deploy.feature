Feature: S3 stage gate — agent MCP brokered deploy
  Atlas, an AI agent, deploys examples/hello-bindle on the S2 sandbox through
  an SVID-bound MCP session using only brokered short-lived tokens: the J2
  tool journey succeeds, the token audit trail replays, NFR-017 failures
  self-correct, and agent guardrails hold the ceiling.

  Scenario: J2 journey completes with brokered tokens only
    Given the SVID-bound MCP drill session scoped by the agent's allow ceiling
    When Atlas runs the J2 tool journey against hello-bindle on the S2 sandbox
    Then every J2 journey tool call succeeds and the deploy self-corrects to done
    And only brokered short-lived credentials appear in the drill trace

  Scenario: Brokered token audit trail is replayable
    Given the completed J2 brokered-token drill trace
    When the brokered-token event store is replayed
    Then token.Granted and token.Used events are present and the replay carries a digest

  Scenario: NFR-017 deploy failure self-corrects via machine-readable remediation
    Given a hello-bindle deploy gated behind a missing digest pin
    When the first brokered deploy fails with an NFR-017 explainable error
    Then the machine-readable remediation drives verify then redeploy to success

  Scenario: Agent guardrails hold the allow ceiling
    Given the completed J2 brokered-token drill trace
    When Atlas requests a token outside the allow ceiling and a high-risk prod deploy
    Then the over-broad token request is refused with code "MCP_SCOPE_DENIED"
    And the prod deploy blocks until a human approves
    And a static cloud key offered to the drill is rejected
