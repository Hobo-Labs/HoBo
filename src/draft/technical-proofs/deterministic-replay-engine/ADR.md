# Deterministic Replay Engine — Architecture Evidence

Draft POC for HOBO-601. Carries architecture-guard evidence and states how replay/live equivalence is enforced before production promotion to `@hobo/runtime/replay`.

## Parse, don't validate

- `parseReplayReport` and `parseReplayDivergence` are the only untrusted-input boundaries for report-shaped records.
- CUE constraints in `architecture/replay_report.cue` bound digest format, mode enum, and divergence invariants.

## Event architecture

- **Command** — workflow/step/hook/timer execution requests recorded by runtime primitives.
- **Event** — `run.*` append-only facts (`run.Started`, `run.StepCompleted`, `run.HookResumed`, `run.SleepScheduled`, …).
- **Actor** — workflow run aggregate replays by folding the `run/{runId}` stream.
- **Event store** — `recordEffect` appends through an EventStore writer port; replay reads through the reader port only.
- **Materialized view** — fold state at a per-stream `seq` vector; `assertReplayEqualsLive` compares normalized live vs canonical replay slices.
- **Snapshot** — `ReplayReport.state_digest` is a deterministic digest over `stableStringify(state)`; not a cache authority.

## Determinism boundary

Ambient `Date.now` / `Math.random` in workflow bodies, folds, or upcasters fail the gate. Memoized `step()` results are replayed from `run.StepCompleted` events — nondeterminism inside a step is safe by construction (sdk-api Layer 4).

## PACT boundary

`architecture/pacts/replayer_eventstore.pact.json` records the replayer consumer ↔ EventStore provider read interactions (`readStream`, `readBySeq`).
