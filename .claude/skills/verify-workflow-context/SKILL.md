---
name: verify-workflow-context
description: Verify recorded resume context and captured workflow definition bindings.
---

# Workflow resume context and definition capture

**Property:** A version-three workflow cannot resume or reuse a terminal outcome without its recorded input, name and seed; malformed present names or seeds are refused for older records. Start, resume and replay adapters use the definition bindings captured before waiting.

**Why:** Missing or changed context can make work run, or a stored result appear valid, under a different workflow or deterministic seed.

**Review baseline:** `ec2b83f6271c8666531b91d68edd452c96578edd`.

## Covered code and checks

- `packages/runtime/src/workflow.ts` validates resume context before execution or terminal reuse and captures workflow names, callbacks, tools and capabilities before asynchronous journal work. `workflow-boundary.ts` checks primitive names and seeds. `replay/replayer.ts` validates replay seeds and invokes captured callbacks without reading their mutable `call` properties.
- `packages/runtime/test/authoring/workflow-context-validation.test.ts` checks missing version-three fields with and without a terminal outcome, malformed legacy fields, old missing-field fallback, invalid new names and seeds, definition and tool changes while storage waits, replay adapter capture and changed callback `call` properties. Seed 614617 generates 50 invalid context and terminal combinations.
- The broader [workflow replay skill](../verify-workflow-replay/SKILL.md) checks journal recovery, input snapshots, commands, timers and local execution fencing.

From the repository root with dependencies installed, run:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-workflow-context
```

The runner checks the pinned TLC 1.7.4 jar and uses Z3 4.15.4. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing installations for offline runs. Java 11+, Python, Node and the repository dependencies are required. This separate command checks twenty deliberately broken scratch implementations with the full skill, then reruns the restored code:

```sh
python3 .agents/skills/verify-workflow-context/mutations/full.py
```

## Model and evidence

`WorkflowResumeContext` explores 58 states and 58 steps for an old or version-three record, one missing or malformed context field, and either execution or terminal reuse. It requires each resulting outcome to have valid modeled context; its five-state projection has four arrows and hides 24 same-label steps. Read each TLC result with `/statechart`; the maintained views supply the projections.

```mermaid
stateDiagram-v2
  s0: Resume requested
  s1: Invalid context refused
  s2: Recorded context verified
  s3: Workflow resumed
  s4: Recorded outcome returned
  [*] --> s0
  s0 --> s1: check the recorded context
  s0 --> s2: check the recorded context
  s2 --> s3: resume or return the recorded outcome
  s2 --> s4: resume or return the recorded outcome
```

`WorkflowDefinitionSnapshot` explores 75 states and 90 steps for start, resume or replay, one definition binding and a caller edit. It requires the selected binding to match the captured one; its three-state projection has two arrows and hides 45 same-label steps, including caller edits.

```mermaid
stateDiagram-v2
  s0: Workflow requested
  s1: Definition captured
  s2: Captured definition used
  [*] --> s0
  s0 --> s1: capture workflow definition
  s1 --> s2: use captured definition
```

A version-three journal missing its seed previously reached workflow execution or terminal reuse; real tests reproduce both paths. A definition changed during a delayed append or journal read previously changed what ran. Eight weakened TLC configurations and four weakened Z3 assumptions produce counterexamples. Z3 proves abstract context-check and captured-selection implications, not the TypeScript implementation.

The models bound each run to one defective context field or one changed binding and assume faithful equality, capture and journal observations. They do not establish TypeScript refinement, workflow code identity, callback purity, authentication, cross-process fencing, exactly-once external effects or liveness. A callback still receives its original definition as `this` and can read mutable application state. Older records with absent fields use legacy fallback; malformed recorded fields are refused and may need reconciliation.

## Keep in sync

Inspect changes to covered code and tests since the baseline, including uncommitted changes. Replay counterexamples against real code, rerun verification and mutations, and advance the baseline only after the model and implementation agree. Use `/maintain-formal-verification-skill` for that review.
