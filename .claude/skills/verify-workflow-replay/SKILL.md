---
name: verify-workflow-replay
description: Verify durable workflow run identity, replay, and terminal outcomes when changing the runtime or generated application adapter.
---

# Durable workflow identity and replay

**Properties:** A completed journaled step is reused on resume; a fresh run atomically claims its ID; a resume checks recorded input and workflow identity, uses the recorded seed, and returns a recorded terminal outcome without running the workflow or appending another terminal fact.

**Why:** Repeating effects or reusing results for different inputs can corrupt work.

**Review baseline:** `7fb4bbd0e7f933881f7a530b87c6dbd698898b1b`.

## Covered code

- `packages/runtime/src/workflow.ts` and `packages/runtime/src/replay/store.ts` implement the engine and its replay store contract.
- `packages/cli/src/codegen/runtime-artifacts.ts` starts a new generated workflow when its journal is empty and resumes an existing one. The generated-runtime integration test exercises a real SQLite journal across reopening.
- `packages/runtime/test/authoring/workflow-replay.property.test.ts` generates terminal outcomes and concurrent fresh-ID claims against the real engine.

## Run

From the repository root with workspace dependencies installed:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-workflow-replay
```

The command runs the real-code checks, generated properties, and TLC 1.7.4 with the pinned checksum. It uses `TLA2TOOLS` if set; otherwise it downloads the jar into a temporary directory. Java 11+, Node with the repo's `tsx`, `curl`, and `sha256sum` are required. Read the TLA+ result with `/statechart` and its view in `models/`.

## Scope and evidence

WorkflowReplay bounds one step to two calls and permits crashes before or after its completion fact (17 states). WorkflowRunIds explores two workers, two candidate IDs, preexisting legacy journals, retries, and an atomic empty-stream claim (278 states). WorkflowResume checks input, recorded workflow name, and recorded seed (280 states). WorkflowTerminal explores completed and failed terminal outcomes and repeated resumes (15 states); independent invariants require no subsequent body call, no duplicate terminal fact, and the recorded outcome to be returned.

The generated implementation properties use seeds 614448 and 614449 and 150 examples each. They check successful and failed terminal resumes and races between fresh runs claiming the same ID. The generated-app SQLite integration test covers starting and resuming through the generated adapter, including no extra terminal journal entry.

The store must implement atomic expected-sequence compare-and-set. Legacy journals without a workflow name cannot establish workflow identity; legacy journals without a seed use the current engine seed, and old failed events without a step cannot recover that step. Concurrent resumes are not fenced. An external effect can repeat after a crash between the effect and its completion fact; this is not an exactly-once guarantee.

In scratch variants, disabling completed-step lookup or terminal replay causes real-code checks to fail. Model mutations weakening fresh-ID or resume checks, allowing a post-terminal body call, appending on terminal resume, or returning the wrong outcome violate their corresponding invariants. TLC checks these finite abstractions, not all possible implementations, storage providers, or production integrations.

## Keep in sync

Inspect changes to the covered files since the review baseline, including uncommitted changes. When behavior changes, update the model and real-code checks, replay counterexamples against the code, rerun the checks and deliberately broken variants, and advance the baseline only after confirming correspondence. Use `/maintain-formal-verification-skill` for that update.
