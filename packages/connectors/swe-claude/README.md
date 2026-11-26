# @hobo/swe-claude

The Claude SWE agent adapter (HOBO-722): the Claude Agent SDK behind the
`@hobo/connector-acp` session engine via the vendor's own `claude-code-acp`
ACP bridge — no HoBo-side protocol shim.

- `sweClaudeConnector()` — `connector("swe-claude", { protocol: "acp" })`
  resolves to this binding (workspace read/write, tests.run, tasks.run,
  reports.read).
- `buildClaudeLaunch({ sandbox, credential })` — launch spec for
  `connectAcpAgentOverStdio`: `claude-code-acp`, env scrubbed to the
  sandbox allowlist plus one brokered `ANTHROPIC_API_KEY`.
- `runSweTask({ task, agent, principal })` — the standard governed
  SWE-task session; returns the task report AND the sandbox access
  report, both derived purely from the audit facts.
- `createClaudeTranscriptAgent(client)` — the golden-transcript replay
  agent (recorded fixture-repo run: read → edit → test → report).

## Lanes

- **Replay lane (default):** the golden transcript replays the full
  governed flow deterministically — no credentials, no network; the
  sandbox report asserts zero out-of-scope access.
- **Live lane (credential-gated):** `HOBO_CLAUDE_LIVE=1` +
  `ANTHROPIC_API_KEY` (broker-minted) spawns the real bridge under the
  sandbox posture via the connector's stdio lane.
