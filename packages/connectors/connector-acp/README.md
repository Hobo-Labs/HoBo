# @hobo/connector-acp

The production ACP protocol connector (HOBO-721): governed agent sessions
with SVID-bound identity, fail-closed policy decisions, sandbox posture and
a replayable audit stream. HoBo owns no agent SDK — this connector is how
external agent runtimes (Claude, Gemini, Codex, Copilot, Cursor, Grok — the
M4 vendor adapters) integrate.

## Surface

- `acpConnector(name, { operations })` — declare the connector;
  `lowerAcpConnector(binding, observedOperations)` lowers it to the
  manifest external-dependency entry with usage-inferred `allow` scopes
  (`via: "xaa"`, `onBehalfOf: "user"`).
- `openGovernedSession({ connector, agent, principal, policy, onFact })` —
  initialize + session/new + governed prompt turns: streamed updates,
  tool-permission requests decided by the guardrail policy (deny-ceiling,
  fail closed; denials are structured refusals the agent sees),
  cancellation with the ACP `cancelled` outcome.
- `replaySessionFacts(facts)` — rebuild the session purely from the log.
- `connectAcpAgentOverStdio({ command, sandbox, client })` — spawn a vendor
  agent binary under the parse-enforced sandbox posture and speak real ACP
  over `@agentclientprotocol/sdk`.
- `createFixtureAcpAgent(client)` — the in-process conformance fixture.

## Guarantees

- **Identity:** agent principal = brokered connector token bound to an
  SPIFFE SVID, delegated by a user; scope requests can only narrow the
  manifest allow.
- **Policy:** s3-07 action classes; `require-approval` without a recorded
  allowed approver resolves to deny; nothing fails open.
- **Sandbox:** `ambientCredentials: false` parse-enforced; env scrubbed to
  the allowlist; workspace-scoped filesystem; allowlisted network.
- **Audit:** every turn/grant/refusal/result is a past-tense fact; the
  session replays from the log.
- **No public `agent()`** — the negative conformance vector asserts it.
