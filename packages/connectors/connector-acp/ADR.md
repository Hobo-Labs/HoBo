# @hobo/connector-acp — Architecture Evidence

The production ACP protocol connector (HOBO-721): the SWE-agent enablement
layer every M4 vendor adapter plugs into. HoBo owns NO agent SDK by design
(sdk-contracts.md §Protocol connectors, package-namespaces.md) — external
agent runtimes integrate through `connector(name, { protocol: "acp" })`,
and this package owns exactly what HoBo owns: connection, identity, policy,
sandboxing and audit around the protocol calls. The agent runtime owns
planning and tool orchestration.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): the SVID-bound
  agent principal, the session-opened/policy-decided/refusal audit records,
  the lowered connector manifest entry and the sandbox posture.
- CUE constraints in `data-models/connector_acp.cue` bound every protobuf
  message (`svid` pinned to `spiffe://`, `protocol` to `acp`, `via` to
  `xaa`, `onBehalfOf` to `user`, `ambientCredentials` to `false`, refusals
  to the `hobo.policy-refusal/v1:` prefix).
- PACT boundary evidence lives under [`contracts/`](./contracts): the
  lowering shape, the governed prompt-turn fact sequence, the fail-closed
  refusal and the NEGATIVE vector (no public `agent()`) — asserted against
  the recorded interactions in the conformance tests.

## Parse, don't validate

Three parse boundaries produce frozen derived parsed types or throw:
`parseAgentGuardrailPolicy` (missing action classes default to
require-approval, never allow), `parseSandboxPosture`
(`ambientCredentials` must be exactly `false`; open egress rejected) and
`buildConnectorTokenRequest` (subject must be an SVID-bound agent principal
delegated by a user; requested scopes can only narrow the manifest allow).
Callers receive derived types instead of re-checking raw fields.

## Policy: deny-ceiling, fail closed

Every agent tool-permission request is classified (s3-07 action classes:
read/write/deploy/destroy/token/admin — unknown verbs classify as `write`,
toward the stricter class) and decided BEFORE any grant reaches the agent.
`require-approval` without a recorded approval from an allowed approver
resolves to deny; a denial selects the agent's reject option so the refusal
is structured and VISIBLE to the agent; an agent that offers no reject
option gets the cancelled outcome. Nothing fails open.

## Identity

The agent principal is a brokered connector token bound to an SVID and
always delegated by a human user (ai-native-agent-auth.md) — never an
ambient credential. The token-exchange request builder enforces the
delegation shape and scope-narrowing at construction time.

## Sandbox

Vendor agent subprocesses spawn under the parse-enforced Executor sandbox
posture: environment scrubbed to the allowlist (no inherited cloud
credentials), workspace-scoped filesystem, allowlisted network. The stdio
lane (`connectAcpAgentOverStdio`) speaks REAL ACP over
`@agentclientprotocol/sdk` (ClientSideConnection + ndJsonStream) with lazy
import and typed gates (`ACP_SDK_MISSING`, `ACP_AGENT_SPAWN_FAILED`); the
in-process fixture agent proves conformance without any vendor SDK.

## Event architecture

The connector holds no state of its own: every prompt turn is a command
whose outcomes land as past-tense facts — `connector.SessionOpened`,
`agent.PromptSubmitted`, `agent.ToolPermissionRequested`,
`policy.Decided`, `agent.ToolCallRefused`, `agent.SessionUpdated`,
`agent.TurnCompleted`, `connector.SessionClosed` — appended by the
caller's single-writer actor to the event store. `replaySessionFacts`
rebuilds the session state purely from the log (the audit acceptance): the
replayed view is a materialized view / projection with no process memory,
re-derivable as a snapshot at any seq, and read stores rebuild from the
log at any time.

## No public agent SDK

The only public entry points are `acpConnector(...)` (declaration +
lowering) and the governed session engine. No `agent()` collection or
factory is exported — the conformance suite includes the negative vector
asserting it.
