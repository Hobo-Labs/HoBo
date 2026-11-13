# CI agent schema ownership

`agent.proto` owns every record the agent persists or exchanges:
`AgentConfig` (the authored `agent` block), `QueueSnapshot` and `QueueEntry`,
`PairVerdict`, `QueuePlan`, `Resolution`, and the journal's `AgentEvent`.
`buf.yaml` opts into repository codegen; runtime code imports
`src/_generated/agent_pb.ts`.

`agent.cue` constrains them, with `#Agent` as the union schema-tools vets
fixtures against. Beyond field ranges it holds the cross-field rules:

- A credential is a reference (`env:NAME`, `github-secret:NAME`), never a value.
- `baseUrl` belongs to `openai-compatible` engines only, and must be `https`.
- A `harness` engine names a known adapter and carries no credential.
- `apply` mode cannot enable `rollup`.
- A resolution has a commit only when its outcome is `resolved`, and only a
  commit can have a published ref; any other outcome carries a reason code.
- A repair (`repairs` set) is a later attempt (`attempt` of at least 1).
- A `ResolutionChecked` event carries the resolution and its checks' result.
- A resolution records each region it resolved (`regions`: the SHA-256 of
  the region's three sides and the text used), which a later merge of the
  same conflict reuses once the checks have passed on it; a file the
  structured merge settled is marked `structured`.
- `resolution.structuredMerge` is a boolean switch; the command is not
  configurable from a repository.
- A commit signing key is a reference, never key text.
- A `PlanProposed` event carries a plan; a settled or published one carries
  a resolution; an `EntryEnqueued` or `EntryEjected` one names its entry and
  the commit.

`fixtures/valid` and `fixtures/invalid` exercise those rules.
`test/config.test.ts` runs every `config-*` fixture through `parseAgentConfig`
as well, so the CUE schema and the runtime parser accept and reject the same
documents.

`parseAgentConfig` applies defaults and the always-protected paths and
returns a frozen `ParsedAgentConfig`. `observeQueue` checks a snapshot's
identifiers and ordering and returns an `ObservedQueue`. Code past those two
functions takes only the parsed types.
