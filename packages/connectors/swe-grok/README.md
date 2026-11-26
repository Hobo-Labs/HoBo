# @hobo/swe-grok

The Grok SWE agent adapter (HOBO-727): the xAI Grok SDK behind the
`@hobo/connector-acp` session engine via the vendor's own `grok-acp`
ACP bridge — no HoBo-side protocol shim.

- `sweGrokConnector()` — `connector("swe-grok", { protocol: "acp" })`
  resolves to this binding (workspace read/write, tests.run, tasks.run,
  reports.read).
- `buildGrokLaunch({ sandbox, credential })` — launch spec for
  `connectAcpAgentOverStdio`: `grok-acp`, env scrubbed to the
  sandbox allowlist plus one brokered `XAI_API_KEY`.
- `runSweTask({ task, agent, principal })` — the standard governed
  SWE-task session; returns the task report AND the sandbox access
  report, both derived purely from the audit facts.
- `createGrokTranscriptAgent(client)` — the golden-transcript replay
  agent (recorded fixture-repo run: read → edit → test → report).

## Lanes

- **Replay lane (default):** the golden transcript replays the full
  governed flow deterministically — no credentials, no network; the
  sandbox report asserts zero out-of-scope access.
- **Live lane (credential-gated):** `HOBO_GROK_LIVE=1` +
  `XAI_API_KEY` (broker-minted) spawns the real bridge under the
  sandbox posture via the connector's stdio lane.
