# @hobo/swe-gemini

The Gemini SWE agent adapter (HOBO-723): Gemini's CLI speaks native ACP,
so this is the thinnest vendor adapter — stock protocol, no shims — and
the reference proof for the `@hobo/connector-acp` session engine.

- `sweGeminiConnector()` — `connector("swe-gemini", { protocol: "acp" })`
  resolves to this binding (workspace read/write, tasks.run,
  reports.read).
- `buildGeminiLaunch({ sandbox, credential })` — launch spec for
  `connectAcpAgentOverStdio`: `gemini --experimental-acp`, env scrubbed
  to the sandbox allowlist plus one brokered `GEMINI_API_KEY`.
- `runSweTask({ task, agent, principal })` — the standard governed
  SWE-task session: workspace mount, tool grants per the SWE guardrail
  posture, streamed edits as permission-gated tool calls, and a final
  report derived purely from the audit facts.
- `createGeminiTranscriptAgent(client)` — the golden-transcript replay
  agent (recorded Gemini session shape) for the credential-free lane.

## Lanes

- **Replay lane (default):** the golden transcript replays the full
  governed flow deterministically — no credentials, no network.
- **Live lane (credential-gated):** `HOBO_GEMINI_LIVE=1` +
  `GEMINI_API_KEY` (broker-minted) spawns the real binary under the
  sandbox posture via the connector's stdio lane.
