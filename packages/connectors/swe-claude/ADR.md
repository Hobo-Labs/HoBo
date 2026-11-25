# @hobo/swe-claude — Architecture Evidence

The Claude SWE agent adapter (HOBO-722): the Claude Agent SDK behind the
HOBO-721 ACP connector via the VENDOR'S OWN bridge (`claude-code-acp`, a
stock ACP server on stdio over the Claude Agent SDK). HoBo owns identity,
policy, sandbox and audit; the Claude runtime owns planning and tool
orchestration. No HoBo-side protocol shim exists — this package is launch
+ credential posture + the standard SWE-task session shape.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): the bridge
  launch spec, the golden-transcript step, the SWE task, the report and
  the sandbox access report.
- CUE constraints in `data-models/swe_claude.cue` bound every protobuf
  message (`command` pinned to `claude-code-acp`, `credentialEnv` to
  `ANTHROPIC_API_KEY`, report schemas and stop reasons pinned).
- PACT boundary evidence lives under [`contracts/`](./contracts): the
  governed fixture-repo task (edit + test), the structured refusal for a
  denied capability and the brokered launch posture — asserted against
  the recorded interactions in the replay-lane tests.

## Parse, don't validate

Reports are derived parsed types produced from the audit facts
(`extractSweTaskReport`, `buildSandboxAccessReport`); the guardrail
policy and sandbox posture reuse the HOBO-721 parse boundaries. Callers
receive derived types; the launch spec injects the brokered credential
explicitly rather than trusting ambient env.

## Governed SWE-task shape

`runSweTask` mounts the workspace, applies the SWE guardrail posture
(workspace reads/edits and test runs auto-allow — that is the job;
deploys require-approval; destroy/token/admin deny) and runs the prompt
turn through the shared governed session engine. The golden transcript
records a real fixture-repo run: read → EDIT → TEST RUN → report, every
tool call permission-gated. Denied capabilities surface as structured
`hobo.policy-refusal/v1:*` refusals the agent sees.

## Sandbox access report (s3-07)

`buildSandboxAccessReport` derives, from the same facts, whether any
GRANTED action escaped the workspace/test surface — the acceptance
expects `outOfScopeAccess: []` and the replay test asserts it. The
subprocess itself runs under the parse-enforced Executor posture through
the connector's stdio lane (env scrubbed + exactly one injected
brokered `ANTHROPIC_API_KEY`; typed `CLAUDE_CREDENTIALS_MISSING` gate).

## Event architecture

The adapter holds no state: every command's outcome lands as the
HOBO-721 past-tense facts appended by the caller's single-writer actor
to the event store, and BOTH reports are projections / materialized
views over those facts — snapshots re-derivable at any seq; read stores
rebuild from the log. The golden-transcript replay lane proves the
identical fact sequence deterministically, so PR CI needs no live key;
the live lane (`HOBO_CLAUDE_LIVE=1`) drives the real bridge.

## Credentials

Brokered only (HOBO-110): the Yard broker holds the Anthropic vendor
relationship and mints short-lived credentials per session — never an
ambient key, never a static secret in a Bindle, Camp or this package.
