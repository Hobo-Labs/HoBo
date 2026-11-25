---
type: Runbook
title: "HoBo.CD runbook: Verification"
description: "Verification verdicts and health sources. Assembled from the Runbook section of packages/cd/src/verification/README.md."
tags: [hobo, cd, runbook, verification]
---

# HoBo.CD runbook: Verification

Verification verdicts and health sources. This page is assembled from the **Runbook** section of `packages/cd/src/verification/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

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
