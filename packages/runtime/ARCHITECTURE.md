# @hobo/runtime — Architecture Evidence

Production runtime package. S1-12 (HOBO-601) promotes the deterministic replay
engine and `replay == live` invariant harness from the HOBO-60 spike into
`src/replay/`, exported as `@hobo/runtime/replay`.

S1-14 adds the **durable authoring surface** (sdk-api.md §Layer 4) — the
developer-facing primitives that lower onto `hobo:runtime@0.1.0`:

- **actors / grains** (`src/actor.ts`) — `defineActor` / `activateActor` over an
  injected ActorHost lease + fence token; state folded from the actor's own
  event stream; single-writer (contended activation denied, superseded writer's
  append rejected on a stale fence). Emits `actor.Activated` / `.StateAppended` /
  `.Passivated`.
- **workflow / step** (`src/workflow.ts`, `src/step.ts`) — `defineWorkflow` /
  `workflow()` with journaled steps (`ctx.step` records `run.StepCompleted`), so a
  workflow **survives a host restart**: `engine.resume` replays the journal,
  short-circuits completed steps, and continues from the tip. The `run.*` journal
  is replay-equivalent under the existing `./replay` engine
  (`engine.toReplayDefinition` feeds `replayRun`).
- **agent** (`src/agent.ts`) — `agent()` is a workflow whose tool calls are
  journaled steps (replayable) and whose ctx is capability-scoped.
- **ctx** (`src/ctx.ts`) — the deny-by-default effect/capability membrane:
  `step` / `sleep` (deterministic Clock) / `emit` are always granted; `actor` /
  `token` / `tool` require a declared capability or throw `CapabilityDeniedError`.

The runtime runs on injected ports (`src/ports.ts`); the durable adapter
`@hobo/runtime-local` (ActorHost / EventStore / Clock) is **test-only**, so `src`
depends inward on `@hobo/core` plus the `@hobo/wit` generated bindings
(type-only, `src/wit.ts`).

## Schema and constraints

- Protobuf records live in [`data-models/replay/`](./data-models/replay) and
  [`data-models/authoring.proto`](./data-models/authoring.proto).
- CUE constraints bound `ReplayReport`, `ReplayDivergence`, and `SeqVectorEntry`,
  plus the authoring records `WorkflowRunJournalRecord`, `ActorActivationRecord`,
  `AgentToolCallRecord`, and `CapabilityGrantRecord`
  ([`data-models/authoring.cue`](./data-models/authoring.cue)).
- PACT consumer evidence for the replayer → EventStore read boundary and the
  authoring-surface → journal boundary lives under [`contracts/`](./contracts)
  (`authoring_surface.pact.json` + `contracts/consumer/`).

## Parse, don't validate

`parseReplayReport` and `parseReplayDivergence` in `src/replay/parse.ts` are the
single parse-don't-validate boundaries: untrusted report-shaped input becomes
derived parsed domain types before any replay logic runs. Internal replay
functions accept only those refined types. The authoring surface follows the
same discipline: `defineWorkflow` / `defineActor` / `agent` refine loose author
input into frozen definition records at the boundary, and the ctx capability set
is parsed into a `ReadonlySet<Capability>` (deny-by-default) once, so effect
methods operate only on the refined grant — never re-checking raw strings.

## Event architecture

- **Command** — workflow/step/hook/timer execution requests recorded by runtime primitives.
- **Event** — `run.*` events append to the event store before deterministic code observes effect results.
- **Actor** — workflow run actor replays by folding the stream into materialized state.
- **Event store** — append-only `run.*` stream is the source of truth (S1-05 port).
- **Materialized view** — replayed workflow state is a deterministic fold over the stream.
- **Snapshot** — `ReplayReport.state_digest` is a canonical digest over folded state.
- **Read store** — `testRuntime().state()` queries the in-memory read model for local tests.

For the S1-14 authoring surface the same CQRS shape holds: a **command** is a
`ctx.step` / actor message; **events** are the `run.*` and `actor.*` families; the
**actor** grain and the workflow run are the write-model boundaries; the
append-only stream is the **event store**; folded workflow/actor state is the
**materialized view**; and `engine.journal()` / `actor.state()` are the **read
store**. Capability denials are a typed `CapabilityDeniedError`, and exhausted
steps a typed `WorkflowFailure` — never log-and-continue.

Divergence is a typed `ReplayDivergenceError`, never log-and-continue.
