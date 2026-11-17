---
name: verify-workflow-replay
description: Verify durable workflow identity, sleep deadlines and replay, and terminal outcomes when changing the runtime or generated application adapter.
---

# Durable workflow identity and replay

**Properties:** A completed journaled step is reused on resume; a fresh run atomically claims its ID; a resume checks recorded input and workflow identity, uses the recorded seed, checks prior step and sleep commands in order, and returns a recorded terminal outcome without running the workflow or appending another terminal fact. Replay consumes recorded sleeps and completed steps and refuses unused records. A sleep does not continue before its recorded deadline, which is retained across an explicit resume. Within one execution, journal appends are serialized, effects require an acknowledged scheduling append, and a failed append blocks later appends. Sequence numbers do not exceed the safe-integer limit.

**Why:** Repeating effects or reusing results for different inputs can corrupt work.

**Review baseline:** `8690f7aef8df8daa75abf8b612bd56eccfc45ede`.

## Covered code

- `packages/runtime/src/workflow.ts` and `packages/runtime/src/replay/store.ts` implement the engine and its replay store contract.
- `packages/runtime/src/replay/replayer.ts` checks ordered sleep records, including index validation when an index is present.
- `packages/cli/src/codegen/runtime-artifacts.ts` starts a new generated workflow when its journal is empty and resumes an existing one. The generated-runtime integration test exercises a real SQLite journal across reopening.
- `packages/runtime/test/authoring/workflow-replay.property.test.ts` generates terminal outcomes and concurrent fresh-ID claims against the real engine.
- `packages/runtime/test/authoring/workflow-sleep.test.ts` checks waiting, recovery, legacy rebasing, invalid deadlines, timer limits, and a reopened SQLite journal.
- `packages/runtime/test/authoring/workflow-step-history.test.ts` checks command order, shortened histories, and interrupted same-step retries.
- `packages/runtime/test/authoring/workflow-concurrent-append.test.ts` exercises concurrent appends, uncertain outcomes, call-time payload snapshots, sequence exhaustion, and SQLite recovery.

## Run

From the repository root with workspace dependencies installed:

```sh
pnpm --filter @hobo/runtime pretest
bash scripts/verify-state-machine.sh .agents/skills/verify-workflow-replay
```

The command runs the real-code checks, generated properties, TLC 1.7.4 with the pinned checksum, and Z3 4.15.4. It uses `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` if set; otherwise it downloads the jar and installs the solver in temporary directories. Java 11+, Python, Node with the repo's `tsx`, `curl`, and `sha256sum` are required. Read the TLA+ result with `/statechart` and its view in `models/`.

## Scope and evidence

WorkflowReplay bounds one step to two calls and permits crashes before or after its completion fact (17 states). WorkflowRunIds explores two workers, two candidate IDs, preexisting legacy journals, retries, and an atomic empty-stream claim (278 states). WorkflowResume checks input, recorded workflow name, and recorded seed (280 states). WorkflowTerminal explores completed and failed terminal outcomes and repeated resumes (15 states); independent invariants require no subsequent body call, no duplicate terminal fact, and the recorded outcome to be returned.

WorkflowTimers explores all pairs of journal and replay histories up to two sleeps and two possible delays (120 states). It checks the matched prefix and requires an accepted history to match exactly. The Z3 obligations prove empty-prefix, next-record induction, accepted-history equality, and the next-record condition for equal histories over unbounded integer-indexed arrays. The abstraction does not prove that TypeScript refines the model or model optional record indices.

WorkflowSleepDeadline explores a clock bounded to 0..3, delays of one or two units, early wake-ups, crashes, explicit resumes, and completion (22 states). It checks no early completion and preservation of the original deadline. Z3 separately proves the reached-deadline and positive-remaining-time arithmetic for unbounded integers. The model abstracts a legacy rebase as the initial deadline assignment; it does not model journal corruption, a clock jumping forward, or automatic process recovery.

