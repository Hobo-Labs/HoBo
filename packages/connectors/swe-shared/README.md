# `@hobo/swe-shared`

Shared **SWE-task** session shape, sandbox access reports, and default
guardrails for vendor packages `@hobo/swe-claude`, `@hobo/swe-codex`,
`@hobo/swe-copilot`, `@hobo/swe-cursor`, `@hobo/swe-gemini`, `@hobo/swe-grok`.

Vendor packages keep **launch** (bridge binary + credential env) and
**golden transcripts** local; they re-export `runSweTask` with a fixed
`connector` id.

## Usage

```ts
import { runSweTask, sweTaskPolicy } from "@hobo/swe-shared";

await runSweTask({
  connector: "swe-claude",
  task: { taskId: "1", instruction: "fix tests", workspace: "/ws" },
  agent: myFactory,
  principal: { id: "agent" /* … */ },
});
```

## Architecture rules

Parse, don't validate: `parseAgentGuardrailPolicy` is the single parser
boundary; guardrail policy, task, and report values become derived types
(`SweTask`, `SweTaskReport`, `SandboxAccessReport`) that vendor adapters
consume without re-validating raw fields.

Event architecture: `runSweTask` treats each agent action as a command,
records session facts as events emitted by the governed-session actor, and
builds the SWE-task and sandbox reports as projections over those facts — a
materialized view of the session. Session state is checkpointed as snapshots
in the connector's read store so reports replay deterministically from the
event store rather than from live agent state.
