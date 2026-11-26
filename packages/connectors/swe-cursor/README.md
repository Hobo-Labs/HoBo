# @hobo/swe-cursor

The Cursor SWE agent adapter (HOBO-726): the Cursor SDK / cursor-agent behind the
`@hobo/connector-acp` session engine via the vendor's own `cursor-agent-acp`
ACP bridge — no HoBo-side protocol shim.

- `sweCursorConnector()` — `connector("swe-cursor", { protocol: "acp" })`
  resolves to this binding (workspace read/write, tests.run, tasks.run,
  reports.read).
- `buildCursorLaunch({ sandbox, credential })` — launch spec for
  `connectAcpAgentOverStdio`: `cursor-agent-acp`, env scrubbed to the
  sandbox allowlist plus one brokered `CURSOR_API_KEY`.
- `runSweTask({ task, agent, principal })` — the standard governed
  SWE-task session; returns the task report AND the sandbox access
  report, both derived purely from the audit facts.
- `createCursorTranscriptAgent(client)` — the golden-transcript replay
  agent (recorded fixture-repo run: read → edit → test → report).

## Lanes

- **Replay lane (default):** the golden transcript replays the full
  governed flow deterministically — no credentials, no network; the
  sandbox report asserts zero out-of-scope access.
- **Live lane (credential-gated):** `HOBO_CURSOR_LIVE=1` +
  `CURSOR_API_KEY` (broker-minted) spawns the real bridge under the
  sandbox posture via the connector's stdio lane.
