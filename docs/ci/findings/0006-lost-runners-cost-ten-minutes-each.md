---
type: CI Performance Finding
title: "Finding 6: lost runners cost ten minutes each"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 6: lost runners cost ten minutes each

Ten jobs in the sample ran 590–900 s, against medians of 14–118 s. Five of them stopped mid-step: in
`pnpm install`, the pnpm-store step, or checkout, with steps left without a conclusion and no log uploaded.
Their own `timeout-minutes` (5 to 45) did not fire. GitHub failed them after about ten minutes without
contact from the runner, so the container or runner process died under a live job. That matches the bug
#1637 fixed: the daemon force-stopped live job containers when `docker inspect` timed out under load. The
box was still running older code (see finding 4). Each lost runner holds a slot for ten minutes and fails
its run, which then needs a rerun.

It is not only #1637's bug. Lost runners continued after the restart on `96b9b70e`, which includes #1637:

- Dispatch run 41519610143, CI fabric contract guard (`hobo-a742da4d`): `pnpm install` started at 20:31:46
  and never finished. The job's 10-minute timeout could not be delivered, and GitHub cancelled it at 15
  minutes (timeout plus the 5-minute grace for an unresponsive runner). That one job is most of the run's
  1058 s wall time.
- #1640's run, CI fabric contract guard (`hobo-24695a3f`, 20:59–21:09): hung in `pnpm install` as well.

Both stopped in `pnpm install` against the host-mounted store, and in both the runner stopped talking to
GitHub rather than the step failing. A hung `pnpm` alone would still let the runner enforce the timeout and
upload logs, so the container, or every process in it, stopped. Box-side evidence is needed to tell a kill
from a stall: `docker events` and `docker inspect` (`State.OOMKilled`, exit code) for those two runner
names, the daemon log for their leases, the container cgroup's `memory.events` (a container stalled
reclaiming at its 6 GiB cap stops without being OOM-killed), and `dmesg` on the host. Whether the restart
itself happened during 20:31–20:46 also matters for the first case.

A daemon restart lost two more. The worker logged `hobo_ci_isolated_worker_drained` with `remaining: 0`
while both jobs were still running, exited, and both jobs were lost. The drain had three defects:

- It counted leases whose `accountId` equalled the worker's provider account id. A lease's `accountId` is
  the customer account that owns the job, so nothing ever matched and the drain finished at once. A lease
  belongs to the worker when its offer does: an isolated-container offer whose `providerAccountId` is the
  worker (`workerOfferKeys`, keyed by account and offer id because offer ids are unique per account only).
- Nothing reconciled during the drain. A lease leaves `running` only when a tick sees its runner exit, and
  the drain had stopped ticking. Each check now runs `runtime.tick({ admit: false })` first, which inspects
  leases but takes no inbox delivery and reserves or launches nothing.
- The signal handlers were `process.once`. A supervisor that signals the whole process group, with
  `hobo ci serve --with-worker` forwarding the same SIGTERM, delivers it twice, and the second one found no
  listener and killed the process. They are `process.on` now; shutdown was already idempotent.

The default `HOBO_CI_WORKER_DRAIN_TIMEOUT_MS` is now 30 minutes, since the drain waits for running jobs
rather than only for launches. The supervisor's stop timeout (systemd `TimeoutStopSec`, Kubernetes
`terminationGracePeriodSeconds`) has to be longer, or it kills the drain itself.
