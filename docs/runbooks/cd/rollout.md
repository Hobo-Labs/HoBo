---
type: Runbook
title: "HoBo.CD runbook: Rollout"
description: "Capability lowering, ramps and traffic. Assembled from the Runbook section of packages/cd/src/rollout/README.md."
tags: [hobo, cd, runbook, rollout]
---

# HoBo.CD runbook: Rollout

Capability lowering, ramps and traffic. This page is assembled from the **Runbook** section of `packages/cd/src/rollout/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

**A rollout is stuck in `running`.** Read the ledger
(`cd-rollout-<id>`). The last event names the step:
`ShiftRequested` without `Shifted` means the cutover call is in flight or
died — the next tick observes the plan's status, it never re-shifts.
`Shifted` without `TrafficObserved` means the provider acknowledged but the
split is not observed (`rollout-traffic-unconverged` at the deadline): check
the Station routing state for the plan id. `VerificationStarted` without
`StageVerified` means the verification engine has no verdict yet; after twice
the progress deadline the rollout fails closed.

**`awaiting-window`.** A change window is closed for a target Camp. The
rollout resumes on the first tick after it opens. To proceed early, record a
governed override (`window.override`, ≤ 4 h). A rollback held by
`rollout-rollback-window-closed` means a freeze forbids rollback: override it
if the rollback must run now.

**`awaiting-approval`.** The plan carries the `rollout.stage-approval`
obligation; approve the request named in the reason's subject through the
approval port. Denied or expired approvals roll back.

**`progressive-unsupported`.** No declared traffic offering realizes the
strategy on a Camp. Add a traffic profile for the provider, or promote with
`ROLLOUT_STRATEGY_ALL_AT_ONCE` explicitly. Re-planning with new offerings gets
a new rollout id.

**`failed` with `rollback-non-convergeable`.** Zero exposure was not observed
before the deadline (needs-human). Restore routing at the Station to the
stable backend, confirm `TrafficRoutingPort.status`, then close the incident;
the ledger is terminal and no further work is emitted.

**`rolled-back` with `rollback-delta-opened`.** The rollback Delta named in
the reason subject is open; the promotion gate decides it and the reconciler
applies the predecessor Set. `rollback-no-predecessor` names Camps with no
previous Set: tear them down with intent `down` if needed.

**Capacity refusals.** `canary-capacity-unavailable` comes from the hosting
budget authority; `canary-capacity-unconfigured` means the gate attached a
`hosting-budget` obligation but no capacity port is composed (WP18).