WorkflowCommands explores all pairs of histories up to two step or sleep commands (425 states). It requires the consumed history to match and prevents acceptance when recorded commands remain unused. Its view is `models/commands-view.mts`. The abstraction treats commands as an ordered flat sequence; it does not cover parent-child relationships or arbitrary effects outside those commands.

WorkflowAppend explores two concurrent requests and both pre-commit and lost-response failures (31 states). It checks one append at a time, no later writes after failure, and no effect without an acknowledged scheduling append. The model allows an effect authorized before a different append fails to continue; it does not model cross-process fencing, payload serialization, retries or automatic recovery. Its `/statechart` projection in `models/append-view.mts` has five displayed states and hides 25 same-state transitions. Z3 separately proves the next-sequence arithmetic for unbounded integers; the implementation's safe-integer guard supplies the finite bound.

The generated implementation properties use seeds 614448 and 614449 and 150 examples each. They check successful and failed terminal resumes and races between fresh runs claiming the same ID. Seeds 614456 and 614457 exercise 150 valid timer histories and 100 damaged histories with missing, changed, or unused records; a separate test checks unindexed legacy records and inconsistent indices. Seed 614458 checks 150 delay and crash-duration combinations; separate tests cover an early wake, old-record rebasing, malformed and overflowing deadlines, the Node timer limit, a real clock, and closing and reopening a SQLite journal. Seed 614459 generates 100 shortened step histories; further tests check omitted and changed commands, failure paths, and an interrupted retry of the same step. Seed 614460 generates 100 parallel append-delay histories. Separate checks inject a committed or uncommitted append error, resume from each case, verify snapshot isolation and sequence limits, and reopen a SQLite journal. The generated-app SQLite integration test covers starting and resuming through the generated adapter, including no extra terminal journal entry.

The store must implement atomic expected-sequence compare-and-set. An append error may have committed and recovery must reread the journal; the queue cannot cancel already authorized external effects. Journal sequences stop at `Number.MAX_SAFE_INTEGER` and require migration to continue. Legacy journals without a workflow name cannot establish workflow identity; legacy journals without a seed use the current engine seed, and old failed events without a step cannot recover that step. Concurrent resumes are not fenced. An external effect can repeat after a crash between the effect and its completion fact; this is not an exactly-once guarantee. Sleep safety assumes an accurate clock and durable journal, and progress requires a waiter that returns and an explicit host resume after a stop. This engine does not discover or wake stopped runs. An unfinished legacy sleep is rebased for its full delay once; already completed legacy runs cannot be repaired retroactively. The journal lacks parent provenance for commands inside a memoized step, so those histories may be rejected conservatively on replay or resume. These checks do not police arbitrary workflow effects outside recorded commands.

In scratch variants, disabling completed-step lookup or terminal replay causes real-code checks to fail. Removing the unconsumed-sleep check, returning from a sleep early, resetting its deadline on resume, omitting the command check, removing append serialization or failure poisoning, or allowing an exhausted sequence makes the respective implementation tests fail. Model mutations weakening fresh-ID or resume checks, allowing a post-terminal body call, appending on terminal resume, returning the wrong outcome, comparing every sleep against the first, accepting unused records, waking early, changing a deadline, accepting changed or incomplete command histories, permitting overlapping appends, writing after failure, or executing an unacknowledged effect violate their corresponding invariants. `TIMER_PROOF_MUTATION=first`, `omit-deadline-check`, and `WORKFLOW_APPEND_PROOF_MUTATION=allow-exhausted` make their respective Z3 obligations fail. TLC checks these finite abstractions, not all possible implementations, storage providers, or production integrations.

## Keep in sync

Inspect changes to the covered files since the review baseline, including uncommitted changes. When behavior changes, update the model and real-code checks, replay counterexamples against the code, rerun the checks and deliberately broken variants, and advance the baseline only after confirming correspondence. Use `/maintain-formal-verification-skill` for that update.
