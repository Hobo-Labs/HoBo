# @hobo/swe-codex

The Codex SWE agent adapter (HOBO-724): the Codex SDK behind the
`@hobo/connector-acp` session engine via the vendor's own `codex-acp`
ACP bridge — no HoBo-side protocol shim.

- `sweCodexConnector()` — `connector("swe-codex", { protocol: "acp" })`
  resolves to this binding (workspace read/write, tests.run, tasks.run,
  reports.read).
- `buildCodexLaunch({ sandbox, credential })` — launch spec for
  `connectAcpAgentOverStdio`: `codex-acp`, env scrubbed to the
  sandbox allowlist plus one brokered `OPENAI_API_KEY`.
- `runSweTask({ task, agent, principal })` — the standard governed
  SWE-task session; returns the task report AND the sandbox access
  report, both derived purely from the audit facts.
- `createCodexTranscriptAgent(client)` — the golden-transcript replay
  agent (recorded fixture-repo run: read → edit → test → report).

## Lanes

- **Replay lane (default):** the golden transcript replays the full
  governed flow deterministically — no credentials, no network; the
  sandbox report asserts zero out-of-scope access.
- **Live lane (credential-gated):** `HOBO_CODEX_LIVE=1` +
  `OPENAI_API_KEY` (broker-minted) spawns the real bridge under the
  sandbox posture via the connector's stdio lane.
