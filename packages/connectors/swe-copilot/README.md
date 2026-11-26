# @hobo/swe-copilot

The Copilot SWE agent adapter (HOBO-725): the Copilot SDK/CLI behind the
`@hobo/connector-acp` session engine via the vendor's own `copilot`
ACP bridge — no HoBo-side protocol shim.

- `sweCopilotConnector()` — `connector("swe-copilot", { protocol: "acp" })`
  resolves to this binding (workspace read/write, tests.run, tasks.run,
  reports.read).
- `buildCopilotLaunch({ sandbox, credential })` — launch spec for
  `connectAcpAgentOverStdio`: `copilot`, env scrubbed to the
  sandbox allowlist plus one brokered `GH_TOKEN`.
- `runSweTask({ task, agent, principal })` — the standard governed
  SWE-task session; returns the task report AND the sandbox access
  report, both derived purely from the audit facts.
- `createCopilotTranscriptAgent(client)` — the golden-transcript replay
  agent (recorded fixture-repo run: read → edit → test → report).

## Lanes

- **Replay lane (default):** the golden transcript replays the full
  governed flow deterministically — no credentials, no network; the
  sandbox report asserts zero out-of-scope access.
- **Live lane (credential-gated):** `HOBO_COPILOT_LIVE=1` +
  `GH_TOKEN` (broker-minted) spawns the real bridge under the
  sandbox posture via the connector's stdio lane.
