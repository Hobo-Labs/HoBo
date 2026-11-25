# @hobo/swe-gemini — Architecture Evidence

The Gemini SWE agent adapter (HOBO-723): the native-ACP reference proof
that the HOBO-721 connector speaks STOCK ACP with zero vendor shims.
Gemini's CLI ships native ACP (`gemini --experimental-acp` is an ACP
server on stdio), so this adapter is launch + credential posture + the
standard SWE-task session shape — no protocol translation anywhere.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): the launch
  spec, the golden-transcript step, the SWE task and the report.
- CUE constraints in `data-models/swe_gemini.cue` bound every protobuf
  message (`command` pinned to `gemini`, `args` to
  `["--experimental-acp"]`, `credentialEnv` to `GEMINI_API_KEY`, report
  schema + stop reasons pinned).
- PACT boundary evidence lives under [`contracts/`](./contracts): the
  stock handshake (protocol version echoed untouched), the governed SWE
  task and the brokered launch posture — asserted against the recorded
  interactions in the replay-lane tests.

## Parse, don't validate

The report is a derived parsed type produced by `extractSweTaskReport`
from the session facts; the guardrail policy and sandbox posture reuse
the HOBO-721 parse boundaries (`parseAgentGuardrailPolicy`,
`parseSandboxPosture`) — callers receive derived types, and the launch
spec injects the brokered credential explicitly rather than trusting
ambient env.

## Stock ACP (the point of this adapter)

The transcript agent echoes the connector's negotiated protocol version
untouched, and the conformance test fails if any adapter-side patching
changes the handshake. Deviations found against the real binary are
documented as connector conformance findings, never patched in the
adapter.

## Governed SWE-task shape

`runSweTask` mounts the workspace, applies the SWE-task guardrail
posture (reads/edits auto-allow — that is the job; deploys
require-approval; destroy/token/admin deny) and runs the prompt turn
through the shared governed session engine. Streamed edits arrive as
permission-gated tool calls; refusals are structured and visible.

## Event architecture

The adapter holds no state: every command's outcome lands as the
HOBO-721 past-tense facts (`connector.SessionOpened` …
`connector.SessionClosed`) appended by the caller's single-writer actor
to the event store, and the SWE-task report is a projection /
materialized view over those facts (`extractSweTaskReport` replays the
log — a snapshot re-derivable at any seq). Read stores rebuild from the
log; the golden-transcript replay lane proves the identical fact
sequence deterministically.

## Credentials

Brokered only (HOBO-110): the Yard broker holds the Gemini vendor
relationship and mints short-lived credentials per session; the launch
env is sandbox-scrubbed plus exactly one injected key. Missing
credentials gate with the typed `GEMINI_CREDENTIALS_MISSING` failure;
the live lane is opt-in (`HOBO_GEMINI_LIVE=1`).
