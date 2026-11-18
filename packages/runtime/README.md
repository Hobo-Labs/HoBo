# @hobo/runtime

The **SDK runtime-primitives package**: app-facing authoring surfaces and the
deterministic-replay library that backs them.

- **Trainable methods (ADR-0025 / ADR-0125)** — `training(fn, opts)`,
  signature-only `training.define()` empty implementations served by a
  contract-derived stub (`defineGrounding()` is the same function under the
  name the registrations call that `hobo stub` generates for an ambient
  `@trainable declare class`, in `src/_generated/declared/<Class>.ts`;
  ADR-0128), the optional `@trainable` class decorator and `@intent` method
  decorator (including projects using `exactOptionalPropertyTypes`),
  the `"use training"` grounding lint, and `applyTrainingArtifact()` for
  apply-at-load promotion. See `src/training/`. The JSON types this surface
  is typed in (`JsonValue`, `JsonObject`, `JsonBag`) are exported from the
  root too, so a generated module whose exports infer `Trainable<JsonValue,
  JsonValue>` compiles with `declaration: true`.
- **Deterministic replay** (`./replay` export) — the replay, divergence,
  and equivalence engine (ADR-0086).

## Actors and workflows

`defineActor` and `activateActor` use an injected `ActorHost` for state,
leases, and fencing. A stale or contended lease cannot append actor state.
Actor commands invoke handlers that append events through the host; `state()`
reads the host's materialized view. The host supplies the actor event store;
the actor API does not manage snapshots or a separate read store.

`createWorkflowEngine` journals completed steps and resumes a run with its
original seed and input. New journals also bind the definition name; older
journals did not record it. `start` generates a unique run ID; pass `{ runId }`
when the caller needs to retain the ID after an interruption. For compatibility,
`resume` also initializes an absent journal with the supplied ID. Only one worker
should resume a run at a time.

The default journal is in memory. Supply a durable `EventStoreWriter` to resume
after a process restart. A crash after an external effect and before its step is
recorded can cause that effect to run again, so external effects need their own
idempotency.

`agent` registers tool implementations as workflow steps. Actor, token, and
tool operations require their corresponding capabilities; unavailable or
undeclared capabilities raise `CapabilityDeniedError`.

Generated trainable modules carry a `// @generated` marker. Existing projects
should run `hobo codegen` before checking generated-file freshness after upgrading.

A function with a `"use training"` directive can set its `trainingIntent`
property before registration. An explicit `intent` passed to `training.infer`
takes precedence over that property.

`parseReplayReport` and `parseReplayDivergence` parse, don't validate: they
reject malformed input and return parsed domain types with validated sequence
vectors and digests.

## Naming: `runtime` vs `runtimes/`

These are different concerns that share a word:

- **`packages/runtime` (`@hobo/runtime`, this package)** — the *SDK
  primitives* layer app code imports (`import { training } from
  "@hobo/runtime"`); no I/O, no substrate.
- **`packages/runtimes/*` (e.g. `@hobo/runtime-local`)** — concrete *runtime
  backends* implementing the durable runtime ports (EventStore, Queue,
  Clock, component host) for a substrate. `runtime-local/src/replay.ts` is
  that backend's record/replay **link mode** (ADR-0076), not this package's
  replay engine.

The glossary's "Runtime" entry records the same disambiguation.

`WorkflowFailure` preserves an omitted step or cause as `undefined` rather than
manufacturing placeholder values.
