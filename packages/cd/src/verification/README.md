# `@hobo/cd/verification` — verification engine (WP9)

Deterministic, fail-closed verification of a Freight on one Camp (plan 0024
D9, invariants I5, I8, I12). A `VerificationSpec` runs over a window; the
engine records every sample it decides from, and the verdict is a pure
function of that record, so replay reproduces it exactly.

| File | Role |
|---|---|
| `spec.ts` | `parseVerificationSpec` / `parseVerificationSpecJson`: applies `CD_DEFAULTS`, checks the constraints in `data-models/verification.cue`, returns the `ParsedVerificationSpec` brand. |
| `stats.ts` | Two-sided Mann–Whitney U: exact distribution when the smaller cohort has < 8 samples and no ties, otherwise the normal approximation with tie and continuity correction. Golden vectors pinned against scipy. |
| `evaluate.ts` | `evaluateVerification`: the pure verdict for a spec, recorded evidence and an instant. `qualifies(verdict)` is true only for PASS. |
| `engine.ts` | `createVerificationEngine` (frozen `VerificationEngine` port). |
| `probes.ts` | HTTP probes through the injected `HttpTransport`. |
| `journal.ts` | Event bodies and the fold of `cd-verification-<id>`. |
| `replay.ts` | `replayVerification` / `replayVerificationFromStore`. |
| `reasons.ts` | Every reason code with its remediation. |
| `sources/` | Health sources (see `sources/README.md`). |

## Semantics

- **Checks.** Thresholds (aggregation MEAN/P50/P95/P99/MAX/SUM, nearest-rank
  percentiles, comparator LT/LTE/GT/GTE), canary-vs-baseline comparisons
  (fail only when significant *and* worse; sensitivity LOW/MEDIUM/HIGH =
  α 0.01/0.05/0.10), probes (status equals `expect_status`, success ratio ≥
  `min_success_ratio`), verify suites (`VerifyPort`), and an error-budget
  ceiling over queries whose unit is `burn_rate`.
- **Cohorts.** Thresholds read the canary when the rollout is cohort-aware,
  otherwise everything. Comparisons need a cohort-aware rollout; without one
  they FAIL with `verification-cohort-unavailable`.
- **No data → FAIL.** An empty window fails at window end. With
  `fail_on_no_data=false` it is INCONCLUSIVE — still never a PASS.
- **Deadline → INCONCLUSIVE.** A check with some but fewer than
  `required_observations` samples keeps the verification running until
  `progress_deadline_ms`, then completes INCONCLUSIVE with
  `verification-deadline-exceeded`. The rollout treats INCONCLUSIVE as FAIL.
- **Sources down.** A transient source failure is retried every tick until
  the deadline, then the check is no data. A permanent misconfiguration
  (unknown kind, bad endpoint, bad query, missing cohort label) fails at
  window end.
- **Refused spec.** `start` records it and completes FAIL at once with the
  parse reasons.

## Journal (`cd-verification-<id>`)

| Event | Body | When |
|---|---|---|
| `verification.Started` | identity, `cohortAware`, `startedAt`, the parsed spec | `start` |
| `rollout.EvidenceObserved` | `EvidenceObservationRecord`, one per sample | probes and suites as they happen; health-source samples together with the verdict |
| `verification.Completed` | `VerificationResultRecord` with per-check outcomes | completion |

Ids are `ver-` + 32 hex of a SHA-256 over tenant, Freight, Camp, cohort
awareness, the spec and the start instant. `start` is idempotent while a
verification for the same inputs is running. The engine's memory is a cache:
the first tick after a restart rediscovers every Started stream without a
Completed event. Concurrent ticks are serialized by the stream's expected-seq
CAS; the loser re-reads and resumes.

## Metrics (`TelemetrySink`, optional)

`hobo.cd.verification.started`, `hobo.cd.verification.completed`
(`hobo.verification.verdict`), `hobo.cd.verification.duration` (ms),
`hobo.cd.verification.source.failures` (`hobo.health_source.kind`,
`hobo.reason.code`), `hobo.cd.verification.probe.attempts`
(`hobo.probe.healthy`); all carry `hobo.camp.id` and `hobo.freight.id`. A
failing sink never fails a tick.

## Gates

TypeScript (`tsc`), protobuf (`cd.proto`, generated `cd_pb.ts`), CUE
(`data-models/verification.cue`, agreement test `test/verification/cue.test.ts`),
PACT (`test/verification/pacts/*.pact.json`, verified by
`test/verification/sources/pacts.test.ts`), golden journal corpus
(`test/verification/golden/`), replay tests.

## Runbook

**Symptom: every verification FAILs with `verification-no-data`.**
1. Read the Completed event: `reasons` names the check and, for a source
   problem, the `health-source-*` code.
2. Run the query by hand against the source for the window
   (`startedAt` … `startedAt + window_ms`). For a split cohort, confirm the
   series carries the declared `cohort_label` with values `canary` and
   `baseline`.
3. Fix the query or the instrumentation, then promote again. Never set
   `fail_on_no_data=false` to get past this: it only turns FAIL into
   INCONCLUSIVE, which also blocks.

**Symptom: verifications sit running until the deadline, then INCONCLUSIVE.**
1. `hobo.cd.verification.source.failures` rising → the source is down or
   refusing (`health-source-http-error`, `-transport-failed`,
   `-credential-unavailable`). Restore it; running verifications pick up the
   data on the next tick.
2. No failures → too few samples: lower the source step, widen `window_ms`,
   or lower `required_observations`.

**Symptom: a canary FAILs with `verification-canary-worse` and the operator
believes it is fine.** The test is two-sided at the declared sensitivity and
fails only in the worse direction; read `statistic` (U), `pValue` and the
sample counts on the check. Lower the sensitivity (HIGH → MEDIUM → LOW) only
with a recorded reason; never remove the comparison.

**Symptom: replay mismatch.** `replayVerificationFromStore(store, id)` returns
`matches: false` with the check names. The journal was edited or the verdict
function changed without a corpus refresh; treat it as an incident, compare
against `test/verification/golden/verification-journal.json`.

**After a crash.** Nothing to do: the next `tick` resumes every running
verification from its stream. A suite already recorded is not re-run.
