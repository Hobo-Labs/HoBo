---
type: CI Performance Finding
title: "Finding 86: poll readmit jit churn"
description: "Coalesce without fleet custody dedupe re-ingested jobs another hobo runner already held, repeating isolated reservations."
tags: [hobo, ci, worker, polling, fleet]
---

# Finding 86: poll readmit jit churn

## Evidence

After the Finding 85 coalesce fix, box workers repeated JIT registration for the same queued job every ~15–20 s (#1814 job `130022163439`: 27 pickups; #1792/#1816 Fabric runs starved). GitHub had already bound another fleet runner on the shared `hobo` label (`hobo-runner-*` on Hostinger ARC, another box's `hobo-<uuid>`, or mesh peers).

## Cause

1. Poll `deliveryId` included a hash of **this worker's own** `hobo-<lease-uuid>` runner name once GitHub reflected JIT registration, so each poll looked like a **new** webhook and re-queued demand.
2. Duplicate **requeue** ignored **dispatching/claiming** reservations and custody held by **any other** `hobo` runner, so poll coalesce still re-ingested after every `requeued` result.

## Fleet context: shared `hobo` is intentional

HoBo CI is a **fleet mesh**: many nodes carry the `hobo` label (box workers, Hostinger ARC, future mesh members). GitHub assigns each queued job to **one** online runner among them. That cooperation is a product feature, not a misconfiguration.

The defect was **this worker fighting the mesh**—treating “another fleet member took the job” as local unmet demand and re-admitting in a loop—not the shared label itself.

## Why JIT runners exit in seconds without work

Isolated JIT containers run `./run.sh || true`. Two fleet-mesh cases look the same in `hobo_ci_job_pickup` but differ on GitHub job JSON:

1. **Peer wins after registration** — job later shows a foreign `runner_name` (yield / withdraw paths).
2. **Empty exit while job still unassigned** — `getJob` returns `queued` with **no** `runner_name`, so pre-JIT foreign yield does not run. The JIT runner still exits (mesh race, label mismatch such as `hobo-box` vs `hobo`-only JIT labels, or GitHub not yet binding). `hobo_ci_launch_yielded_foreign_runner` stays at zero in this case.

Registration can succeed while GitHub never delivers the job to **this** runner. **Before custody fixes**, settle treated “job still `queued`” as **unmet demand** and `queueInside` re-admitted it; Finding 85 coalesce re-poll amplified that into ~35s pickup loops (`hobo_ci_job_pickup`).

Box evidence (2026-11-10): repeated pickups ~39s apart with zero `hobo_ci_launch_yielded_foreign_runner` → case (2). Runner `_diag` may show `Job request … processed succeed` while GitHub REST still reports `queued` — the mesh assigned work elsewhere or the session ended before REST bound `runner_name`. Labels matching (`jitLabels` = `jobLabels`) ruled out label skew on trunk jobs.

Second box trial: `emptyExitCount` rose but `hobo_ci_jit_empty_exit_backoff` never logged — `createCompositeIsolatedHost` did not forward `isLaunchParked`, and empty exits still called `queueInside`, re-admitting demand before backoff could bite.

Third box trial (`33958657c`): backoff honored, but a 21s double pickup could land between settle finishing and the second `recordJitEmptyExit` — fix records backoff at the exit marker before stop/settle. When GitHub run jobs show the JIT runner served a **sibling** job (`hobo_ci_jit_runner_served_other_job`), skip penalizing the reserved job’s backoff (shared-label mesh queue stole the session).

## Fix (fleet cooperation)

Each worker must treat a job taken by **any other** `hobo` runner as normal fleet behavior:

- **Classify custody** (`box` = this host's JIT `hobo-<uuid>`; `foreign` = any other fleet runner name GitHub reports).
- **Yield before JIT**: `getJob` before `generate-jitconfig`; if custody is `foreign` or the job is `in_progress` on a peer, cancel this host's lease (`hobo_ci_launch_yielded_foreign_runner`)—do not register another JIT.
- **Withdraw, don't requeue**: `yieldForeignRunnerCustody` and `settleStopped` call `withdrawQueuedJob` instead of `queueInside` when GitHub names a peer runner; **release the slot** (cancel isolated leases covering the job).
- **Dedupe admission**: skip `queue`/`reserve` when an active lease on this worker already covers the job, or when GitHub names **this** box JIT runner.
- **Poll coalesce**: delivery ids hash **peer** runner names only (this box's JIT and unassigned share one id); treat `requeued` and `foreign-runner` as quiet coalesce results.
- **JIT labels**: register every fleet label the job asks for (`hobo`, `hobo-trunk`, `hobo-box`) via `jitRunnerRegistrationLabels`.
- **Empty-exit evidence**: capture `run.sh` exit code and a tail of `_diag/Runner_*.log` (`hobo_ci_jit_empty_exit`).
- **Per-job admission backoff**: after each empty exit, exponential launch delay (`hobo_ci_jit_empty_exit_backoff`) via `isLaunchParked`.

Coalesce-only deploys without this bundle **increase** churn (box telemetry 2026-11-10: 8→10 pickups / 3.9 min, jobs `130022163396` / `130017909867` repeating ~35s).
